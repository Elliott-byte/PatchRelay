// Dev-only API server. Run via `tsx watch` so editing any core/server source
// auto-restarts it. The Vite dev server (port 5173) proxies /api here.
//
// Resolution of @patchrelay/* is mapped to package src by tsconfig.dev.json,
// so there is no build step in the dev loop.
import { findGitRoot, loadConfig } from '@patchrelay/core';
import { startPatchRelayServer } from '@patchrelay/server';

const DEV_PORT = 3766; // must match the proxy target in packages/web/vite.config.ts

const repoRoot = await findGitRoot(process.cwd());
await loadConfig(repoRoot);
const server = await startPatchRelayServer({ repoRoot, port: DEV_PORT });

console.log(`[dev] API listening on ${server.url}`);
console.log(`[dev] Open the app at http://127.0.0.1:5173`);
