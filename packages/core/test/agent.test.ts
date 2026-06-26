import { describe, it, expect } from 'vitest';
import { splitCommand } from '../src/agent.js';

describe('splitCommand', () => {
  it('splits a plain command on whitespace', () => {
    expect(splitCommand('claude -p --model haiku')).toEqual(['claude', '-p', '--model', 'haiku']);
  });

  it('keeps double-quoted arguments together', () => {
    expect(splitCommand('claude --system-prompt "hello world"')).toEqual(['claude', '--system-prompt', 'hello world']);
  });

  it('keeps single-quoted arguments together', () => {
    expect(splitCommand("codex exec --sandbox 'workspace write'")).toEqual(['codex', 'exec', '--sandbox', 'workspace write']);
  });

  it('honors backslash escapes outside single quotes', () => {
    expect(splitCommand('a b\\ c')).toEqual(['a', 'b c']);
  });

  it('collapses extra whitespace and trims', () => {
    expect(splitCommand('  claude   -p  ')).toEqual(['claude', '-p']);
  });
});
