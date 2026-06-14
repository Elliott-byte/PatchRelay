# PatchRelay

PatchRelay is a local AI code review workspace that lives inside your git repository. View your current diff in a browser, add inline comments on specific lines, then send the diff + comments to Claude Code or Codex. Watch the AI's responses stream back in a chat panel, then stage and commit — all without leaving the tool.

## Features

- **Diff viewer** — staged, unstaged, and untracked files with syntax-highlighted hunks
- **Inline comments** — click any diff line to leave a review comment; comments are grouped as chips in the compose bar
- **AI chat** — send your diff + comments to Claude Code or Codex; responses render with Markdown
- **Session history** — browse past Claude Code and Codex sessions; switch between them in the panel
- **Model selector** — pick the model after selecting a provider (Sonnet 4.6, Opus 4.8, Haiku 4.5 for Claude; o4-mini, GPT-4.1, GPT-4o for Codex)
- **Branch management** — switch branches, create new ones, and delete old ones from the UI
- **Apple-style UI** — glassmorphism panels, light/dark mode, macOS-native feel

## Setup

```bash
npm install
npm run build
```

For local development (Vite dev server proxies `/api` to the CLI):

```bash
# terminal 1 — CLI server
npm run -w @patchrelay/cli start -- --no-open --port 3766

# terminal 2 — Vite dev server
npm run -w @patchrelay/web dev
```

To install the CLI globally from a checkout:

```bash
npm link -w @patchrelay/cli
patchrelay
```

## CLI

```bash
patchrelay
patchrelay --no-open
patchrelay --port 3766
```

Detects the git root, creates `.patchrelay/config.json` if needed, starts the local server, and opens the browser.

## Config

`.patchrelay/config.json` (auto-created with defaults):

```json
{
  "codexCommand": "codex exec --sandbox workspace-write -",
  "claudeCommand": "claude -p",
  "includeStagedDiff": true,
  "includeUnstagedDiff": true
}
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/diff` | Current diff (staged + unstaged) |
| `GET` | `/api/comments` | All inline comments |
| `POST` | `/api/comments` | Create a comment |
| `PUT` | `/api/comments/:id` | Update a comment |
| `DELETE` | `/api/comments/:id` | Delete a comment |
| `POST` | `/api/comments/:id/resolve` | Resolve a comment |
| `POST` | `/api/comments/:id/reopen` | Reopen a comment |
| `GET` | `/api/sessions` | List all Claude/Codex sessions |
| `GET` | `/api/sessions/:id` | Load a specific session |
| `GET` | `/api/models?provider=claude\|codex` | Available models for a provider |
| `GET` | `/api/git/branches` | List branches + current |
| `POST` | `/api/git/checkout` | Switch branch |
| `POST` | `/api/git/branch` | Create and switch to new branch |
| `DELETE` | `/api/git/branch/:name` | Delete a branch |
| `POST` | `/api/git/stage` | Stage files |
| `POST` | `/api/git/unstage` | Unstage files |
| `POST` | `/api/git/commit` | Commit staged changes |
| `POST` | `/api/agent/claude` | Run Claude Code with current diff + comments |
| `POST` | `/api/agent/codex` | Run Codex with current diff + comments |

## Project Structure

```text
packages/
  cli/      CLI entrypoint and argument parsing
  core/     git diff parsing, branch ops, config, comments, prompt builder, agent runner
  server/   HTTP API server and static file handler
  web/      React + Vite review UI
```
