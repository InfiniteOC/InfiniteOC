#!/bin/sh
# InfiniteOC installer: clones (or fast-forwards) the repository and links infiniteoc and opendaemon onto your PATH.
#   curl -fsSL https://raw.githubusercontent.com/riz3y0/InfiniteOC/main/install.sh | sh
# Nothing outside the install directory and the bin directory is touched. Read it before piping it to a shell.
#
# Environment:
#   INFINITEOC_DIR       install directory            (default $HOME/.infiniteoc)
#   INFINITEOC_BIN       where the commands are linked (default $HOME/.local/bin)
#   INFINITEOC_REPO      git URL                       (default https://github.com/riz3y0/InfiniteOC.git)
#   INFINITEOC_REF       branch to track               (default main)
#   INFINITEOC_NO_LINK   1 = do not link commands (a package manager provides them)
#   INFINITEOC_NO_SETUP  1 = do not run the first build (it takes several minutes and downloads dependencies)
set -eu

DIR=${INFINITEOC_DIR:-$HOME/.infiniteoc}
BIN=${INFINITEOC_BIN:-$HOME/.local/bin}
REPO=${INFINITEOC_REPO:-https://github.com/riz3y0/InfiniteOC.git}
REF=${INFINITEOC_REF:-main}

say() { printf '[InfiniteOC] %s\n' "$*"; }
die() { printf '[InfiniteOC] %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js 22 or newer is required (https://nodejs.org)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64|Darwin-x86_64|Linux-x86_64|Linux-aarch64|Linux-arm64) ;;
  *) die "unsupported platform $(uname -s)-$(uname -m); InfiniteOC builds on macOS and Linux (x64/arm64)" ;;
esac

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" fetch --quiet origin "$REF"
  git -C "$DIR" merge --ff-only --quiet "origin/$REF" || die "$DIR has local changes or commits; update it yourself with git"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR exists and is not an InfiniteOC checkout; set INFINITEOC_DIR to another path"
else
  say "Cloning $REPO into $DIR"
  git clone --quiet --branch "$REF" "$REPO" "$DIR"
fi

if [ "${INFINITEOC_NO_LINK:-}" != 1 ]; then
  mkdir -p "$BIN"
  for tool in infiniteoc opendaemon; do
    chmod +x "$DIR/bin/$tool.mjs"
    ln -sf "$DIR/bin/$tool.mjs" "$BIN/$tool"
  done
  say "Linked infiniteoc and opendaemon in $BIN"
  case ":$PATH:" in *":$BIN:"*) ;; *) say "Add $BIN to your PATH:  export PATH=\"$BIN:\$PATH\"" ;; esac
fi

if [ "${INFINITEOC_NO_SETUP:-}" = 1 ]; then
  say "Skipping the first build. Run 'infiniteoc setup' (several minutes) or just 'infiniteoc'."
else
  say "Running the first build (several minutes; downloads Bun and OpenCode sources)"
  node "$DIR/bin/infiniteoc.mjs" setup
fi
say "Done. Run: infiniteoc"
