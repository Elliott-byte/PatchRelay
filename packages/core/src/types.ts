export type DiffSource = 'staged' | 'unstaged' | 'untracked' | 'committed';
export type DiffLineType = 'context' | 'add' | 'remove' | 'meta';
export type CommentSide = 'old' | 'new';
export type CommentSeverity = 'note' | 'bug' | 'question' | 'nit';
export type CommentStatus = 'open' | 'resolved';
export type AgentKind = 'codex' | 'claude';

export interface PatchRelayConfig {
  codexCommand: string;
  claudeCommand: string;
  includeStagedDiff: boolean;
  includeUnstagedDiff: boolean;
}

export interface RepoInfo {
  repoRoot: string;
  repoName: string;
  branch: string;
}

export interface DiffLine {
  id: string;
  type: DiffLineType;
  raw: string;
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  id: string;
  source: DiffSource;
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
}

export interface DiffResponse {
  repo: RepoInfo;
  files: DiffFile[];
  generatedAt: string;
  updatedAt?: string;
}

export interface ReviewComment {
  id: string;
  file: string;
  side: CommentSide;
  line: number;
  hunkHeader: string;
  selectedCode: string;
  comment: string;
  severity: CommentSeverity;
  status: CommentStatus;
  author?: 'human' | 'ai';
  createdAt: string;
  updatedAt: string;
}

export interface CreateCommentInput {
  file: string;
  side: CommentSide;
  line: number;
  hunkHeader: string;
  selectedCode?: string;
  comment: string;
  severity?: CommentSeverity;
  author?: 'human' | 'ai';
}

export interface UpdateCommentInput {
  comment?: string;
  severity?: CommentSeverity;
  status?: CommentStatus;
  selectedCode?: string;
}

export interface AgentRunResult {
  success: boolean;
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface BranchInfo {
  current: string;
  branches: string[];
}

export interface CommitResult {
  hash: string;
}

export type CodexSessionRole = 'user' | 'assistant';

export interface CodexSessionMessage {
  id: string;
  role: CodexSessionRole;
  text: string;
  timestamp: string;
}

export interface CodexSessionResponse {
  threadId?: string;
  threadName?: string;
  title?: string;
  sourcePath?: string;
  updatedAt?: string;
  messages: CodexSessionMessage[];
  unavailableReason?: string;
}
