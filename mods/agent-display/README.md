# Agent display

The agent's own isolated screen: an Xvfb X server (default `:99`), never the
user's `:0`/Wayland session. The agent spawns programs there, drives their
windows, screenshots what it did, and shares frames (or a live watch page) with
the user without ever touching the user's computer usage.

## What the agent gets

One tool, `agent_display` (permission `agent_display`), built for few round trips:

| Action | What it does |
| --- | --- |
| `exec` | Start a program on `:99` (project directory, `WAYLAND_DISPLAY` unset, extra env via `env`) and wait up to `timeout` seconds (default 10, 0 skips) for its window; returns the new window's `id: title \| class \| WxH+X+Y`. A program that crashes first fails with the end of its log |
| `steps` | Run up to 50 input ops in order in one call, stopping at the first failure (all validated before any runs) |
| `win` | Run one op |
| `screenshot` | The whole screen, or one window via `window` (id or fragment); the text lists windows and the pointer |
| `show` | Screenshot plus a toast for the user; with `live: true` also opens the watch page |
| `status` | Display, apps (dead ones pruned), open windows, live view |
| `kill` | Stop a spawned app by its pid from `status` (SIGTERM) |
| `stream` | Live watch page on `127.0.0.1` only (30fps, with what the agent is doing overlaid) |
| `start` / `stop` | Manage Xvfb (start is automatic on first use and waits for the socket, not a fixed delay) |

`screenshot: true` on `exec`, `win` or `steps` returns the screen in the same call.

Ops (`win` with `op`, or each item of `steps`): `click` (x/y optional, `button`, `count` 2 = double),
`mousedown`, `mouseup`, `mousemove`, `scroll` (`button` 4 up / 5 down / 6 left / 7 right, `count`),
`drag` (x,y to x2,y2, with intermediate motion), `type` (`text`), `key` / `keydown` / `keyup`
(`keys`: keysyms, space separated, e.g. `"ctrl+a BackSpace"`), `focus`, `move`, `resize`, `close`,
`list` (optional regex), `wait` (until a window appears, `timeout`), `sleep` (`ms`).

- **Coordinates match screenshots.** Without `window`, x/y are screen pixels, the pixels of a full
  screenshot. With `window` (an id, or a title/class fragment that resolves to the largest matching
  window), they are window-relative, the pixels of that window's screenshot.
- **Input is real XTEST input**, like a physical mouse and keyboard. `xdotool --window` sends synthetic
  events that Chromium drops, so it is only used to position the pointer. Keyboard ops with a window
  focus it first; a click moves keyboard focus to what it hit, since there is no window manager.
- `mousemove --sync` is never used: it hangs when the pointer is already on the target (clicking the
  same spot twice).
- The root window and 1x1 helper windows are filtered out of lists and fragment matches.

`exec`, `kill`, `stream`, `show` with `live` and every op except `list`/`wait`/`sleep` go through the
normal `shell` permission, so `/readonly`, allow-lists and yolo apply unchanged. Input is asked as
`agent display input <summary>`, and "always" saves `agent display input *`: one approval covers later
input on the agent's own screen. `exec` saves `<command> *`, like the shell tool does. Safe-guard's
`/readonly` refuses those mutating actions; looking (`status`, `screenshot`, plain `show`,
`list`/`wait`/`sleep`) stays allowed. Only pids tracked in Apps are ever signalled.

## A desktop, not a bare X server

With `openbox` and `tint2` installed (`pacman -S openbox tint2`), the screen starts as a small
desktop: a generated wallpaper, openbox in a flat dark InfiniteOC theme (title bars with working
close/maximize/minimize buttons, smart placement, click to focus, alt+F4, alt+Tab), and a tint2
taskbar in the bottom 36px with an agent badge, the open windows and a clock. Apps get the Adwaita
cursor theme. There is no desktop menu, so nothing on screen launches programs the tool does not
track. Config, theme and wallpaper are generated under the data directory (`desktop/`).

With a window manager, `focus` activates (`windowactivate`), keyboard ops activate their window
first, clicks leave focus to openbox (focusing by hand would hit its frame window), and `close` asks
the app to close (`windowquit`). Without one (`INFINITEOC_AGENT_DESKTOP=0`, or the packages missing)
the screen is bare X: `focus` raises and focuses, `close` destroys the window, clicks set focus.
`status` says which.

