import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DiffFile, DiffLine, DiffResponse, DiffSource, PatchRelayConfig, RepoInfo } from './types.js';

const execFileAsync = promisify(execFile);
const maxUntrackedTextBytes = 512 * 1024;

export async function findGitRoot(startDir = process.cwd()): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    cwd: startDir
  });
  return stdout.trim();
}

export async function getRepoInfo(repoRoot: string): Promise<RepoInfo> {
  const [branchResult] = await Promise.allSettled([
    execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })
  ]);
  const branch =
    branchResult.status === 'fulfilled' ? branchResult.value.stdout.trim() || 'unknown' : 'unknown';

  return {
    repoRoot,
    repoName: path.basename(repoRoot),
    branch
  };
}

export async function getDiffResponse(
  repoRoot: string,
  config: Pick<PatchRelayConfig, 'includeStagedDiff' | 'includeUnstagedDiff'>
): Promise<DiffResponse> {
  const diffTasks: Promise<DiffFile[]>[] = [];
  if (config.includeStagedDiff) {
    diffTasks.push(getDiffFiles(repoRoot, 'staged'));
  }
  if (config.includeUnstagedDiff) {
    diffTasks.push(getDiffFiles(repoRoot, 'unstaged'));
    diffTasks.push(getUntrackedDiffFiles(repoRoot));
  }

  const [repo, diffResults] = await Promise.all([getRepoInfo(repoRoot), Promise.all(diffTasks)]);
  const files = diffResults.flat();
  const updatedAt = await getLatestChangedFileTime(repoRoot, files);

  return {
    repo,
    files,
    generatedAt: new Date().toISOString(),
    updatedAt
  };
}

export async function getDiffFiles(repoRoot: string, source: DiffSource): Promise<DiffFile[]> {
  const args = source === 'staged' ? ['diff', '--cached', '--no-ext-diff'] : ['diff', '--no-ext-diff'];
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024
  });
  return parseUnifiedDiff(stdout, source);
}

export function parseUnifiedDiff(diff: string, source: DiffSource): DiffFile[] {
  const normalizedDiff = diff.endsWith('\n') ? diff.slice(0, -1) : diff;
  if (!normalizedDiff) {
    return [];
  }

  const lines = normalizedDiff.split(/\r?\n/);
  const files: DiffFile[] = [];
  let currentFile: DiffFile | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of lines) {
    if (rawLine.length === 0 && !currentFile) {
      continue;
    }

    const diffGitMatch = rawLine.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diffGitMatch) {
      currentFile = {
        id: `${source}:${files.length}:${diffGitMatch[1]}:${diffGitMatch[2]}`,
        source,
        oldPath: diffGitMatch[1],
        newPath: diffGitMatch[2],
        hunks: []
      };
      files.push(currentFile);
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (rawLine.startsWith('--- ')) {
      currentFile.oldPath = stripDiffPath(rawLine.slice(4));
      continue;
    }

    if (rawLine.startsWith('+++ ')) {
      currentFile.newPath = stripDiffPath(rawLine.slice(4));
      continue;
    }

    const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      currentFile.hunks.push({
        id: `${currentFile.id}:hunk:${currentFile.hunks.length}`,
        header: rawLine,
        oldStart: oldLine,
        oldLines: Number(hunkMatch[2] ?? 1),
        newStart: newLine,
        newLines: Number(hunkMatch[4] ?? 1),
        lines: []
      });
      continue;
    }

    const currentHunk = currentFile.hunks[currentFile.hunks.length - 1];
    if (!currentHunk) {
      continue;
    }

    const lineId = `${currentHunk.id}:line:${currentHunk.lines.length}`;
    const parsedLine = parseDiffLine(rawLine, lineId, oldLine, newLine);
    currentHunk.lines.push(parsedLine.line);
    oldLine = parsedLine.nextOldLine;
    newLine = parsedLine.nextNewLine;
  }

  return files.filter((file) => file.hunks.length > 0);
}

export async function getUntrackedDiffFiles(repoRoot: string): Promise<DiffFile[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    {
      cwd: repoRoot,
      maxBuffer: 20 * 1024 * 1024
    }
  );
  const filePaths = stdout.split('\0').filter(Boolean);
  const files = await Promise.all(
    filePaths.map((filePath, index) => createUntrackedDiffFile(repoRoot, filePath, index))
  );
  return files;
}

