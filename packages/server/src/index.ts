import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import {
  buildReviewPrompt,
  checkoutBranch,
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

  return http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        sendJson(res, 400, { error: 'Missing request URL.' });
        return;
      }

      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        await handleApiRequest(req, res, url, options.repoRoot);
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
  repoRoot: string
): Promise<void> {
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
    const models = provider === 'codex'
      ? [
          { id: 'o4-mini',  label: 'o4-mini' },
          { id: 'gpt-4.1',  label: 'GPT-4.1' },
          { id: 'gpt-4o',   label: 'GPT-4o' },
        ]
      : [
          { id: 'claude-sonnet-4-6',           label: 'Sonnet 4.6' },
          { id: 'claude-opus-4-8',             label: 'Opus 4.8' },
          { id: 'claude-haiku-4-5-20251001',   label: 'Haiku 4.5' },
        ];
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
    const { message } = await readJson<{ message?: string }>(req);
    const prompt = await buildPrompt(repoRoot, message);
    sendJson(res, 200, { prompt });
    return;
  }

  if (method === 'POST' && (pathName === '/api/agent/codex' || pathName === '/api/agent/claude')) {
    const kind: AgentKind = pathName.endsWith('/codex') ? 'codex' : 'claude';
    const { message, model } = await readJson<{ message?: string; model?: string }>(req);
    const result = await runAgent(repoRoot, kind, message, model);
    sendJson(res, result.success ? 200 : 500, result);
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
}

async function buildPrompt(repoRoot: string, customMessage?: string): Promise<string> {
  const config = await loadConfig(repoRoot);
  const [diff, comments] = await Promise.all([
    getDiffResponse(repoRoot, config),
    listComments(repoRoot)
  ]);
  return buildReviewPrompt(diff, comments, customMessage);
}

async function runAgent(repoRoot: string, kind: AgentKind, customMessage?: string, model?: string) {
  const config = await loadConfig(repoRoot);
  const prompt = await buildPrompt(repoRoot, customMessage);
  let command = kind === 'codex' ? config.codexCommand : config.claudeCommand;
  if (model) command = `${command} --model ${model}`;
  return runAgentCommand(command, prompt, repoRoot);
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
