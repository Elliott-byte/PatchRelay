import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PatchRelayConfig } from './types.js';

export const patchRelayDirName = '.patchrelay';
export const commentsFileName = 'comments.json';
export const configFileName = 'config.json';

export const defaultConfig: PatchRelayConfig = {
  codexCommand: 'codex exec --sandbox workspace-write -',
  claudeCommand: 'claude -p --output-format stream-json',
  includeStagedDiff: true,
  includeUnstagedDiff: true
};

export function getPatchRelayDir(repoRoot: string): string {
  return path.join(repoRoot, patchRelayDirName);
}

export function getCommentsPath(repoRoot: string): string {
  return path.join(getPatchRelayDir(repoRoot), commentsFileName);
}

export function getConfigPath(repoRoot: string): string {
  return path.join(getPatchRelayDir(repoRoot), configFileName);
}

export async function ensurePatchRelayDir(repoRoot: string): Promise<void> {
  await mkdir(getPatchRelayDir(repoRoot), { recursive: true });
}

export async function loadConfig(repoRoot: string): Promise<PatchRelayConfig> {
  await ensurePatchRelayDir(repoRoot);
  const configPath = getConfigPath(repoRoot);

  try {
    const raw = await readFile(configPath, 'utf8');
    return {
      ...defaultConfig,
      ...JSON.parse(raw)
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      await saveConfig(repoRoot, defaultConfig);
      return defaultConfig;
    }
    throw error;
  }
}

export async function saveConfig(repoRoot: string, config: PatchRelayConfig): Promise<void> {
  await ensurePatchRelayDir(repoRoot);
  await writeFile(getConfigPath(repoRoot), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
