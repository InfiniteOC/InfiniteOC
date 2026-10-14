# Agent display

The agent's own isolated screen: an Xvfb X server (default `:99`), never the
user's `:0`/Wayland session. The agent spawns programs there, drives their
windows, screenshots what it did, and shares frames (or a live watch page) with
the user without ever touching the user's computer usage.

## What the agent gets

One tool, `agent_display` (permission `agent_display`):

| Action | What it does |
| --- | --- |
| `status` | Is the display running, which apps, is the live view on |
| `start` / `stop` | Manage Xvfb (start is automatic on first use) |
| `exec` | Spawn a program on `:99` (project directory, `WAYLAND_DISPLAY` unset) |
| `win` | `list`, `focus`, `move`, `resize`, `click`, `type`, `key`, `close` windows by id or title fragment (xdotool) |
| `screenshot` | See the screen (PNG frame back as an image; costs tokens, use sparingly) |
| `show` | Screenshot plus a user-visible toast; the frame lands in the transcript (`<leader>i` views images). With `live: true` it also starts the watch page and opens it in the user's browser |
| `stream` | Live MJPEG watch page on `127.0.0.1` only (~10fps) |

`exec`, `win`, `stream` and `show` with `live` go through the normal `shell`
permission, so `/readonly`, allow-lists and yolo apply unchanged. Safe-guard's
`/readonly` refuses exactly those mutating actions; looking (`status`,
`screenshot`, plain `show`) stays allowed like any other read.

Needs Linux with `Xvfb` (xorg-server-xvfb), plus `import` (ImageMagick) or
`ffmpeg` for screenshots, `xdotool` for window control, `ffmpeg` for the live
view. Everything is preinstalled on the dev machine; elsewhere the tool fails
with what is missing instead of pretending. There is no window manager
installed, so windows have no decorations and focusing warns — `move`/`resize`/
`click`/`type`/`key` still work through X11 directly. Chromium on a Wayland box
needs `--ozone-platform=x11` (it otherwise tries Wayland and exits).

## What the user gets

- `/display`: status, latest frame (path, time, agent note, live URL), stop.
  Stopping only stops the virtual screen; sessions and tasks keep going.
- Frames the agent shares appear in the session transcript.
- The live page is loopback-only and stops with the display.

State lives outside the project and outside session history:
`~/.local/share/infiniteoc/agent-display/` (`status.json`, `frame.png`).
