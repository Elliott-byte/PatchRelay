import { spawn } from 'node:child_process';
import type { AgentRunResult } from './types.js';

export async function runAgentCommand(
  command: string,
  prompt: string,
  repoRoot: string
): Promise<AgentRunResult> {
  const parts = splitCommand(command);
  if (parts.length === 0) {
    return {
      success: false,
      command,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: 'Agent command is empty.'
    };
  }

  const [executable, ...args] = parts;

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: process.env
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        success: false,
        command,
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        error:
          error.code === 'ENOENT'
            ? `Command not found: ${executable}. Update .patchrelay/config.json if needed.`
            : error.message
      });
    });

    child.on('close', (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        success: exitCode === 0,
        command,
        exitCode,
        signal,
        stdout,
        stderr,
        error: exitCode === 0 ? undefined : `Agent command exited with code ${exitCode ?? 'unknown'}.`
      });
    });

    child.stdin.end(prompt);
  });
}

export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}
