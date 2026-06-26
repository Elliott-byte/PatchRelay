import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../src/git.js';

const SAMPLE = `diff --git a/src/foo.ts b/src/foo.ts
index abc1234..def5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;

describe('parseUnifiedDiff', () => {
  it('parses a file, its hunk, and per-line types/numbers', () => {
    const files = parseUnifiedDiff(SAMPLE, 'unstaged');
    expect(files).toHaveLength(1);
    const file = files[0];
    expect(file.newPath).toBe('src/foo.ts');
    expect(file.oldPath).toBe('src/foo.ts');
    expect(file.source).toBe('unstaged');
    expect(file.hunks).toHaveLength(1);

    const types = file.hunks[0].lines.map((l) => l.type);
    expect(types).toEqual(['context', 'remove', 'add', 'add', 'context']);

    const lines = file.hunks[0].lines;
    expect(lines[0]).toMatchObject({ content: 'const a = 1;', oldLine: 1, newLine: 1 });
    expect(lines[1]).toMatchObject({ content: 'const b = 2;', oldLine: 2 }); // removed: no newLine
    expect(lines[1].newLine).toBeUndefined();
    expect(lines[2]).toMatchObject({ content: 'const b = 3;', newLine: 2 }); // added: no oldLine
    expect(lines[2].oldLine).toBeUndefined();
    expect(lines[4]).toMatchObject({ content: 'const d = 5;', oldLine: 3, newLine: 4 });
  });

  it('returns [] for an empty diff', () => {
    expect(parseUnifiedDiff('', 'staged')).toEqual([]);
    expect(parseUnifiedDiff('\n', 'staged')).toEqual([]);
  });

  it('drops files with no hunks', () => {
    const onlyHeader = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n';
    expect(parseUnifiedDiff(onlyHeader, 'unstaged')).toEqual([]);
  });

  it('parses multiple files', () => {
    const two = SAMPLE + `diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-x
+y
`;
    const files = parseUnifiedDiff(two, 'unstaged');
    expect(files.map((f) => f.newPath)).toEqual(['src/foo.ts', 'b.ts']);
  });
});
