#!/bin/sh
# InfiniteOC installer: clones (or fast-forwards) the repository, links infiniteoc
# and opendaemon onto your PATH, and runs the first build.
#
# The repository is private: only people the owner invited can install it, and
# cloning needs credentials. The GitHub CLI is the easiest source of them:
#   gh auth login
#   gh api -H "Accept: application/vnd.github.raw" \
#     /repos/InfiniteOC/InfiniteOC/contents/install.sh | sh        # read it first
# or clone first and run the copy you can read:
#   gh repo clone InfiniteOC/InfiniteOC ~/.infiniteoc && sh ~/.infiniteoc/install.sh
# GH_TOKEN/GITHUB_TOKEN work with gh too. On Windows, run this from Git Bash
# (https://git-scm.com), or use install.ps1 from PowerShell instead. Nothing
# outside the install directory and the bin directory is touched, and nothing
# needs administrator: everything is user-local. Read it before piping it to a shell.
#
# Environment:
#   INFINITEOC_DIR       install directory            (default $HOME/.infiniteoc)
#   INFINITEOC_BIN       where the commands are linked (default $HOME/.local/bin)
#   INFINITEOC_REPO      git URL                       (default https://github.com/InfiniteOC/InfiniteOC.git)
#   INFINITEOC_REF       branch to track               (default main)
#   INFINITEOC_NO_LINK   1 = do not link commands (a package manager provides them)
#   INFINITEOC_NO_SETUP  1 = do not run the first build (it takes several minutes and downloads dependencies)
#   INFINITEOC_PREBUILT  0 = never download a prebuilt binary; always build from source
#   INFINITEOC_VERSION   release tag for the prebuilt binary (default: latest release)
set -eu

DIR=${INFINITEOC_DIR:-$HOME/.infiniteoc}
BIN=${INFINITEOC_BIN:-$HOME/.local/bin}
REPO=${INFINITEOC_REPO:-https://github.com/InfiniteOC/InfiniteOC.git}
REF=${INFINITEOC_REF:-main}

# Colors and a spinner on a terminal (not with NO_COLOR or TERM=dumb); plain [InfiniteOC] lines otherwise.
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
  FX=1 P=$(printf '\033[38;2;192;132;252m') K=$(printf '\033[38;2;244;114;182m') G=$(printf '\033[38;2;134;239;172m') R=$(printf '\033[38;2;252;165;165m') D=$(printf '\033[2m') N=$(printf '\033[0m')
else
  FX=0 P='' K='' G='' R='' D='' N=''
fi
say() { if [ "$FX" = 1 ]; then printf '%s◆%s %s\n' "$P" "$N" "$*"; else printf '[InfiniteOC] %s\n' "$*"; fi; }
die() { if [ "$FX" = 1 ]; then printf '%s✗%s %s\n' "$R" "$N" "$*" >&2; else printf '[InfiniteOC] %s\n' "$*" >&2; fi; exit 1; }
# step LABEL COMMAND...: runs COMMAND with its output in a log, behind a spinner on a terminal. Ends with a
# check mark, or a cross and the log's last lines (then returns COMMAND's status).
step() {
  label=$1; shift
  log=$(mktemp "${TMPDIR:-/tmp}/infiniteoc-install.XXXXXX")
  if [ "$FX" = 1 ]; then
    "$@" >"$log" 2>&1 &
    pid=$! i=0
    printf '\033[?25l' >&2
    while kill -0 "$pid" 2>/dev/null; do
      case $((i % 10)) in 0) f=⠋ ;; 1) f=⠙ ;; 2) f=⠹ ;; 3) f=⠸ ;; 4) f=⠼ ;; 5) f=⠴ ;; 6) f=⠦ ;; 7) f=⠧ ;; 8) f=⠇ ;; *) f=⠏ ;; esac
      printf '\r\033[2K%s%s%s %s %s%ss%s' "$K" "$f" "$N" "$label" "$D" "$((i / 10))" "$N" >&2
      i=$((i + 1))
      sleep 0.1
    done
    if wait "$pid"; then code=0; else code=$?; fi
    printf '\r\033[2K\033[?25h' >&2
  else
    printf '[InfiniteOC] %s...\n' "$label" >&2
    if "$@" >"$log" 2>&1; then code=0; else code=$?; fi
  fi
  if [ "$code" = 0 ]; then
    if [ "$FX" = 1 ]; then printf '%s✓%s %s\n' "$G" "$N" "$label" >&2; fi
  else
    if [ "$FX" = 1 ]; then printf '%s✗%s %s\n' "$R" "$N" "$label" >&2; else printf '[InfiniteOC] %s failed\n' "$label" >&2; fi
    tail -n 15 "$log" | sed "s/^/  $D/;s/\$/$N/" >&2
  fi
  rm -f "$log"
  return "$code"
}
[ "$FX" = 1 ] && printf '\n%s◆ Infinite%sOC%s %sinstaller%s\n\n' "$P" "$K" "$N" "$D" "$N"

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

# The repository is private, so cloning and updating need credentials. When the
# GitHub CLI is installed and signed in (gh auth login), wire it into git's
# credential helper so plain git clone/fetch authenticate; gh uses
# GH_TOKEN/GITHUB_TOKEN too. Otherwise git needs its own credentials (a
# credential helper, or INFINITEOC_REPO set to an SSH URL).
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh auth setup-git >/dev/null 2>&1 || true
fi

if [ -d "$DIR/.git" ]; then
  # InfiniteOC's own updater: it fetches a moved OpenCode pin before the code moves, rebuilds, and rolls back to
  # the previous version if the new one does not build.
  say "Updating $DIR"
  node "$DIR/bin/infiniteoc.mjs" update || die "update failed; $DIR is unchanged or back on its previous version (see above)"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR exists and is not an InfiniteOC checkout; set INFINITEOC_DIR to another path"
else
  step "Cloning $REPO into $DIR" git clone --quiet --branch "$REF" "$REPO" "$DIR" ||
    die "clone failed: $REPO is private; run 'gh auth login' (then 'gh auth setup-git'), set GH_TOKEN, or set INFINITEOC_REPO to an SSH URL"
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
