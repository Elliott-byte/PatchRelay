#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGitRoot, loadConfig } from '@patchrelay/core';
import { startPatchRelayServer } from '@patchrelay/server';

function isWSL(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

interface CliOptions {
  open: boolean;
  port?: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = await findGitRoot(process.cwd());
  await loadConfig(repoRoot);

  const staticDir = resolveWebDist();
  const runningServer = await startPatchRelayServer({
    repoRoot,
    port: options.port,
    staticDir
  });

  console.log(`PatchRelay running for ${repoRoot}`);
  console.log(`Open ${runningServer.url}`);

  if (options.open) {
    openBrowser(runningServer.url);
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { open: true };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    if (arg === '--no-open') {
      options.open = false;
      continue;
    }

    if (arg === '--port') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--port requires a number.');
      }
      options.port = parsePort(value);
      index += 1;
      continue;
    }

    if (arg.startsWith('--port=')) {
      options.port = parsePort(arg.slice('--port='.length));
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function resolveWebDist(): string {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dirname, '../../web/dist');
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const wsl = isWSL();
  let command: string;
  let args: string[];
  if (platform === 'darwin') { command = 'open'; args = [url]; }
  else if (platform === 'win32') { command = 'cmd'; args = ['/c', 'start', '', url]; }
  else if (wsl) { command = 'wslview'; args = [url]; }
  else { command = 'xdg-open'; args = [url]; }

  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    // On WSL, wslview/xdg-open may be absent — open via the Windows host instead.
    if (wsl) {
      const fb = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], { detached: true, stdio: 'ignore' });
      fb.on('error', () => { /* give up silently; the URL is printed to stdout */ });
      fb.unref();
    }
  });
  child.unref();
}

function printHelp(): void {
  console.log(`PatchRelay

Usage:
  patchrelay [--no-open] [--port 3766]

Options:
  --no-open       Start the server without opening a browser.
  --port <port>   Bind localhost server to a specific port.
  -h, --help      Show this help.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
