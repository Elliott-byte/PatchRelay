import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
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
  createComment,
  deleteComment,
  getCodexSession,
  getDiffResponse,
  getSessionById,
  listAllSessions,
  listBranches,
  listComments,
  loadConfig,
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
    const { message, model, sessionId } = await readJson<{ message?: string; model?: string; sessionId?: string }>(req);
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
    }, ac.signal);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'done', success: result.success, error: result.error, stderr: result.stderr })}\n\n`);
      res.end();
    }
    return;
  }

  if (method === 'POST' && pathName === '/api/repo/pick') {
    let stdout = '';
    try {
      if (process.platform === 'win32') {
        // PowerShell folder picker
        const psScript = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
          '$d.Description = "Select a git repository folder"',
          'if ($d.ShowDialog() -eq "OK") { $d.SelectedPath } else { exit 1 }',
        ].join('; ');
        ({ stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', psScript]));
      } else {
        const script = 'POSIX path of (choose folder with prompt "Select a git repository folder:")';
        ({ stdout } = await execFileAsync('osascript', ['-e', script]));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // osascript: user cancel = exit code -128; PowerShell: exit 1 when cancelled
      if (msg.includes('-128') || /cancel/i.test(msg) || /exit code 1/i.test(msg)) {
        sendJson(res, 200, { cancelled: true });
      } else {
        sendJson(res, 500, { error: msg });
      }
      return;
    }
    const chosen = stdout.trim().replace(/[\\/]$/, '');
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
    if (!abs.startsWith(repoRoot)) { sendJson(res, 403, { error: 'Forbidden' }); return; }
    try {
      const content = await readFile(abs, 'utf8');
      sendJson(res, 200, { content, path: rel });
    } catch {
      sendJson(res, 404, { error: 'Not found' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
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

  // Discover from ~/.claude/projects/ (or %APPDATA%\Claude\projects on Windows)
  // Dirs are encoded repo paths: leading / removed, remaining / replaced with -
  const claudeBase = process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude')
    : path.join(os.homedir(), '.claude');
  const claudeProjects = path.join(claudeBase, 'projects');
  try {
    const entries = await readdir(claudeProjects);
    for (const entry of entries) {
      const repoPath = '/' + entry.replace(/^-/, '').replace(/-/g, '/');
      try {
        await stat(repoPath);
        addRepo(repoPath);
      } catch { /* path doesn't exist */ }
    }
  } catch { /* no claude projects dir */ }

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

async function runAgent(repoRoot: string, kind: AgentKind, customMessage?: string, model?: string, sessionId?: string, onChunk?: (text: string) => void, signal?: AbortSignal) {
  const config = await loadConfig(repoRoot);
  const [diff, comments] = await Promise.all([
    getDiffResponse(repoRoot, config),
    listComments(repoRoot)
  ]);
  const { systemPrompt, userMessage } = buildAgentInput(diff, comments, customMessage);

  let command = kind === 'codex' ? config.codexCommand : config.claudeCommand;

  if (kind === 'claude') {
    if (sessionId?.startsWith('claude:')) {
      // Resume: don't add --model or --system-prompt, they conflict with resume
      command = `${command} --resume ${sessionId.slice(7)}`;
    } else {
      if (model) command = `${command} --model ${model}`;
      command = `${command} --system-prompt ${JSON.stringify(systemPrompt)}`;
    }
    console.error('[PatchRelay] claude command:', command);
    return runAgentCommand(command, userMessage, repoRoot, onChunk, signal);
  } else {
    if (model) command = `${command} --model ${model}`;
    const fullPrompt = [systemPrompt, '', userMessage].filter(Boolean).join('\n');
    return runAgentCommand(command, fullPrompt, repoRoot, onChunk, signal);
  }
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