async function createUntrackedDiffFile(
  repoRoot: string,
  filePath: string,
  index: number
): Promise<DiffFile> {
  const id = `untracked:${index}:/dev/null:${filePath}`;
  const absolutePath = path.join(repoRoot, filePath);
  const fileStat = await stat(absolutePath);

  if (fileStat.size > maxUntrackedTextBytes) {
    return createMetaOnlyDiffFile(id, filePath, `File is ${formatBytes(fileStat.size)}; preview skipped.`);
  }

  const buffer = await readFile(absolutePath);
  if (!isLikelyText(buffer)) {
    return createMetaOnlyDiffFile(id, filePath, 'Binary file not shown.');
  }

  const normalized = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const content = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  const lines = content ? content.split('\n') : [];
  const hunkId = `${id}:hunk:0`;

  return {
    id,
    source: 'untracked',
    oldPath: '/dev/null',
    newPath: filePath,
    hunks: [
      {
        id: hunkId,
        header: `@@ -0,0 +1,${lines.length} @@`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines: lines.map<DiffLine>((line, lineIndex) => ({
          id: `${hunkId}:line:${lineIndex}`,
          type: 'add',
          raw: `+${line}`,
          content: line,
          newLine: lineIndex + 1
        }))
      }
    ]
  };
}

function createMetaOnlyDiffFile(id: string, filePath: string, message: string): DiffFile {
  const hunkId = `${id}:hunk:0`;
  return {
    id,
    source: 'untracked',
    oldPath: '/dev/null',
    newPath: filePath,
    hunks: [
      {
        id: hunkId,
        header: '@@ -0,0 +0,0 @@',
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        lines: [
          {
            id: `${hunkId}:line:0`,
            type: 'meta',
            raw: message,
            content: message
          }
        ]
      }
    ]
  };
}

async function getLatestChangedFileTime(
  repoRoot: string,
  files: DiffFile[]
): Promise<string | undefined> {
  const filePaths = new Set<string>();
  for (const file of files) {
    if (file.oldPath !== '/dev/null') {
      filePaths.add(file.oldPath);
    }
    if (file.newPath !== '/dev/null') {
      filePaths.add(file.newPath);
    }
  }

  const mtimes = await Promise.all(
    [...filePaths].map(async (filePath) => {
      try {
        return (await stat(path.join(repoRoot, filePath))).mtimeMs;
      } catch {
        return 0;
      }
    })
  );
  const latest = Math.max(0, ...mtimes);
  return latest > 0 ? new Date(latest).toISOString() : undefined;
}

function isLikelyText(buffer: Buffer): boolean {
  return !buffer.includes(0);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseDiffLine(
  rawLine: string,
  id: string,
  currentOldLine: number,
  currentNewLine: number
): { line: DiffLine; nextOldLine: number; nextNewLine: number } {
  if (rawLine.startsWith('+')) {
    return {
      line: {
        id,
        type: 'add',
        raw: rawLine,
        content: rawLine.slice(1),
        newLine: currentNewLine
      },
      nextOldLine: currentOldLine,
      nextNewLine: currentNewLine + 1
    };
  }

  if (rawLine.startsWith('-')) {
    return {
      line: {
        id,
        type: 'remove',
        raw: rawLine,
        content: rawLine.slice(1),
        oldLine: currentOldLine
      },
      nextOldLine: currentOldLine + 1,
      nextNewLine: currentNewLine
    };
  }

  if (rawLine.startsWith(' ')) {
    return {
      line: {
        id,
        type: 'context',
        raw: rawLine,
        content: rawLine.slice(1),
        oldLine: currentOldLine,
        newLine: currentNewLine
      },
      nextOldLine: currentOldLine + 1,
      nextNewLine: currentNewLine + 1
    };
  }

  return {
    line: {
      id,
      type: 'meta',
      raw: rawLine,
      content: rawLine
    },
    nextOldLine: currentOldLine,
    nextNewLine: currentNewLine
  };
}

export async function listBranches(
  repoRoot: string
): Promise<{ current: string; branches: string[] }> {
  // In a fresh repo with no commits, HEAD is unborn and `rev-parse --abbrev-ref
  // HEAD` errors — fall back to symbolic-ref (which still yields the branch name).
  const [branchesOut, currentOut] = await Promise.all([
    gitTry(repoRoot, ['branch', '--format=%(refname:short)']),
    gitTry(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).then(
      (out) => out || gitTry(repoRoot, ['symbolic-ref', '--short', 'HEAD'])
    ),
  ]);
  const branches = branchesOut
    .trim()
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean);
  const current = currentOut.trim() || 'unknown';
  return { current, branches };
}

