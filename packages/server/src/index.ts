import { execFile } from 'node:child_process';
import { createReadStream, readFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import {
  buildAgentInput,
  checkoutBranch,
  findGitRoot,
  createBranch,
  deleteBranch,
  commitChanges,
  claudeProjectsRoots,
  createComment,
  deleteComment,
  fetchRemote,
  getCodexSession,
  getCommitDiff,
  getCommitLog,
  getDiffResponse,
  getSessionById,
  getSyncStatus,
  listAllSessions,
  listBranches,
  listComments,
  loadConfig,
  pullChanges,
  pushChanges,
  runAgentCommand,
  saveConfig,
  stageFiles,
  unstageFiles,
  updateComment,
  type AgentKind,
  type CreateCommentInput,
  type PatchRelayConfig,
  type UpdateCommentInput
} from '@patchrelay/core';

export interface PatchRelayServerOptions {
  repoRoot: string;
  port?: number;
  staticDir?: string;
}

export interface RunningPatchRelayServer {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startPatchRelayServer(
  options: PatchRelayServerOptions
): Promise<RunningPatchRelayServer> {
  const server = createPatchRelayServer(options);
  const port = await listen(server, options.port ?? 0);
  const url = `http://127.0.0.1:${port}`;

  return {
    server,
    port,
    url,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

export function createPatchRelayServer(options: PatchRelayServerOptions): Server {
  const staticRoot = options.staticDir ? path.resolve(options.staticDir) : undefined;
  // mutable so the repo can be switched at runtime without restarting
  const state = { repoRoot: options.repoRoot };

  return http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        sendJson(res, 400, { error: 'Missing request URL.' });
        return;
      }

      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        await handleApiRequest(req, res, url, state);
        return;
      }

      await serveStatic(req, res, url, staticRoot);
    } catch (error) {
      sendError(res, error);
    }
  });
}

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  state: { repoRoot: string }
): Promise<void> {
  const repoRoot = state.repoRoot;
  const method = req.method ?? 'GET';
  const pathName = url.pathname;

  if (method === 'GET' && pathName === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && pathName === '/api/config') {
    sendJson(res, 200, await loadConfig(repoRoot));
    return;
  }

  if (method === 'PUT' && pathName === '/api/config') {
    const input = await readJson<Partial<PatchRelayConfig>>(req);
    const current = await loadConfig(repoRoot);
    const next = { ...current, ...input };
    await saveConfig(repoRoot, next);
    sendJson(res, 200, next);
    return;
  }

  if (method === 'GET' && pathName === '/api/diff') {
    const config = await loadConfig(repoRoot);
    sendJson(res, 200, await getDiffResponse(repoRoot, config));
    return;
  }

  if (method === 'GET' && pathName === '/api/comments') {
    sendJson(res, 200, await listComments(repoRoot));
    return;
  }

  if (method === 'GET' && pathName === '/api/codex/session') {
    const limit = Number(url.searchParams.get('limit') ?? '120');
    sendJson(res, 200, await getCodexSession(repoRoot, undefined, limit));
    return;
  }

  if (method === 'GET' && pathName === '/api/models') {
    const provider = url.searchParams.get('provider') ?? 'claude';
    let models: { id: string; label: string }[];
    if (provider === 'codex') {
      models = await loadCodexModels();
    } else {
      models = [
        { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6' },
        { id: 'claude-opus-4-8',           label: 'Opus 4.8' },
        { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
      ];
    }
    sendJson(res, 200, { models });
    return;
  }

  if (method === 'GET' && pathName === '/api/sessions') {
    sendJson(res, 200, await listAllSessions(repoRoot));
    return;
  }

  const sessionMatch = pathName.match(/^\/api\/sessions\/(.+)$/);
  if (sessionMatch && method === 'GET') {
    const id = decodeURIComponent(sessionMatch[1]);
    sendJson(res, 200, await getSessionById(id, repoRoot));
    return;
  }

  if (method === 'POST' && pathName === '/api/comments') {
    const input = await readJson<CreateCommentInput>(req);
    sendJson(res, 201, await createComment(repoRoot, input));
    return;
  }

  const commentMatch = pathName.match(/^\/api\/comments\/([^/]+)$/);
  if (commentMatch && method === 'PUT') {
    const input = await readJson<UpdateCommentInput>(req);
    sendJson(res, 200, await updateComment(repoRoot, decodeURIComponent(commentMatch[1]), input));
    return;
  }

  if (commentMatch && method === 'DELETE') {
    await deleteComment(repoRoot, decodeURIComponent(commentMatch[1]));
    sendJson(res, 200, { ok: true });
    return;
  }

  const statusMatch = pathName.match(/^\/api\/comments\/([^/]+)\/(resolve|reopen)$/);
  if (statusMatch && method === 'POST') {
    const status = statusMatch[2] === 'resolve' ? 'resolved' : 'open';
    sendJson(
      res,
      200,
      await updateComment(repoRoot, decodeURIComponent(statusMatch[1]), { status })
    );
    return;
  }

  if (method === 'GET' && pathName === '/api/git/branches') {
    sendJson(res, 200, await listBranches(repoRoot));
    return;
  }

  if (method === 'POST' && pathName === '/api/git/checkout') {
    const { branch } = await readJson<{ branch: string }>(req);
    await checkoutBranch(repoRoot, branch);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && pathName === '/api/git/branch') {
    const { name } = await readJson<{ name: string }>(req);
    await createBranch(repoRoot, name);
    sendJson(res, 200, { ok: true });
    return;
  }

  const branchMatch = pathName.match(/^\/api\/git\/branch\/(.+)$/);
  if (branchMatch && method === 'DELETE') {
    await deleteBranch(repoRoot, decodeURIComponent(branchMatch[1]));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && pathName === '/api/git/stage') {
    const { files = [] } = await readJson<{ files?: string[] }>(req);
    await stageFiles(repoRoot, files);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && pathName === '/api/git/unstage') {
    const { files = [] } = await readJson<{ files?: string[] }>(req);
    await unstageFiles(repoRoot, files);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && pathName === '/api/git/commit') {
    const { message } = await readJson<{ message: string }>(req);
    const result = await commitChanges(repoRoot, message);
    sendJson(res, 200, result);
    return;
  }

  if (method === 'GET' && pathName === '/api/git/sync-status') {
    sendJson(res, 200, await getSyncStatus(repoRoot));
    return;
  }

  if (method === 'GET' && pathName === '/api/git/log') {
    const limit = Number(url.searchParams.get('limit') ?? '60');
    sendJson(res, 200, { commits: await getCommitLog(repoRoot, limit) });
    return;
  }

  if (method === 'GET' && pathName === '/api/git/commit') {
    const hash = (url.searchParams.get('hash') ?? '').trim();
    if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) { sendJson(res, 400, { error: 'Invalid commit hash' }); return; }
    sendJson(res, 200, await getCommitDiff(repoRoot, hash));
    return;
  }

  if (method === 'POST' && (pathName === '/api/git/push' || pathName === '/api/git/pull' || pathName === '/api/git/fetch')) {
    try {
      const op = pathName === '/api/git/push' ? pushChanges : pathName === '/api/git/pull' ? pullChanges : fetchRemote;
      const result = await op(repoRoot);
      sendJson(res, 200, result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // git writes failures to stderr; surface a readable line
      sendJson(res, 400, { error: msg.split('\n').slice(-6).join('\n').trim() || 'Git operation failed.' });
    }
    return;
  }

  // Generate a commit message from the staged diff via the configured agent.
  if (method === 'POST' && pathName === '/api/git/commit-message') {
    try {
      const message = await generateCommitMessage(repoRoot);
      sendJson(res, 200, { message });
    } catch (e: unknown) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  if (method === 'POST' && pathName === '/api/prompt/build') {
    const config = await loadConfig(repoRoot);
    const { message } = await readJson<{ message?: string }>(req);
    const [diff, comments] = await Promise.all([getDiffResponse(repoRoot, config), listComments(repoRoot)]);
    const { systemPrompt, userMessage } = buildAgentInput(diff, comments, message);
    sendJson(res, 200, { prompt: [systemPrompt, '', userMessage].join('\n') });
    return;
  }

  if (method === 'POST' && (pathName === '/api/agent/codex' || pathName === '/api/agent/claude')) {
    const kind: AgentKind = pathName.endsWith('/codex') ? 'codex' : 'claude';
    const { message, model, sessionId, effort } = await readJson<{ message?: string; model?: string; sessionId?: string; effort?: string }>(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    (res.socket as import('node:net').Socket | null)?.setNoDelay(true);
    const ac = new AbortController();
    req.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const result = await runAgent(repoRoot, kind, message, model, sessionId, (chunk) => {
      res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
    }, ac.signal, effort);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'done', success: result.success, error: result.error, stderr: result.stderr })}\n\n`);
      res.end();
    }
    return;
  }

  if (method === 'POST' && pathName === '/api/repo/pick') {
    const picked = await openFolderDialog();
    if (picked.cancelled) { sendJson(res, 200, { cancelled: true }); return; }
    if (picked.unsupported) { sendJson(res, 400, { error: picked.error ?? 'No folder picker available. Paste the repo path in the switcher instead.' }); return; }
    if (picked.error) { sendJson(res, 500, { error: picked.error }); return; }
    const chosen = (picked.path ?? '').trim().replace(/[\\/]$/, '');
    try {
      const gitRoot = await findGitRoot(chosen);
      state.repoRoot = gitRoot;
      sendJson(res, 200, { repoRoot: gitRoot, name: path.basename(gitRoot) });
    } catch {
      sendJson(res, 400, { error: `Not a git repository: ${chosen}` });
    }
    return;
  }

  if (method === 'GET' && pathName === '/api/repos') {
    sendJson(res, 200, { repos: await listKnownRepos(repoRoot) });
    return;
  }

  if (method === 'POST' && pathName === '/api/repo/switch') {
    const { path: newPath } = await readJson<{ path: string }>(req);
    const resolved = path.resolve(newPath);
    // Validate it's a real git repo
    try {
      const gitRoot = await findGitRoot(resolved);
      state.repoRoot = gitRoot;
      sendJson(res, 200, { repoRoot: gitRoot });
    } catch {
      sendJson(res, 400, { error: `Not a git repository: ${resolved}` });
    }
    return;
  }

  if (method === 'GET' && pathName === '/api/repo/tree') {
    try {
      const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot });
      const files = stdout.split('\n').filter(Boolean);
      sendJson(res, 200, { files });
    } catch {
      sendJson(res, 500, { error: 'git ls-files failed' });
    }
    return;
  }

  if (method === 'GET' && pathName === '/api/repo/file') {
    const rel = url.searchParams.get('path') ?? '';
    const abs = path.resolve(repoRoot, rel);
    if (!isInsideRepo(repoRoot, abs)) { sendJson(res, 403, { error: 'Forbidden' }); return; }
    try {
      const content = await readFile(abs, 'utf8');
      sendJson(res, 200, { content, path: rel });
    } catch {
      sendJson(res, 404, { error: 'Not found' });
    }
    return;
  }

  // Raw file bytes (images, binaries) with correct content-type — for previewing.
  if (method === 'GET' && pathName === '/api/repo/raw') {
    const rel = url.searchParams.get('path') ?? '';
    const abs = path.resolve(repoRoot, rel);
    if (!isInsideRepo(repoRoot, abs)) { sendJson(res, 403, { error: 'Forbidden' }); return; }
    try {
      const fileStat = await stat(abs);
      if (!fileStat.isFile()) { sendJson(res, 404, { error: 'Not found' }); return; }
      streamFile(res, abs);
    } catch {
      sendJson(res, 404, { error: 'Not found' });
    }
    return;
  }

  // Lightweight "go to definition": grep tracked files for a symbol's definition.
  if (method === 'GET' && pathName === '/api/repo/definition') {
    const name = (url.searchParams.get('name') ?? '').trim();
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) { sendJson(res, 400, { error: 'Invalid symbol' }); return; }
    sendJson(res, 200, { name, matches: await findDefinitions(repoRoot, name) });
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
}

interface DefinitionMatch { path: string; line: number; text: string }

/** Grep tracked files for likely definition sites of `name`, strongest patterns first. */
async function findDefinitions(repoRoot: string, name: string): Promise<DefinitionMatch[]> {
  const B = '[^A-Za-z0-9_$]'; // word boundary char class for ERE
  const kw = '(function|class|interface|type|enum|struct|trait|def|func|fn|impl|module|namespace)';
  // Strong: a definition keyword immediately before the name, or name assigned a function/value.
  const strong = [
    `(^|${B})${kw}[ \\t*&]+${name}(${B}|$)`,
    `(^|${B})(const|let|var)[ \\t]+${name}[ \\t]*[=:]`,
    `(^|${B})${name}[ \\t]*[:=][ \\t]*(function|async|\\()`,
  ].join('|');
  // Weak fallback: name followed by a parameter list and a block/arrow (method/function form).
  const weak = `(^|${B})${name}[ \\t]*\\([^)]*\\)[ \\t]*(\\{|=>|:)`;

  const run = async (pattern: string): Promise<DefinitionMatch[]> => {
    try {
      const { stdout } = await execFileAsync(
        'git', ['grep', '-nE', '-I', '--', pattern],
        { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 }
      );
      return stdout.split('\n').filter(Boolean).map((l) => {
        const m = l.match(/^(.+?):(\d+):(.*)$/);
        return m ? { path: m[1], line: Number(m[2]), text: m[3].trim() } : null;
      }).filter((x): x is DefinitionMatch => x !== null);
    } catch {
      return []; // git grep exits 1 when there are no matches
    }
  };

  const hits = await run(strong);
  return hits.length ? hits : run(weak);
}

async function listKnownRepos(currentRoot: string): Promise<{ path: string; name: string; current: boolean }[]> {
  const seen = new Set<string>();
  const repos: { path: string; name: string; current: boolean }[] = [];

  const addRepo = (p: string) => {
    const resolved = path.resolve(p);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    repos.push({ path: resolved, name: path.basename(resolved), current: resolved === currentRoot });
  };

  // Always include current repo
  addRepo(currentRoot);

  // Discover from Claude project dirs (encoded repo paths: separators -> '-').
  // Decoding is lossy/Unix-oriented; we stat each candidate and keep what exists,
  // so Windows-encoded names that don't resolve are simply skipped.
  for (const claudeProjects of claudeProjectsRoots()) {
    try {
      const entries = await readdir(claudeProjects);
      for (const entry of entries) {
        const repoPath = '/' + entry.replace(/^-/, '').replace(/-/g, '/');
        try {
          await stat(repoPath);
          addRepo(repoPath);
        } catch { /* path doesn't exist on this platform */ }
      }
    } catch { /* no claude projects dir here */ }
  }

  // Discover from ~/.codex/sessions/ — subdirs named after repo paths
  const codexSessions = path.join(os.homedir(), '.codex', 'sessions');
  try {
    const entries = await readdir(codexSessions);
    for (const entry of entries) {
      const full = path.join(codexSessions, entry);
      const st = await stat(full).catch(() => null);
      if (st?.isDirectory()) {
        // codex session dirs may contain a "workdir" file
        try {
          const workdir = (await readFile(path.join(full, 'workdir'), 'utf8')).trim();
          if (workdir) addRepo(workdir);
        } catch { /* no workdir file */ }
      }
    }
  } catch { /* no codex sessions dir */ }

  return repos;
}

async function loadCodexModels(): Promise<{ id: string; label: string }[]> {
  const cachePath = path.join(os.homedir(), '.codex', 'models_cache.json');
  try {
    const raw = await readFile(cachePath, 'utf8');
    const cache = JSON.parse(raw) as {
      models: { slug: string; display_name: string; visibility?: string }[];
    };
    const visible = cache.models
      .filter((m) => m.visibility === 'list')
      .map((m) => ({ id: m.slug, label: m.display_name }));
    return [{ id: '', label: 'Default' }, ...visible];
  } catch {
    return [{ id: '', label: 'Default' }];
  }
}

/** Ask the configured agent for a one-line commit message describing the staged diff. */
async function generateCommitMessage(repoRoot: string): Promise<string> {
  const { stdout: staged } = await execFileAsync('git', ['diff', '--cached'], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!staged.trim()) throw new Error('No staged changes to summarize. Stage files first.');

  const config = await loadConfig(repoRoot);
  // Use plain (non-streaming) output for a quick one-shot answer.
  const command = config.claudeCommand
    .replace(/--output-format\s+stream-json/, '')
    .replace(/--verbose/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const prompt = [
    'Write a single Conventional Commits message for the following staged git diff.',
    'Rules: one line, lowercase type prefix (feat/fix/refactor/docs/chore/etc.),',
    'subject under 72 characters, imperative mood. Output ONLY the message — no quotes,',
    'no code fences, no explanation.',
    '',
    staged.slice(0, 12000),
  ].join('\n');

  const result = await runAgentCommand(command, prompt, repoRoot);
  if (!result.success && !result.stdout.trim()) {
    throw new Error(result.error || 'Agent did not return a commit message.');
  }
  // Take the first meaningful line and strip stray quotes/fences/backticks.
  const line = result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('```')) ?? '';
  return line.replace(/^["'`]+|["'`]+$/g, '').trim();
}

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

async function runAgent(repoRoot: string, kind: AgentKind, customMessage?: string, model?: string, sessionId?: string, onChunk?: (text: string) => void, signal?: AbortSignal, effort?: string) {
  const config = await loadConfig(repoRoot);
  const [diff, comments] = await Promise.all([
    getDiffResponse(repoRoot, config),
    listComments(repoRoot)
  ]);
  const { systemPrompt, userMessage } = buildAgentInput(diff, comments, customMessage);

  let command = kind === 'codex' ? config.codexCommand : config.claudeCommand;

  if (kind === 'claude') {
    if (sessionId?.startsWith('claude:')) {
      command = `${command} --resume ${sessionId.slice(7)}`;
    } else {
      if (model) command = `${command} --model ${model}`;
      command = `${command} --system-prompt ${JSON.stringify(systemPrompt)}`;
    }
    // Reasoning effort (low|medium|high|xhigh|max) — applies to new and resumed turns.
    if (effort && EFFORT_LEVELS.has(effort)) command = `${command} --effort ${effort}`;
    console.error('[PatchRelay] claude command:', command);
    const chunkHandler = command.includes('--output-format stream-json')
      ? makeStreamJsonChunkHandler(onChunk)
      : onChunk;
    return runAgentCommand(command, userMessage, repoRoot, chunkHandler, signal);
  } else {
    if (model) command = `${command} --model ${model}`;
    const fullPrompt = [systemPrompt, '', userMessage].filter(Boolean).join('\n');
    return runAgentCommand(command, fullPrompt, repoRoot, onChunk, signal);
  }
}

/**
 * Wraps onChunk to parse JSONL events from `claude --output-format stream-json`.
 * Extracts text and tool-use names in real time rather than passing raw JSON.
 */
function makeStreamJsonChunkHandler(onChunk?: (text: string) => void): (raw: string) => void {
  let lineBuf = '';
  return (raw: string) => {
    lineBuf += raw;
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() ?? '';
    for (const line of lines) {
      const text = extractStreamJsonText(line.trim());
      if (text) onChunk?.(text);
    }
  };
}

function extractStreamJsonText(line: string): string | null {
  if (!line) return null;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type !== 'assistant') return null;
    const msg = obj.message as { content?: unknown[] } | undefined;
    if (!Array.isArray(msg?.content)) return null;
    const parts: string[] = [];
    for (const block of msg.content) {
      if (typeof block !== 'object' || !block) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        const cmd = (b.input as Record<string, unknown> | undefined)?.command;
        const detail = typeof cmd === 'string' ? ` \`${cmd.split('\n')[0].slice(0, 80)}\`` : '';
        parts.push(`\n> [${b.name}]${detail}\n`);
      }
    }
    return parts.length ? parts.join('') : null;
  } catch { return null; }
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  staticRoot: string | undefined
): Promise<void> {
  if (!staticRoot) {
    sendJson(res, 404, { error: 'Static web assets are not configured.' });
    return;
  }

  const decodedPath = decodeURIComponent(url.pathname);
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.slice(1);
  const filePath = safeJoin(staticRoot, relativePath);
  const indexPath = path.join(staticRoot, 'index.html');

  if (!filePath) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) {
      streamFile(res, filePath);
      return;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await stat(indexPath);
    streamFile(res, indexPath);
  } catch {
    sendJson(res, 404, {
      error: 'Web UI is not built. Run npm install and npm run build first.'
    });
  }
}

function streamFile(res: ServerResponse, filePath: string): void {
  res.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Cache-Control': 'no-store'
  });
  createReadStream(filePath).pipe(res);
}

