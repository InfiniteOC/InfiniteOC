#!/bin/sh
# InfiniteOC installer: clones (or fast-forwards) the repository, links infiniteoc
# and opendaemon onto your PATH, and runs the first build.
#   curl -fsSL https://raw.githubusercontent.com/riz3y0/InfiniteOC/main/install.sh | sh
# On Windows, run this from Git Bash (https://git-scm.com), or use install.ps1
# from PowerShell instead. Nothing outside the install directory and the bin
# directory is touched, and nothing needs administrator: everything is user-local.
# Read it before piping it to a shell.
#
# Environment:
#   INFINITEOC_DIR       install directory            (default $HOME/.infiniteoc)
#   INFINITEOC_BIN       where the commands are linked (default $HOME/.local/bin)
#   INFINITEOC_REPO      git URL                       (default https://github.com/riz3y0/InfiniteOC.git)
#   INFINITEOC_REF       branch to track               (default main)
#   INFINITEOC_NO_LINK   1 = do not link commands (a package manager provides them)
#   INFINITEOC_NO_SETUP  1 = do not run the first build (it takes several minutes and downloads dependencies)
#   INFINITEOC_PREBUILT  0 = never download a prebuilt binary; always build from source
#   INFINITEOC_VERSION   release tag for the prebuilt binary (default: latest release)
set -eu

DIR=${INFINITEOC_DIR:-$HOME/.infiniteoc}
BIN=${INFINITEOC_BIN:-$HOME/.local/bin}
REPO=${INFINITEOC_REPO:-https://github.com/riz3y0/InfiniteOC.git}
REF=${INFINITEOC_REF:-main}

say() { printf '[InfiniteOC] %s\n' "$*"; }
die() { printf '[InfiniteOC] %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required (https://git-scm.com)"
command -v node >/dev/null 2>&1 || die "Node.js 22 or newer is required (https://nodejs.org)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))"

# uname -m varies (x86_64, aarch64, arm64); uname -s on Git Bash is MINGW64_NT-*, MSYS_NT-* or CYGWIN_NT-*.
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture $ARCH; InfiniteOC runs on x64 and arm64" ;;
esac
OS=$(uname -s)
case "$OS" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT) OS=win32 ;;
  *) die "unsupported platform $OS; InfiniteOC runs on macOS, Linux and Windows (Git Bash or PowerShell)" ;;
esac
TARGET="$OS-$ARCH"
case "$TARGET" in
  linux-x64|linux-arm64|darwin-x64|darwin-arm64|win32-x64|win32-arm64) ;;
  *) die "unsupported platform $TARGET; InfiniteOC runs on Linux, macOS and Windows (x64/arm64)" ;;
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

# An install is not a development clone: nothing here is ever pushed to the InfiniteOC repository, even when
# an agent commits in it. Personal mods belong in ~/.config/infiniteoc/mods (infiniteoc feature new ID), and
# the auto-updater only fetches, so this blocks nothing it needs. git push fails with this path as the reason.
git -C "$DIR" config remote.origin.pushurl "/infiniteoc-install-is-read-only--put-personal-mods-in-~/.config/infiniteoc/mods"

if [ "${INFINITEOC_NO_LINK:-}" != 1 ]; then
  mkdir -p "$BIN"
  if [ "$OS" = win32 ]; then
    # No symlinks (they need elevation or Developer Mode): shims instead. cmd.exe
    # needs a Windows path (node reads /c/Users/... as C:\c\Users\...), and Git Bash
    # does not run .cmd files by their bare name, so it gets an sh shim as well.
    WINDIR=$(cygpath -w "$DIR" 2>/dev/null || printf '%s' "$DIR")
    for tool in infiniteoc opendaemon; do
      printf '@echo off\r\nnode "%s\\bin\\%s.mjs" %%*\r\n' "$WINDIR" "$tool" > "$BIN/$tool.cmd"
      printf '#!/bin/sh\nexec node "%s/bin/%s.mjs" "$@"\n' "$DIR" "$tool" > "$BIN/$tool"
      chmod +x "$BIN/$tool"
    done
    say "Created infiniteoc and opendaemon shims (.cmd and sh) in $BIN"
  else
    for tool in infiniteoc opendaemon; do
      chmod +x "$DIR/bin/$tool.mjs"
      ln -sf "$DIR/bin/$tool.mjs" "$BIN/$tool"
    done
    say "Linked infiniteoc and opendaemon in $BIN"
  fi
  case ":$PATH:" in *":$BIN:"*) ;; *) say "Add $BIN to your PATH:  export PATH=\"$BIN:\$PATH\"" ;; esac
fi

# A prebuilt binary makes the first run instant; without one (or with
# INFINITEOC_PREBUILT=0) the launcher builds from source, which takes several
# minutes and downloads Bun and the OpenCode sources.
if [ "${INFINITEOC_NO_SETUP:-}" = 1 ]; then
  say "Skipping the first build. Run 'infiniteoc setup' (several minutes) or just 'infiniteoc'."
elif [ "${INFINITEOC_PREBUILT:-}" != 0 ] && node "$DIR/scripts/fetch-prebuilt.mjs" "$TARGET" ${INFINITEOC_VERSION:+--tag "$INFINITEOC_VERSION"}; then
  say "Installed a prebuilt binary for $TARGET."
  say "Running a verification build check (fast when the prebuilt binary is fresh)"
  node "$DIR/bin/infiniteoc.mjs" setup
else
  if [ "${INFINITEOC_PREBUILT:-}" != 0 ]; then
    say "No prebuilt binary for $TARGET; building from source instead"
  fi
  say "Running the first build (several minutes; downloads Bun and OpenCode sources)"
  node "$DIR/bin/infiniteoc.mjs" setup
fi
say "Done. Run: infiniteoc"
