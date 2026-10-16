#!/bin/sh
# InfiniteOC uninstaller: stops opendaemon, removes the command shims/links and
# deletes the install directory. Stock OpenCode is never touched: your providers,
# sessions and `~/.config/opencode` stay exactly as they are.
#   sh uninstall.sh [--yes] [--remove-settings]
# On Windows, run this from Git Bash, or use uninstall.ps1 from PowerShell.
# Nothing needs administrator. Read it before running it.
#
# Environment:
#   INFINITEOC_DIR       install directory            (default $HOME/.infiniteoc)
#   INFINITEOC_BIN       where the commands were linked (default $HOME/.local/bin)
set -eu

DIR=${INFINITEOC_DIR:-$HOME/.infiniteoc}
BIN=${INFINITEOC_BIN:-$HOME/.local/bin}

say() { printf '[InfiniteOC] %s\n' "$*"; }
die() { printf '[InfiniteOC] %s\n' "$*" >&2; exit 1; }

YES=0
REMOVE_SETTINGS=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --remove-settings) REMOVE_SETTINGS=1 ;;
    *) die "Usage: uninstall.sh [--yes] [--remove-settings]" ;;
  esac
done

[ -n "$DIR" ] && [ "$DIR" != "/" ] || die "refusing to remove '$DIR'"
if [ ! -f "$DIR/bin/infiniteoc.mjs" ]; then
  die "$DIR does not look like an InfiniteOC checkout (no bin/infiniteoc.mjs); set INFINITEOC_DIR to the right path"
fi

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) WIN=1 ;;
  *) WIN=0 ;;
esac

if [ "$YES" != 1 ] && [ -t 0 ]; then
  printf '[InfiniteOC] Remove %s and its commands? [y/N] ' "$DIR"
  read -r answer
  case "$answer" in
    [Yy]*) ;;
    *) die "Not removed." ;;
  esac
fi

# Stop the daemon first; a missing or already-stopped daemon is not an error.
if [ -f "$DIR/bin/opendaemon.mjs" ] && command -v node >/dev/null 2>&1; then
  node "$DIR/bin/opendaemon.mjs" --home "$DIR" stop >/dev/null 2>&1 || true
fi

# Remove only shims/links that point at this install directory.
if [ "$WIN" = 1 ]; then
  for tool in infiniteoc opendaemon; do
    for shim in "$BIN/$tool.cmd" "$BIN/$tool"; do
      # Only our own shims, which name this install's bin/<tool>.mjs.
      if [ -f "$shim" ] && grep -q "bin.$tool\.mjs" "$shim"; then
        rm -f "$shim"
        say "Removed $shim"
      fi
    done
  done
else
  for tool in infiniteoc opendaemon; do
    if [ -L "$BIN/$tool" ] && [ "$(readlink "$BIN/$tool")" = "$DIR/bin/$tool.mjs" ]; then
      rm -f "$BIN/$tool"
      say "Removed $BIN/$tool"
    elif [ -e "$BIN/$tool" ]; then
      say "Keeping $BIN/$tool (not an InfiniteOC link)"
    fi
  done
fi

rm -rf "$DIR"
say "Removed $DIR"

if [ "$REMOVE_SETTINGS" = 1 ]; then
  rm -rf "$HOME/.config/infiniteoc"
  say "Removed $HOME/.config/infiniteoc"
else
  say "Kept $HOME/.config/infiniteoc (use --remove-settings to delete it too)"
fi
say "Stock OpenCode data was left untouched. Done."
