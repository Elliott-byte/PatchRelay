#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGitRoot, loadConfig } from '@patchrelay/core';
import { startPatchRelayServer } from '@patchrelay/server';

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
  const command =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore'
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