## Live view

`stream` (or `show` with `live: true`) serves a page on `127.0.0.1` with an OS-assigned port. One
ffmpeg capture (30fps, cursor drawn in, `mpjpeg` split by Content-length so frames never tear) is
shared by every open page and runs only while one is open; a viewer that falls behind skips frames
instead of lagging. Requests whose `Host` is not `127.0.0.1`/`localhost` on that port get 403 (DNS
rebinding). The page overlays what the agent does from `/events` (server-sent events): a caption
("Clicking in …", "Typing “…”"), click ripples, drag trails, a typing/keys bubble and a flash when it
takes a screenshot.

## Realistic input (off by default)

`/display` → **Realistic input** toggles it, saved in `settings.json` in the data directory and read
by the server on every action, so it applies from the agent's next action without a restart. On, input
moves like a person: the pointer glides from where it is on an eased, slightly curved path
(~170-720ms, ~83 moves a second), presses take 50ms and land 70ms after arriving, typing runs at 38ms
a character (up to 400 characters), keys 110ms apart, and steps pause 220ms between actions. Off (the
default), everything is instant: the same 7 steps take ≈ 0.8s instead of ≈ 4.8s. `status` shows which.

Needs Linux with `Xvfb` (xorg-server-xvfb), `xdotool` for windows and input, `import` (ImageMagick)
or `ffmpeg` for screenshots (`import` is ~60ms; window captures need it), `ffmpeg` for the live view;
optionally `openbox` + `tint2` for the desktop, `magick`/`display` for the wallpaper, `xprop` to see
when openbox is ready. Elsewhere the tool fails with what is missing. Chromium on a Wayland box
needs `--ozone-platform=x11` and joins a running instance by default: pass a fresh
`--user-data-dir` per spawn (`exec` reports when the window came from an instance already running).

## Share or record it

- **Virtual camera** (`/display` → Virtual camera): the screen as a webcam named “InfiniteOC agent
  display”, 1280x720 (the 16:10 screen with dark side bars), 30fps, pointer included. Pick it in
  Discord (Settings → Voice & Video → Camera, or turn on your camera in a call), OBS (Video Capture
  Device) or a browser. It needs the `v4l2loopback` kernel module (in-tree on CachyOS kernels,
  `v4l2loopback-dkms` elsewhere), loaded as root once per boot; the toggle offers to load it through
  `pkexec`, or run `sudo modprobe v4l2loopback video_nr=42 card_label="InfiniteOC agent display"
  exclusive_caps=1` (`exclusive_caps` is what makes Chromium-based apps such as Discord list it). The
  choice is saved: the feed starts with the display and comes back whenever it restarts. To load the
  module at boot, put `v4l2loopback` in `/etc/modules-load.d/v4l2loopback.conf` and the options in
  `/etc/modprobe.d/v4l2loopback.conf` as `options v4l2loopback video_nr=42 card_label="InfiniteOC agent display" exclusive_caps=1`.
- **Recording** (`/display` → Record the screen / Stop recording): H.264 MP4 in your videos folder
  (`XDG_VIDEOS_DIR` / `user-dirs.dirs`, else `~/Videos`), named `agent-display-<date>_<time>.mp4`.
  Stopping sends SIGINT so ffmpeg finishes the file; it is fragmented with a keyframe every 2s and
  flushed as it goes, so a recording cut off by the display stopping loses at most its last 2s.
- **With the overlays** (captions, click ripples, typing): open the live page with `/?clean`, which
  is only the screen filling the window, and share that window with Discord's Go Live or capture it
  in OBS. The camera and recordings carry the raw screen.

## What the user gets

- `/display`: status, latest frame (path, time, agent note, live URL), the realistic
  input and virtual camera toggles, recording, spawned apps (aliveness, log path, kill), stop.
  Stopping only stops the virtual screen; sessions and tasks keep going.
- Frames the agent shares appear in the session transcript.
- The live page (`/display` → Latest frame shows its URL) is loopback-only and stops with the display.

State lives outside the project and outside session history:
`~/.local/share/infiniteoc/agent-display/` (`status.json`, `settings.json`, `frame.png`, `desktop/`).
