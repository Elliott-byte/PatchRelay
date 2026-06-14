import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CodexSessionMessage, CodexSessionResponse } from './types.js';

export interface SessionListItem {
  id: string;
  source: 'codex' | 'claude';
  title?: string;
  updatedAt?: string;
  messageCount: number;
}

export interface SessionsListResponse {
  sessions: SessionListItem[];
}

const maxMsgLen = 6000;

// ── Public API ────────────────────────────────────────────────────────────────

export async function listAllSessions(repoRoot: string): Promise<SessionsListResponse> {
  const [codexSessions, claudeSessions] = await Promise.all([
    listCodexSessions(repoRoot),
    listClaudeSessions(repoRoot)
  ]);
  return { sessions: [...claudeSessions, ...codexSessions] };
}

export async function getSessionById(id: string, repoRoot: string): Promise<CodexSessionResponse> {
  const [source, ...rest] = id.split(':');
  const rawId = rest.join(':');

  if (source === 'claude') {
    return getClaudeSession(rawId, repoRoot);
  }
  return getCodexSessionById(rawId, repoRoot);
}

// ── Codex ─────────────────────────────────────────────────────────────────────

async function listCodexSessions(repoRoot: string): Promise<SessionListItem[]> {
  const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
  const files = await collectJsonlFiles(sessionsRoot);

  const settled = await Promise.allSettled(
    files.map(async (file): Promise<SessionListItem | null> => {
      // Read only the first line to check ownership — avoid parsing the whole file
      const firstLine = await readFirstLine(file);
      if (!firstLine) return null;
      const meta = JSON.parse(firstLine) as { type?: string; timestamp?: string; payload?: { id?: string; cwd?: string } };
      if (meta.type !== 'session_meta' || meta.payload?.cwd !== repoRoot) return null;

      const threadId = meta.payload?.id ?? path.basename(file, '.jsonl');
      // Use file mtime for updatedAt (fast) and count real conversation lines for messageCount
      const [fileStat, { messageCount, updatedAt }] = await Promise.all([
        stat(file),
        countCodexMessages(file),
      ]);

      return {
        id: `codex:${threadId}`,
        source: 'codex',
        title: `Codex — ${threadId.slice(0, 8)}…`,
        updatedAt: updatedAt ?? fileStat.mtime.toISOString(),
        messageCount,
      };
    })
  );

  return settled
    .filter((r): r is PromiseFulfilledResult<SessionListItem> => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value)
    .sort(byNewest);
}

async function getCodexSessionById(threadId: string, repoRoot: string): Promise<CodexSessionResponse> {
  const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
  const files = await collectJsonlFiles(sessionsRoot);
  // Match by uuid anywhere in the path (handles nested date dirs)
  const file = files.find((f) => f.includes(threadId));

  if (!file) {
    return { messages: [], unavailableReason: `Codex session ${threadId} not found.` };
  }

  const raw = await readFile(file, 'utf8');
  const messages = parseCodexMessages(raw);
  return {
    threadId,
    title: `Codex — ${threadId.slice(0, 8)}…`,
    updatedAt: messages[messages.length - 1]?.timestamp,
    messages
  };
}

function parseCodexMessages(raw: string): CodexSessionMessage[] {
  const messages: CodexSessionMessage[] = [];

  raw.split(/\r?\n/).forEach((line, idx) => {
    if (!line.trim()) return;
    try {
      const obj = JSON.parse(line) as {
        timestamp?: string;
        type?: string;
        payload?: {
          type?: string;
          role?: string;
          content?: Array<Record<string, unknown>>;
        };
      };
      const payload = obj.payload;
      if (obj.type !== 'response_item' || payload?.type !== 'message') return;
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') return;

      const rawText = extractContentText(payload.content ?? []);
      if (!rawText) return;

      const text = role === 'user' ? cleanCodexUserMessage(rawText) : stripAnsi(rawText);
      if (!text || isSystemNoise(text)) return;

      messages.push({
        id: `codex-${idx}-${obj.timestamp ?? 'unknown'}`,
        role: role as 'user' | 'assistant',
        text: trimText(text),
        timestamp: obj.timestamp ?? new Date(0).toISOString()
      });
    } catch {
      // ignore
    }
  });

  return messages;
}

