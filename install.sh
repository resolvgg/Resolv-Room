#!/bin/sh
# Resolv Room installer.
#
#   curl -fsSL https://raw.githubusercontent.com/resolvgg/Resolv-Room/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/resolvgg/Resolv-Room/main/install.sh | sh -s -- --yes
#
# What it does: checks Node 22+ and git, downloads the source into ~/.resolvroom/src, builds it, puts a
# `resolvroom` command in ~/.local/bin and starts `resolvroom init`. It never uses sudo and never touches
# your Tailscale settings or agent configs by itself; `init` asks before each of those.
# Everything after "-s --" is passed to `resolvroom init`.
#
# Overrides (mostly for testing): RESOLVROOM_REPO, RESOLVROOM_REF, RESOLVROOM_INSTALL_DIR, RESOLVROOM_BIN_DIR,
# RESOLVROOM_NO_INIT=1.
set -eu

REPO="${RESOLVROOM_REPO:-https://github.com/resolvgg/Resolv-Room.git}"
REF="${RESOLVROOM_REF:-main}"
DIR="${RESOLVROOM_INSTALL_DIR:-$HOME/.resolvroom/src}"
BIN_DIR="${RESOLVROOM_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

say "Resolv Room installer"
say "  source:  $REPO ($REF)"
say "  into:    $DIR"
say "  command: $BIN_DIR/resolvroom"
say ""

# --- requirements ---------------------------------------------------------
command -v git >/dev/null 2>&1 || die "git is required. Install it and run this again."
command -v node >/dev/null 2>&1 || die "Node.js 22 or newer is required: https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || die "Node.js 22 or newer is required (found $(node -v)): https://nodejs.org"

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if command -v pnpm >/dev/null 2>&1; then
  :
elif command -v corepack >/dev/null 2>&1; then
  # The project's scripts call `pnpm` themselves, so it must exist on PATH: use a temporary shim.
  SHIM="$(mktemp -d)"
  trap 'rm -rf "$SHIM"' EXIT
  printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > "$SHIM/pnpm"
  chmod +x "$SHIM/pnpm"
  PATH="$SHIM:$PATH"
  export PATH
else
  die "pnpm is required. Install it with:  npm install -g pnpm   (then run this again)"
fi
pn() { pnpm "$@"; }

# --- download -------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "Updating the existing copy..."
  git -C "$DIR" fetch --quiet origin "$REF"
  git -C "$DIR" reset --quiet --hard FETCH_HEAD
else
  say "Downloading..."
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --branch "$REF" "$REPO" "$DIR"
fi

# --- build ----------------------------------------------------------------
say "Installing dependencies and building (a minute or two)..."
LOG="$(mktemp 2>/dev/null || echo /tmp/resolvroom-install.log)"
if ! ( cd "$DIR" && pn install --frozen-lockfile && pn build ) >"$LOG" 2>&1; then
  tail -n 25 "$LOG" >&2
  die "the build failed. Full log: $LOG"
fi
rm -f "$LOG"

# --- command --------------------------------------------------------------
BIN="$DIR/apps/resolvroom/dist/bin.js"
[ -f "$BIN" ] || die "build finished but $BIN is missing"
chmod +x "$BIN"
mkdir -p "$BIN_DIR"
ln -sf "$BIN" "$BIN_DIR/resolvroom"
say "Installed: $BIN_DIR/resolvroom"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say ""
     say "Note: $BIN_DIR is not in your PATH. Add this to your shell profile:"
     say "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# --- onboarding -----------------------------------------------------------
if [ "${RESOLVROOM_NO_INIT:-}" = "1" ]; then
  say ""
  say "Skipping onboarding. Run:  resolvroom init"
  exit 0
fi

say ""
say "Starting the guided setup (resolvroom init)..."
say ""
# When piped from curl, stdin is the script itself; give init the real terminal.
if { true < /dev/tty; } 2>/dev/null; then
  [ -n "${SHIM:-}" ] && rm -rf "$SHIM"
  exec "$BIN_DIR/resolvroom" init "$@" < /dev/tty
fi
say "No terminal available here. Run this yourself:  resolvroom init"