export async function checkoutBranch(repoRoot: string, branch: string): Promise<void> {
  await execFileAsync('git', ['checkout', branch], { cwd: repoRoot });
}

export async function createBranch(repoRoot: string, name: string): Promise<void> {
  await execFileAsync('git', ['checkout', '-b', name], { cwd: repoRoot });
}

export async function deleteBranch(repoRoot: string, name: string): Promise<void> {
  await execFileAsync('git', ['branch', '-D', name], { cwd: repoRoot });
}

/** Merge `branch` into the current branch (auto-commit). Throws on conflict/error
 *  with git's output attached so the caller can surface it. */
export async function mergeBranch(repoRoot: string, branch: string): Promise<{ message: string }> {
  const { stdout, stderr } = await execFileAsync('git', ['merge', '--no-edit', branch], { cwd: repoRoot });
  return { message: (stdout || stderr || 'Merged.').trim() };
}

export async function stageFiles(repoRoot: string, files: string[]): Promise<void> {
  const args = files.length > 0 ? ['add', '--', ...files] : ['add', '-A'];
  await execFileAsync('git', args, { cwd: repoRoot });
}

export async function unstageFiles(repoRoot: string, files: string[]): Promise<void> {
  const args =
    files.length > 0 ? ['restore', '--staged', '--', ...files] : ['restore', '--staged', '.'];
  await execFileAsync('git', args, { cwd: repoRoot });
}

export async function commitChanges(
  repoRoot: string,
  message: string
): Promise<{ hash: string }> {
  await execFileAsync('git', ['commit', '-m', message], { cwd: repoRoot });
  const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot
  });
  return { hash: stdout.trim() };
}

// ── Remote sync (push / pull / fetch / ahead-behind) ───────────────────────────

export interface SyncStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  lastCommit?: { hash: string; subject: string };
}

async function gitTry(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function getSyncStatus(repoRoot: string): Promise<SyncStatus> {
  const [branchRaw, upstream, remotes, lastCommit] = await Promise.all([
    gitTry(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitTry(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    gitTry(repoRoot, ['remote']),
    gitTry(repoRoot, ['log', '-1', '--pretty=%h %s']),
  ]);
  // Unborn HEAD (no commits) — fall back to the symbolic branch name.
  const branch = branchRaw || (await gitTry(repoRoot, ['symbolic-ref', '--short', 'HEAD']));

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await gitTry(repoRoot, ['rev-list', '--count', '--left-right', `${upstream}...HEAD`]);
    const m = counts.match(/(\d+)\s+(\d+)/);
    if (m) { behind = Number(m[1]); ahead = Number(m[2]); }
  }

  const sp = lastCommit.indexOf(' ');
  const hash = sp === -1 ? lastCommit : lastCommit.slice(0, sp);
  const subject = sp === -1 ? '' : lastCommit.slice(sp + 1);
  return {
    branch: branch || 'unknown',
    upstream: upstream || null,
    ahead,
    behind,
    hasRemote: remotes.split('\n').filter(Boolean).length > 0,
    lastCommit: hash ? { hash, subject } : undefined,
  };
}

export async function pushChanges(repoRoot: string): Promise<{ message: string }> {
  const upstream = await gitTry(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  let args: string[];
  if (upstream) {
    args = ['push'];
  } else {
    const branch = await gitTry(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const remotes = (await gitTry(repoRoot, ['remote'])).split('\n').filter(Boolean);
    if (!remotes.length) throw new Error('No git remote configured. Add one with `git remote add origin <url>`.');
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    args = ['push', '--set-upstream', remote, branch];
  }
  const { stdout, stderr } = await execFileAsync('git', args, { cwd: repoRoot });
  return { message: (stderr || stdout || 'Pushed.').trim() };
}

export async function pullChanges(repoRoot: string): Promise<{ message: string }> {
  const { stdout, stderr } = await execFileAsync('git', ['pull'], { cwd: repoRoot });
  return { message: (stdout || stderr || 'Pulled.').trim() };
}

export async function fetchRemote(repoRoot: string): Promise<{ message: string }> {
  const { stdout, stderr } = await execFileAsync('git', ['fetch', '--prune'], { cwd: repoRoot });
  return { message: (stderr || stdout || 'Fetched.').trim() };
}

// ── Commit history (GitLens-style log) ─────────────────────────────────────────

export interface CommitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;          // ISO author date
  relativeDate: string;  // e.g. "3 days ago"
  subject: string;
}

const UNIT = '\x1f'; // field separator
const REC = '\x1e';  // record separator

export async function getCommitLog(repoRoot: string, limit = 60): Promise<CommitLogEntry[]> {
  const n = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 60, 500));
  const fmt = ['%H', '%h', '%an', '%ae', '%aI', '%ar', '%s'].join(UNIT) + REC;
  const out = await gitTry(repoRoot, ['log', `-n${n}`, `--pretty=format:${fmt}`]);
  if (!out) return [];
  return out
    .split(REC)
    .map((s) => s.replace(/^\r?\n/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, author, email, date, relativeDate, subject] = line.split(UNIT);
      return { hash, shortHash, author, email, date, relativeDate, subject: subject ?? '' };
    });
}