function extractContentText(content: Array<Record<string, unknown>>): string {
  return content
    .map((item) => {
      const t = item.text ?? item.transcript ?? item.content;
      return typeof t === 'string' ? t : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function cleanCodexUserMessage(text: string): string {
  // Extract the part after "## My request for Codex:"
  const match = text.match(/##\s*My request for Codex:\s*\n([\s\S]+)$/i);
  if (match) return match[1].trim();
  // Strip "# Files mentioned by the user:" prefix noise
  if (text.startsWith('# Files mentioned by the user:')) {
    const afterFiles = text.replace(/^# Files mentioned by the user:[\s\S]*?\n\n/, '').trim();
    return afterFiles || text;
  }
  return text;
}

// ── Claude Code ───────────────────────────────────────────────────────────────

function claudeProjectDir(repoRoot: string): string {
  return path.join(os.homedir(), '.claude', 'projects', repoRoot.replace(/\//g, '-'));
}

async function listClaudeSessions(repoRoot: string): Promise<SessionListItem[]> {
  const dir = claudeProjectDir(repoRoot);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const jsonlEntries = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'));

  const settled = await Promise.allSettled(
    jsonlEntries.map(async (entry): Promise<SessionListItem> => {
      const sessionId = entry.name.replace('.jsonl', '');
      const filePath = path.join(dir, entry.name);
      const [raw, fileStat] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)]);
      const session = parseClaudeSession(raw, sessionId);
      return {
        id: `claude:${sessionId}`,
        source: 'claude',
        title: session.threadName ?? `Claude — ${sessionId.slice(0, 8)}…`,
        updatedAt: session.updatedAt ?? fileStat.mtime.toISOString(),
        messageCount: session.messages.length,
      };
    })
  );

  return settled
    .filter((r): r is PromiseFulfilledResult<SessionListItem> => r.status === 'fulfilled')
    .map((r) => r.value)
    .sort(byNewest);
}

async function getClaudeSession(sessionId: string, repoRoot: string): Promise<CodexSessionResponse> {
  const filePath = path.join(claudeProjectDir(repoRoot), `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return { messages: [], unavailableReason: `Claude session ${sessionId} not found.` };
  }
  return parseClaudeSession(raw, sessionId);
}

function parseClaudeSession(raw: string, sessionId: string): CodexSessionResponse {
  const messages: CodexSessionMessage[] = [];
  let title: string | undefined;
  let updatedAt: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;

      // Session title
      if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
        title = obj.aiTitle;
        continue;
      }

      // User message
      if (obj.type === 'user') {
        const msg = obj.message as Record<string, unknown> | undefined;
        if (msg?.role !== 'user') continue;
        const text = extractClaudeContent(msg.content);
        if (!text || isSystemNoise(text)) continue;
        messages.push({
          id: String(obj.uuid ?? `claude-${sessionId}-${messages.length}`),
          role: 'user',
          text: trimText(text),
          timestamp: String(obj.timestamp ?? new Date(0).toISOString())
        });
        continue;
      }

      // Assistant message (no outer type, just .message.role === 'assistant')
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg?.role === 'assistant') {
        const text = extractClaudeContent(msg.content, true);
        if (!text) continue;
        const ts = String(obj.timestamp ?? new Date(0).toISOString());
        updatedAt = ts;
        messages.push({
          id: String(obj.uuid ?? `claude-${sessionId}-${messages.length}`),
          role: 'assistant',
          text: trimText(text),
          timestamp: ts
        });
      }
    } catch {
      // ignore
    }
  }

  return {
    threadId: sessionId,
    threadName: title,
    updatedAt,
    messages
  };
}

function extractClaudeContent(
  content: unknown,
  skipThinking = false
): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return (content as Array<Record<string, unknown>>)
    .filter((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return true;
      if (!skipThinking && block.type === 'thinking') return false;
      return false;
    })
    .map((block) => String(block.text ?? ''))
    .join('\n')
    .trim();
}

// ── Shared utils ──────────────────────────────────────────────────────────────

/** Read only the first non-empty line of a file without loading the whole thing. */
async function readFirstLine(file: string): Promise<string | null> {
  const { createReadStream } = await import('node:fs');
  return new Promise((resolve) => {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 4096 });
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk as string;
      const nl = buf.indexOf('\n');
      const line = nl >= 0 ? buf.slice(0, nl) : buf;
      stream.destroy();
      resolve(line.trim() || null);
    });
    stream.on('error', () => resolve(null));
    stream.on('close', () => resolve(buf.trim() || null));
  });
}

/**
 * Count real conversation messages in a Codex JSONL without full parsing.
 * Also grabs the timestamp of the last response_item for updatedAt.
 */
async function countCodexMessages(file: string): Promise<{ messageCount: number; updatedAt?: string }> {
  const raw = await readFile(file, 'utf8');
  let messageCount = 0;
  let updatedAt: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { type?: string; timestamp?: string; payload?: { type?: string; role?: string; content?: unknown[] } };
      if (obj.type !== 'response_item' || obj.payload?.type !== 'message') continue;
      const role = obj.payload?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const rawText = extractContentText((obj.payload?.content ?? []) as Array<Record<string, unknown>>);
      if (!rawText || isSystemNoise(rawText)) continue;
      const cleaned = role === 'user' ? cleanCodexUserMessage(rawText) : stripAnsi(rawText);
      if (!cleaned) continue;
      messageCount++;
      if (obj.timestamp) updatedAt = obj.timestamp;
    } catch { /* skip */ }
  }

  return { messageCount, updatedAt };
}

function isSystemNoise(text: string): boolean {
  const t = text.trimStart();
  // XML system injections
  if (
    t.startsWith('<environment_context>') ||
    t.startsWith('<permissions instructions>') ||
    t.startsWith('<collaboration_mode>') ||
    t.startsWith('<app-context>') ||
    t.startsWith('<tool_response>') ||
    t.startsWith('[tool_use_result]') ||
    t.startsWith('# In app browser:')
  ) return true;

  // Codex approval/authorization JSON blobs
  if (t.startsWith('{') && (t.includes('"risk_level"') || t.includes('"user_authorization"'))) return true;

  // Codex tool application records (apply_patch, bash, etc.)
  if (/^\[?\d*\]?\s*tool\s+\w+\s+(call|result):/i.test(t)) return true;
  if (t.startsWith('*** Begin Patch') || t.startsWith('*** End Patch')) return true;

  // Codex "agent history" approval context blobs
  if (t.startsWith('The following is the Codex agent history added since')) return true;

  // Files-mentioned prefix (Codex context injection)
  if (t.startsWith('# Files mentioned by the user:') && !t.includes('\n## My request for Codex:')) return true;

  return false;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function trimText(text: string): string {
  const cleaned = stripAnsi(text);
  return cleaned.length > maxMsgLen ? `${cleaned.slice(0, maxMsgLen)}\n…` : cleaned;
}

function byNewest(a: SessionListItem, b: SessionListItem): number {
  return Date.parse(b.updatedAt ?? '0') - Date.parse(a.updatedAt ?? '0');
}

async function collectJsonlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  await walkDir(dir, files);
  return files.sort((a, b) => b.localeCompare(a)); // descending = newest-named first
}

async function walkDir(dir: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await walkDir(full, out); continue; }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
}
