import type { DiffFile, DiffHunk, DiffLine, DiffResponse, ReviewComment } from './types.js';

export function buildReviewPrompt(
  diff: DiffResponse,
  comments: ReviewComment[],
  customMessage?: string
): string {
  const openComments = comments.filter((comment) => comment.status === 'open');
  const commentSections = openComments.map((comment, index) =>
    formatCommentSection(index + 1, comment, diff.files)
  );

  return [
    'You are fixing local human review comments in a git working tree.',
    '',
    'Instructions:',
    '- Make minimal changes.',
    '- Address every open review comment.',
    '- Do not refactor unrelated code.',
    '- Preserve existing style.',
    '- Run relevant tests if possible.',
    '- Summarize changes after fixing.',
    '- Do not delete comments unless the issue is fixed.',
    '- If a comment is unclear, make the safest minimal fix and mention assumptions.',
    '',
    `Repository: ${diff.repo.repoName}`,
    `Branch: ${diff.repo.branch}`,
    `Repo root: ${diff.repo.repoRoot}`,
    '',
    `Open review comments: ${openComments.length}`,
    '',
    openComments.length > 0
      ? commentSections.join('\n\n')
      : 'There are no open review comments. Do not make code changes unless explicitly necessary.',
    '',
    'After making fixes, summarize:',
    '- What changed',
    '- Which comments were addressed',
    '- Any tests run or skipped',
    ...(customMessage?.trim()
      ? ['', '---', 'Additional instructions from the reviewer:', customMessage.trim()]
      : [])
  ].join('\n');
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
  const exactHeader = file.hunks.find((hunk) => hunk.header === comment.hunkHeader);
  if (exactHeader) {
    return exactHeader;
  }

  return file.hunks.find((hunk) =>
    hunk.lines.some((line) =>
      comment.side === 'new' ? line.newLine === comment.line : line.oldLine === comment.line
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
  if (line.type === 'add') {
    return '+';
  }
  if (line.type === 'remove') {
    return '-';
  }
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
