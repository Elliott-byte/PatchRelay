import { describe, it, expect } from 'vitest';
import { parseBlamePorcelain, parseStashList } from '../src/git.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

// `git blame --line-porcelain` — full headers per line; meta for a repeated commit
// may be omitted on later lines, so the parser must cache it by hash.
const BLAME = `${A} 1 1 1
author Alice
author-time 1700000000
summary Add a
filename foo.ts
\tconst a = 1;
${B} 2 2 1
author Bob
author-time 1700000100
summary Add b
filename foo.ts
\tconst b = 2;
${A} 3 3 1
\tconst a2 = a;
`;

describe('parseBlamePorcelain', () => {
  it('maps each line to its commit, author, and summary', () => {
    const lines = parseBlamePorcelain(BLAME);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ line: 1, hash: 'aaaaaaaa', author: 'Alice', summary: 'Add a' });
    expect(lines[1]).toMatchObject({ line: 2, hash: 'bbbbbbbb', author: 'Bob', summary: 'Add b' });
    // line 3 reuses commit A's cached author/summary
    expect(lines[2]).toMatchObject({ line: 3, hash: 'aaaaaaaa', author: 'Alice', summary: 'Add a' });
    expect(lines[0].date).toMatch(/^20\d\d-/); // ISO date derived from author-time
  });

  it('returns [] for empty input', () => {
    expect(parseBlamePorcelain('')).toEqual([]);
  });
});

describe('parseStashList', () => {
  it('parses stash refs, indexes, and messages', () => {
    const out = 'stash@{0}: WIP on main: 1234567 fix\nstash@{1}: On feature: custom note';
    expect(parseStashList(out)).toEqual([
      { index: 0, ref: 'stash@{0}', message: 'WIP on main: 1234567 fix' },
      { index: 1, ref: 'stash@{1}', message: 'On feature: custom note' },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseStashList('')).toEqual([]);
  });
});
