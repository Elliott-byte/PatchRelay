import { describe, it, expect } from 'vitest';
import { buildAgentInput, buildReviewRequestPrompt, normalizeReviewSeverity, parseReviewFindings } from '../src/prompt.js';
import type { DiffResponse, ReviewComment } from '../src/types.js';

const diff: DiffResponse = {
  repo: { repoRoot: '/repo', repoName: 'demo', branch: 'main' },
  files: [
    {
      id: 'unstaged:0:a.ts:a.ts',
      source: 'unstaged',
      oldPath: 'a.ts',
      newPath: 'a.ts',
      hunks: [
        {
          id: 'h0',
          header: '@@ -1,2 +1,2 @@',
          oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
          lines: [
            { id: 'l0', type: 'context', raw: ' const x = 1;', content: 'const x = 1;', oldLine: 1, newLine: 1 },
            { id: 'l1', type: 'add', raw: '+const y = 2;', content: 'const y = 2;', newLine: 2 },
          ],
        },
      ],
    },
  ],
  generatedAt: '2025-01-01T00:00:00Z',
};

const openComment: ReviewComment = {
  id: 'c1', file: 'a.ts', side: 'new', line: 2, hunkHeader: '@@ -1,2 +1,2 @@',
  selectedCode: 'const y = 2;', comment: 'why a global?', severity: 'question', status: 'open',
  createdAt: '', updatedAt: '',
};

describe('buildAgentInput', () => {
  it('uses the chat path when there are no open comments', () => {
    const { systemPrompt, userMessage } = buildAgentInput(diff, [], 'do a thing');
    expect(systemPrompt).toContain('demo');
    expect(systemPrompt).toContain('main');
    expect(userMessage).toBe('do a thing');
    expect(systemPrompt).not.toContain('Severity');
  });

  it('uses the review path with per-severity guidance when comments are open', () => {
    const { systemPrompt } = buildAgentInput(diff, [openComment]);
    expect(systemPrompt).toContain('Severity');
    expect(systemPrompt).toContain('bug —');
    expect(systemPrompt).toContain('question —');
    expect(systemPrompt).toContain('Comment 1');
    expect(systemPrompt).toContain('why a global?');
  });

  it('ignores resolved comments', () => {
    const resolved = { ...openComment, status: 'resolved' as const };
    const { systemPrompt } = buildAgentInput(diff, [resolved]);
    expect(systemPrompt).not.toContain('Severity:');
  });
});

describe('buildReviewRequestPrompt', () => {
  it('asks for JSON and includes the file with NEW line numbers', () => {
    const p = buildReviewRequestPrompt(diff);
    expect(p).toContain('JSON array');
    expect(p).toContain('File: a.ts');
    expect(p).toMatch(/2 \+const y = 2;/); // new line number 2, added line
  });
});

describe('parseReviewFindings', () => {
  it('parses a clean JSON array', () => {
    const out = '[{"file":"a.ts","line":2,"severity":"bug","comment":"leak"}]';
    expect(parseReviewFindings(out)).toEqual([{ file: 'a.ts', line: 2, severity: 'bug', comment: 'leak' }]);
  });

  it('extracts the array even with surrounding prose', () => {
    const out = 'Here are my findings:\n[{"file":"a.ts","line":1,"severity":"nit","comment":"rename"}]\nDone.';
    expect(parseReviewFindings(out)).toHaveLength(1);
  });

  it('returns [] for non-JSON or no array', () => {
    expect(parseReviewFindings('no findings')).toEqual([]);
    expect(parseReviewFindings('[not json]')).toEqual([]);
  });

  it('drops items missing file/comment and normalizes severity', () => {
    const out = '[{"file":"a","comment":"ok","severity":"weird"},{"file":"b"},{"comment":"c"}]';
    const res = parseReviewFindings(out);
    expect(res).toHaveLength(1);
    expect(res[0].severity).toBe('note'); // unknown → note
  });
});

describe('normalizeReviewSeverity', () => {
  it('keeps valid severities and defaults the rest to note', () => {
    expect(normalizeReviewSeverity('BUG')).toBe('bug');
    expect(normalizeReviewSeverity('question')).toBe('question');
    expect(normalizeReviewSeverity('blocker')).toBe('note');
    expect(normalizeReviewSeverity(undefined)).toBe('note');
  });
});
