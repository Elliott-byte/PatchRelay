import type { DiffFile, DiffHunk, DiffLine, DiffResponse, ReviewComment } from './types.js';

export interface AgentInput {
  systemPrompt: string;
  userMessage: string;
}

export function buildAgentInput(
  diff: DiffResponse,
  comments: ReviewComment[],
  customMessage?: string
): AgentInput {
  const openComments = comments.filter((c) => c.status === 'open');

  if (openComments.length > 0) {
    return buildReviewInput(diff, openComments, customMessage);
  }

  return buildChatInput(diff, customMessage);
}

function buildReviewInput(
  diff: DiffResponse,
  openComments: ReviewComment[],
  customMessage?: string
): AgentInput {
  const commentSections = openComments.map((comment, index) =>
    formatCommentSection(index + 1, comment, diff.files)
  );

  const systemPrompt = [
    'You are addressing local human review comments in a git working tree.',
    '',
    'Instructions:',
    '- Make minimal changes; do not refactor unrelated code; preserve existing style.',
    '- Handle each comment according to its Severity:',
    '    • bug — a real defect: fix it.',
    '    • nit — minor/style: apply only if quick and low-risk; otherwise leave a short note on why you skipped it.',
    '    • question — the reviewer wants an answer, not necessarily a code change: answer it in your summary, and only edit code if the answer implies a fix.',
    '    • note — context/FYI: take no action unless it clearly implies a change.',
    '- Run relevant tests if possible.',
    '- Do not delete review comments unless the issue is fixed.',
    '- If a comment is unclear, make the safest minimal fix and state your assumptions.',
    '',
    `Repository: ${diff.repo.repoName}`,
    `Branch: ${diff.repo.branch}`,
    `Repo root: ${diff.repo.repoRoot}`,
    '',
    `Open review comments: ${openComments.length}`,
    '',
    commentSections.join('\n\n'),
    '',
    'Finish with a summary: what changed, how each comment was addressed (answer questions explicitly), and anything you intentionally skipped (with why).',
  ].join('\n');

  const userMessage = customMessage?.trim() ?? 'Fix all open review comments.';

  return { systemPrompt, userMessage };
}

function buildChatInput(diff: DiffResponse, customMessage?: string): AgentInput {
  const fileSummary = diff.files.length > 0
    ? ` There are currently ${diff.files.length} changed file(s): ${diff.files.map(f => f.newPath !== '/dev/null' ? f.newPath : f.oldPath).join(', ')}.`
    : '';

  const systemPrompt = [
    `You are a coding assistant working in the repository "${diff.repo.repoName}" on branch "${diff.repo.branch}".`,
    `Repo root: ${diff.repo.repoRoot}.${fileSummary}`,
  ].join('\n');

  const userMessage = customMessage?.trim() ?? '';

  return { systemPrompt, userMessage };
}

// Legacy export — kept so any external callers don't break
export function buildAgentPrompt(
  diff: DiffResponse,
  comments: ReviewComment[],
  customMessage?: string
): string {
  const { systemPrompt, userMessage } = buildAgentInput(diff, comments, customMessage);
  return [systemPrompt, '', userMessage].join('\n');
}

function formatCommentSection(index: number, comment: ReviewComment, files: DiffFile[]): string {
  const matchingFile = files.find(
    (file) => file.newPath === comment.file || file.oldPath === comment.file
  );
  const matchingHunk = matchingFile ? findRelevantHunk(matchingFile, comment) : undefined;

  return [
    `Comment ${index}`,
    `ID: ${comment.id}`,
    `Severity: ${comment.severity}`,
    `File: ${comment.file}`,
    `Line: ${comment.side}:${comment.line}`,
    `Hunk: ${comment.hunkHeader}`,
    comment.selectedCode ? `Selected code:\n${indentBlock(comment.selectedCode)}` : 'Selected code: none',
    `Human comment:\n${indentBlock(comment.comment)}`,
    matchingHunk
      ? `Relevant diff context:\n\`\`\`diff\n${formatHunk(matchingHunk)}\n\`\`\``
      : 'Relevant diff context: unavailable'
  ].join('\n');
}

function findRelevantHunk(file: DiffFile, comment: ReviewComment): DiffHunk | undefined {
  return (
    file.hunks.find((hunk) => hunk.header === comment.hunkHeader) ??
    file.hunks.find((hunk) =>
      hunk.lines.some((line) =>
        comment.side === 'new' ? line.newLine === comment.line : line.oldLine === comment.line
      )
    )
  );
}

function formatHunk(hunk: DiffHunk): string {
  return [
    hunk.header,
    ...hunk.lines.map((line) => `${linePrefix(line)} ${lineNumberLabel(line)} ${line.content}`)
  ].join('\n');
}

function linePrefix(line: DiffLine): string {
  if (line.type === 'add') return '+';
  if (line.type === 'remove') return '-';
  return ' ';
}

function lineNumberLabel(line: DiffLine): string {
  const oldLabel = typeof line.oldLine === 'number' ? String(line.oldLine).padStart(4, ' ') : '    ';
  const newLabel = typeof line.newLine === 'number' ? String(line.newLine).padStart(4, ' ') : '    ';
  return `${oldLabel} ${newLabel}`;
}

function indentBlock(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join('\n');
}