export interface CommitDetail {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  files: DiffFile[];
}

export async function getCommitDiff(repoRoot: string, hash: string): Promise<CommitDetail> {
  const metaFmt = ['%H', '%h', '%an', '%ae', '%aI', '%s', '%b'].join(UNIT);
  const meta = await gitTry(repoRoot, ['show', '-s', `--pretty=format:${metaFmt}`, hash]);
  const [h, sh, author, email, date, subject, body] = meta.split(UNIT);
  // Unified diff of the commit vs its first parent (empty --format suppresses the header).
  const diff = await gitTry(repoRoot, ['show', hash, '--no-color', '--no-ext-diff', '--format=']);
  return {
    hash: h || hash,
    shortHash: sh || hash.slice(0, 7),
    author: author ?? '',
    email: email ?? '',
    date: date ?? '',
    subject: subject ?? '',
    body: (body ?? '').trim(),
    files: parseUnifiedDiff(diff, 'committed'),
  };
}

export interface BranchComparison {
  base: string;
  head: string;
  ahead: number;   // commits on head not in base
  behind: number;  // commits on base not in head
  files: DiffFile[];
}

/**
 * Compare the current branch against `base` (PR-style): `git diff base...HEAD`
 * shows what HEAD introduced since it diverged from base.
 */
export async function getBranchComparison(repoRoot: string, base: string): Promise<BranchComparison> {
  const head = (await gitTry(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])) || 'HEAD';
  const diff = await gitTry(repoRoot, ['diff', `${base}...HEAD`, '--no-color', '--no-ext-diff']);
  const counts = await gitTry(repoRoot, ['rev-list', '--count', '--left-right', `${base}...HEAD`]);
  const m = counts.match(/(\d+)\s+(\d+)/);
  return {
    base,
    head,
    behind: m ? Number(m[1]) : 0,
    ahead: m ? Number(m[2]) : 0,
    files: parseUnifiedDiff(diff, 'committed'),
  };
}

// ── Blame / annotate ───────────────────────────────────────────────────────────

export interface BlameLine { line: number; hash: string; author: string; date: string; summary: string; }

export async function getBlame(repoRoot: string, file: string): Promise<BlameLine[]> {
  const { stdout } = await execFileAsync('git', ['blame', '--line-porcelain', '--', file], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseBlamePorcelain(stdout);
}

export function parseBlamePorcelain(out: string): BlameLine[] {
  const result: BlameLine[] = [];
  const meta = new Map<string, { author?: string; time?: number; summary?: string }>();
  let cur: { hash: string; finalLine: number } | null = null;
  for (const l of out.split(/\r?\n/)) {
    const head = l.match(/^([0-9a-f]{7,40})\s+\d+\s+(\d+)(?:\s+\d+)?$/);
    if (head) {
      cur = { hash: head[1], finalLine: Number(head[2]) };
      if (!meta.has(cur.hash)) meta.set(cur.hash, {});
      continue;
    }
    if (!cur) continue;
    const m = meta.get(cur.hash)!;
    if (l.startsWith('author ')) m.author = l.slice(7);
    else if (l.startsWith('author-time ')) m.time = Number(l.slice(12));
    else if (l.startsWith('summary ')) m.summary = l.slice(8);
    else if (l.startsWith('\t')) {
      result.push({
        line: cur.finalLine,
        hash: cur.hash.slice(0, 8),
        author: m.author ?? '',
        date: m.time ? new Date(m.time * 1000).toISOString() : '',
        summary: m.summary ?? '',
      });
      cur = null;
    }
  }
  return result;
}

// ── Discard / rollback ─────────────────────────────────────────────────────────

/** Discard a file's local changes: restore tracked files to HEAD, delete untracked. */
export async function discardFile(repoRoot: string, file: string): Promise<void> {
  const tracked = await gitTry(repoRoot, ['ls-files', '--error-unmatch', '--', file]);
  if (tracked) {
    await execFileAsync('git', ['restore', '--source=HEAD', '--staged', '--worktree', '--', file], { cwd: repoRoot });
  } else {
    await execFileAsync('git', ['clean', '-fd', '--', file], { cwd: repoRoot });
  }
}

// ── Stash ──────────────────────────────────────────────────────────────────────

export interface StashEntry { index: number; ref: string; message: string; }

export function parseStashList(out: string): StashEntry[] {
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const m = l.match(/^stash@\{(\d+)\}:\s*(.*)$/);
    return m ? { index: Number(m[1]), ref: `stash@{${m[1]}}`, message: m[2].replace(/\r$/, '') } : null;
  }).filter((x): x is StashEntry => x !== null);
}

