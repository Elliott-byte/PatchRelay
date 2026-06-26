#!/usr/bin/env bash
#
# PatchRelay one-click installer.
#
#   Remote:  curl -fsSL https://raw.githubusercontent.com/Elliott-byte/PatchRelay/main/scripts/install.sh | bash
#   Local:   ./scripts/install.sh        (run from a checkout — builds in place)
#
# Clones (if needed), installs dependencies, builds every package, and links the
# `patchrelay` command globally. Override the clone location with PATCHRELAY_DIR.
#
set -euo pipefail

REPO_URL="https://github.com/Elliott-byte/PatchRelay.git"
INSTALL_DIR="${PATCHRELAY_DIR:-$HOME/.patchrelay-app}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  \033[36m›\033[0m %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

bold "PatchRelay installer"

# --- prerequisites ----------------------------------------------------------
command -v git  >/dev/null 2>&1 || die "git is required but not found."
command -v node >/dev/null 2>&1 || die "Node.js 18+ is required but not found."
command -v npm  >/dev/null 2>&1 || die "npm is required but not found."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18+ required (found $(node -v))."
ok "node $(node -v), npm $(npm -v)"

# --- locate or fetch the source ---------------------------------------------
# Run from inside a checkout? Build in place. Otherwise clone to INSTALL_DIR.
if [ -f "package.json" ] && node -p "require('./package.json').name" 2>/dev/null | grep -qx "patchrelay"; then
  ROOT="$(pwd)"
  info "Using existing checkout: $ROOT"
else
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating existing install at $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only
  else
    info "Cloning into $INSTALL_DIR"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
  ROOT="$INSTALL_DIR"
fi

cd "$ROOT"

# --- install + build --------------------------------------------------------
info "Installing dependencies (npm ci)…"
npm ci >/dev/null 2>&1 || npm install
ok "dependencies installed"

info "Building all packages…"
npm run build >/dev/null
ok "build complete"

# --- expose the CLI globally (best effort) ----------------------------------
if npm link -w @patchrelay/cli >/dev/null 2>&1; then
  ok "linked the 'patchrelay' command globally"
  LAUNCH="patchrelay"
else
  info "Could not link globally (permissions?). Launch from this folder instead."
  LAUNCH="npm start"
fi

echo
bold "Done. Start it from any git repository:"
echo
info "$LAUNCH"
echo
info "Then open http://127.0.0.1:5173 (dev) or the URL it prints."
