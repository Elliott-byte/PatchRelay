import { randomUUID } from 'node:crypto';
import { rename, readFile, writeFile } from 'node:fs/promises';
import type { CreateCommentInput, ReviewComment, UpdateCommentInput } from './types.js';
import { ensurePatchRelayDir, getCommentsPath } from './config.js';

export async function listComments(repoRoot: string): Promise<ReviewComment[]> {
  await ensureCommentsFile(repoRoot);
  const raw = await readFile(getCommentsPath(repoRoot), 'utf8');
  const comments = JSON.parse(raw);
  if (!Array.isArray(comments)) {
    throw new Error('Expected .patchrelay/comments.json to contain an array.');
  }
  return comments;
}

export async function createComment(repoRoot: string, input: CreateCommentInput): Promise<ReviewComment> {
  const comments = await listComments(repoRoot);
  const now = new Date().toISOString();
  const comment: ReviewComment = {
    id: randomUUID(),
    file: input.file,
    side: input.side,
    line: input.line,
    hunkHeader: input.hunkHeader,
    selectedCode: input.selectedCode ?? '',
    comment: input.comment,
    severity: input.severity ?? 'bug',
    status: 'open',
    author: input.author ?? 'human',
    createdAt: now,
    updatedAt: now
  };
  await writeComments(repoRoot, [...comments, comment]);
  return comment;
}

export async function updateComment(
  repoRoot: string,
  id: string,
  input: UpdateCommentInput
): Promise<ReviewComment> {
  const comments = await listComments(repoRoot);
  const index = comments.findIndex((comment) => comment.id === id);
  if (index === -1) {
    throw new CommentNotFoundError(id);
  }

  const updated: ReviewComment = {
    ...comments[index],
    ...input,
    updatedAt: new Date().toISOString()
  };
  comments[index] = updated;
  await writeComments(repoRoot, comments);
  return updated;
}

export async function deleteComment(repoRoot: string, id: string): Promise<void> {
  const comments = await listComments(repoRoot);
  const next = comments.filter((comment) => comment.id !== id);
  if (next.length === comments.length) {
    throw new CommentNotFoundError(id);
  }
  await writeComments(repoRoot, next);
}

export async function writeComments(repoRoot: string, comments: ReviewComment[]): Promise<void> {
  await ensurePatchRelayDir(repoRoot);
  const commentsPath = getCommentsPath(repoRoot);
  const tempPath = `${commentsPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(comments, null, 2)}\n`, 'utf8');
  await rename(tempPath, commentsPath);
}

export class CommentNotFoundError extends Error {
  constructor(id: string) {
    super(`Comment not found: ${id}`);
    this.name = 'CommentNotFoundError';
  }
}

async function ensureCommentsFile(repoRoot: string): Promise<void> {
  await ensurePatchRelayDir(repoRoot);
  try {
    await readFile(getCommentsPath(repoRoot), 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      await writeComments(repoRoot, []);
      return;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
