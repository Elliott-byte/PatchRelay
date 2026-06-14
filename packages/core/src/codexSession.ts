import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CodexSessionMessage, CodexSessionResponse, CodexSessionRole } from './types.js';

interface RawSessionLine {
  timestamp?: string;
  type?: string;
  payload?: {
    id?: string;
    role?: CodexSessionRole;
    type?: string;
    content?: Array<Record<string, unknown>>;
    cwd?: string;
  };
}

interface SessionIndexEntry {
  id?: string;
  thread_name?: string;
  updated_at?: string;
}

const maxMessageLength = 6000;
const defaultMessageLimit = 120;

export async function getCodexSession(
  repoRoot: string,
  threadId = process.env.CODEX_THREAD_ID,
  limit = defaultMessageLimit
): Promise<CodexSessionResponse> {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const sourcePath = await findSessionPath(codexHome, repoRoot, threadId);

  if (!sourcePath) {
    return {
      threadId,
      messages: [],
      unavailableReason: threadId
        ? `No local Codex session file found for thread ${threadId}.`
        : 'CODEX_THREAD_ID is not set and no session for this repository was found.'
    };
  }

  const [index, raw] = await Promise.all([
    readSessionIndex(codexHome),
    readFile(sourcePath, 'utf8')
  ]);
  const messages = parseSessionMessages(raw).slice(-limit);
  const idFromPath = threadId ?? inferThreadIdFromPath(sourcePath);
  const indexEntry = idFromPath ? index.get(idFromPath) : undefined;

  return {
    threadId: idFromPath,
    threadName: indexEntry?.thread_name,
    sourcePath,
    updatedAt: latestTimestamp(indexEntry?.updated_at, messages[messages.length - 1]?.timestamp),
    messages
  };
}

async function findSessionPath(
  codexHome: string,
  repoRoot: string,
  threadId: string | undefined
): Promise<string | undefined> {
  const sessionsRoot = path.join(codexHome, 'sessions');
  if (threadId) {
    const exact = await findFileByNeedle(sessionsRoot, threadId);
    if (exact) {
      return exact;
    }
  }

  return findLatestSessionForRepo(sessionsRoot, repoRoot);
}

async function findFileByNeedle(root: string, needle: string): Promise<string | undefined> {
  const files = await listJsonlFiles(root);
  return files.find((file) => path.basename(file).includes(needle));
}

async function findLatestSessionForRepo(
  root: string,
  repoRoot: string
): Promise<string | undefined> {
  const files = await listJsonlFiles(root);
  const matches: Array<{ file: string; timestamp: number }> = [];

  for (const file of files) {
    try {
      const firstLine = (await readFile(file, 'utf8')).split(/\r?\n/, 1)[0];
      const parsed = JSON.parse(firstLine) as RawSessionLine;
      if (parsed.type === 'session_meta' && parsed.payload?.cwd === repoRoot) {
        matches.push({
          file,
          timestamp: Date.parse(parsed.timestamp ?? '') || 0
        });
      }
    } catch {
      // Ignore malformed or inaccessible historical sessions.
    }
  }

  return matches.sort((left, right) => right.timestamp - left.timestamp)[0]?.file;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await collectJsonlFiles(root, files);
  return files.sort().reverse();
}

async function collectJsonlFiles(dir: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(entryPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
}

async function readSessionIndex(codexHome: string): Promise<Map<string, SessionIndexEntry>> {
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  const index = new Map<string, SessionIndexEntry>();

  try {
    const raw = await readFile(indexPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const entry = JSON.parse(line) as SessionIndexEntry;
      if (entry.id) {
        index.set(entry.id, entry);
      }
    }
  } catch {
    // The session file itself is enough for the UI.
  }

  return index;
}

function parseSessionMessages(raw: string): CodexSessionMessage[] {
  const messages: CodexSessionMessage[] = [];

  raw.split(/\r?\n/).forEach((line, lineIndex) => {
    if (!line.trim()) {
      return;
    }

    try {
      const parsed = JSON.parse(line) as RawSessionLine;
      const payload = parsed.payload;
      if (parsed.type !== 'response_item' || payload?.type !== 'message') {
        return;
      }
      if (payload.role !== 'user' && payload.role !== 'assistant') {
        return;
      }

      const text = extractContentText(payload.content ?? []);
      if (!text || shouldHideMessage(text)) {
        return;
      }

      messages.push({
        id: `${lineIndex}-${parsed.timestamp ?? 'unknown'}`,
        role: payload.role,
        text: trimMessage(text),
        timestamp: parsed.timestamp ?? new Date(0).toISOString()
      });
    } catch {
      // Ignore malformed partial lines while Codex is actively appending.
    }
  });

  return messages;
}

function extractContentText(content: Array<Record<string, unknown>>): string {
  return content
    .map((item) => {
      const text = item.text ?? item.transcript ?? item.content;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function shouldHideMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('<permissions instructions>') ||
    trimmed.startsWith('<collaboration_mode>') ||
    trimmed.startsWith('<app-context>')
  );
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function trimMessage(text: string): string {
  const cleaned = stripAnsi(text);
  return cleaned.length > maxMessageLength ? `${cleaned.slice(0, maxMessageLength)}\n...` : cleaned;
}

function latestTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function inferThreadIdFromPath(filePath: string): string | undefined {
  const match = path.basename(filePath).match(/(019[a-z0-9-]+)/);
  return match?.[1];
}
