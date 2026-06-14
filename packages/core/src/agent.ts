import { spawn } from 'node:child_process';
import { readdir, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRunResult } from './types.js';

async function resolvedPath(): Promise<string> {
  const extra: string[] = [];

  if (process.platform === 'win32') {
    // Claude Code desktop app on Windows
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    const vmBase = path.join(appData, 'Claude', 'claude-code-vm');
    try {
      const versions = await readdir(vmBase);
      for (const v of versions) extra.push(path.join(vmBase, v));
    } catch { /* not installed */ }
    extra.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'claude-code'));
    extra.push(path.join(os.homedir(), 'AppData', 'Local', 'npm'));
    extra.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm'));
  } else {
    // Claude Code desktop app on macOS
    const vmBase = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-vm');
    try {
      const versions = await readdir(vmBase);
      for (const v of versions) extra.push(path.join(vmBase, v));
    } catch { /* not macOS or not installed */ }
    extra.push('/opt/homebrew/bin');
    extra.push('/usr/local/bin');
    extra.push(path.join(os.homedir(), '.local', 'bin'));
    extra.push(path.join(os.homedir(), 'bin'));
  }

  return [...extra, process.env.PATH ?? ''].join(path.delimiter);
}

export async function runAgentCommand(
  command: string,
  prompt: string,
  repoRoot: string,
  onChunk?: (text: string) => void,
  signal?: AbortSignal
): Promise<AgentRunResult> {
  if (!command.trim()) {
    return { success: false, command, exitCode: null, signal: null, stdout: '', stderr: '', error: 'Agent command is empty.' };
  }

  const resolvedEnvPath = await resolvedPath();

  // Write prompt to a temp file to avoid shell escaping issues with stdin
  const tmpPrompt = path.join(os.tmpdir(), `patchrelay-prompt-${Date.now()}.txt`);
  await writeFile(tmpPrompt, prompt, 'utf8');

  // Redirect stdin from temp file — `< "path"` works on both Unix shell and Windows cmd.exe
  const shellCommand = `${command} < ${JSON.stringify(tmpPrompt)}`;

  // On macOS/Linux: run via login shell so PATH is sourced from the user's profile.
  // On Windows: use cmd.exe (supports < redirection and finds claude/codex on PATH).
  const [shell, shellArgs]: [string, string[]] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/c', shellCommand]]
      : ['/bin/zsh', ['-l', '-c', shellCommand]];

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(shell, shellArgs, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: resolvedEnvPath }
    });

    child.stdout.on('data', (chunk: Buffer) => { const text = chunk.toString(); stdout += text; onChunk?.(text); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const finish = (exitCode: number | null, sig: NodeJS.Signals | null, error?: string) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      void unlink(tmpPrompt).catch(() => {});
      resolve({ success: exitCode === 0 && !error, command, exitCode, signal: sig, stdout, stderr, error });
    };

    const onAbort = () => { child.kill('SIGTERM'); finish(null, 'SIGTERM', 'Cancelled.'); };
    signal?.addEventListener('abort', onAbort);

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(null, null, err.code === 'ENOENT' ? `Command not found: ${command}` : err.message);
    });

    child.on('close', (exitCode, sig) => {
      finish(exitCode, sig, exitCode === 0 ? undefined : `Agent command exited with code ${exitCode ?? 'unknown'}.`);
    });
  });
}

export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) { current += char; escaping = false; continue; }
    if (char === '\\' && quote !== "'") { escaping = true; continue; }
    if ((char === '"' || char === "'") && !quote) { quote = char; continue; }
    if (char === quote) { quote = undefined; continue; }
    if (/\s/.test(char) && !quote) { if (current) { parts.push(current); current = ''; } continue; }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}