export async function stashList(repoRoot: string): Promise<StashEntry[]> {
  return parseStashList(await gitTry(repoRoot, ['stash', 'list']));
}

export async function stashSave(repoRoot: string, message?: string): Promise<{ message: string }> {
  const args = ['stash', 'push'];
  if (message && message.trim()) args.push('-m', message.trim());
  const { stdout, stderr } = await execFileAsync('git', args, { cwd: repoRoot });
  return { message: (stdout || stderr || 'Stashed.').trim() };
}

export async function stashApply(repoRoot: string, index: number, pop: boolean): Promise<{ message: string }> {
  const { stdout, stderr } = await execFileAsync('git', ['stash', pop ? 'pop' : 'apply', `stash@{${index}}`], { cwd: repoRoot });
  return { message: (stdout || stderr || (pop ? 'Popped.' : 'Applied.')).trim() };
}

export async function stashDrop(repoRoot: string, index: number): Promise<{ message: string }> {
  const { stdout, stderr } = await execFileAsync('git', ['stash', 'drop', `stash@{${index}}`], { cwd: repoRoot });
  return { message: (stdout || stderr || 'Dropped.').trim() };
}

// ── Commit actions (IntelliJ Git Log–style) ────────────────────────────────────

export async function revertCommit(repoRoot: string, hash: string): Promise<{ message: string }> {
  const { stdout, stderr } = await execFileAsync('git', ['revert', '--no-edit', hash], { cwd: repoRoot });
  return { message: (stdout || stderr || 'Reverted.').trim() };
}

export async function cherryPickCommit(repoRoot: string, hash: string): Promise<{ message: string }> {
  const { stdout, stderr } = await execFileAsync('git', ['cherry-pick', hash], { cwd: repoRoot });
  return { message: (stdout || stderr || 'Cherry-picked.').trim() };
}

export async function resetToCommit(repoRoot: string, hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<{ message: string }> {
  const flag = mode === 'hard' ? '--hard' : mode === 'soft' ? '--soft' : '--mixed';
  await execFileAsync('git', ['reset', flag, hash], { cwd: repoRoot });
  return { message: `Reset (${mode}) to ${hash.slice(0, 8)}` };
}

export async function createBranchAt(repoRoot: string, name: string, hash: string): Promise<void> {
  await execFileAsync('git', ['checkout', '-b', name, hash], { cwd: repoRoot });
}

export async function amendCommit(repoRoot: string, message?: string): Promise<{ hash: string }> {
  const args = message && message.trim() ? ['commit', '--amend', '-m', message.trim()] : ['commit', '--amend', '--no-edit'];
  await execFileAsync('git', args, { cwd: repoRoot });
  const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot });
  return { hash: stdout.trim() };
}

export async function createTag(repoRoot: string, name: string, hash?: string): Promise<void> {
  const args = ['tag', name];
  if (hash) args.push(hash);
  await execFileAsync('git', args, { cwd: repoRoot });
}

function stripDiffPath(rawPath: string): string {
  if (rawPath === '/dev/null') {
    return rawPath;
  }
  if (rawPath.startsWith('a/') || rawPath.startsWith('b/')) {
    return rawPath.slice(2);
  }
  return rawPath;
}