function safeJoin(root: string, relativePath: string): string | undefined {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    return undefined;
  }
  return resolvedPath;
}

/**
 * Whether `abs` is the repo root or contained within it. Uses path.relative so it
 * is correct across separators (and case-insensitive drives on Windows), unlike a
 * raw startsWith which mishandles `\` and `/repo` vs `/repo-evil`.
 */
function isInsideRepo(repoRoot: string, abs: string): boolean {
  const rel = path.relative(path.resolve(repoRoot), abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isWSL(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

interface FolderPickResult { path?: string; cancelled?: boolean; unsupported?: boolean; error?: string }

const WIN_FOLDER_PS = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = "Select a git repository folder"',
  'if ($d.ShowDialog() -eq "OK") { $d.SelectedPath } else { exit 1 }',
].join('; ');

/** Native folder picker per platform: macOS (osascript), Windows (PowerShell),
 *  Linux (zenity), WSL (Windows PowerShell via interop, path mapped with wslpath). */
async function openFolderDialog(): Promise<FolderPickResult> {
  const isCancel = (e: unknown) => {
    const code = (e as { code?: unknown }).code;
    const msg = e instanceof Error ? e.message : String(e);
    return msg.includes('-128') || /\bcancel/i.test(msg) || code === 1 || code === '1' || /exit code 1\b/.test(msg);
  };
  const isMissing = (e: unknown) => (e as { code?: unknown }).code === 'ENOENT';

  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select a git repository folder:")']);
      return { path: stdout };
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', WIN_FOLDER_PS]);
      return { path: stdout };
    }
  } catch (e) {
    if (isCancel(e)) return { cancelled: true };
    if (isMissing(e)) return { unsupported: true, error: 'Folder picker not available; paste the repo path instead.' };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  // Linux / WSL — try zenity first.
  try {
    const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', '--title=Select a git repository folder']);
    return { path: stdout };
  } catch (e) {
    if (isCancel(e)) return { cancelled: true };
    if (!isMissing(e)) return { error: e instanceof Error ? e.message : String(e) };
    // zenity missing — on WSL, fall back to the Windows picker via interop.
    if (isWSL()) {
      try {
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', WIN_FOLDER_PS]);
        const winPath = stdout.trim();
        if (!winPath) return { cancelled: true };
        try {
          const { stdout: unixPath } = await execFileAsync('wslpath', ['-u', winPath]);
          return { path: unixPath };
        } catch {
          return { path: winPath };
        }
      } catch (e2) {
        if (isCancel(e2)) return { cancelled: true };
        /* fall through to unsupported */
      }
    }
    return { unsupported: true, error: 'No folder picker found. Install zenity, or paste the repo path in the switcher.' };
  }
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath);
  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
        return;
      }
      reject(new Error('Unable to determine server port.'));
    });
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(`${JSON.stringify(data, null, 2)}\n`);
}

function sendError(res: ServerResponse, error: unknown): void {
  const status = error instanceof Error && error.name === 'CommentNotFoundError' ? 404 : 500;
  sendJson(res, status, {
    error: error instanceof Error ? error.message : 'Unexpected server error.'
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
