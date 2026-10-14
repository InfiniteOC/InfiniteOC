// InfiniteOC agent display: the desktop on the agent's screen, so it looks and behaves like a
// computer. openbox gives windows title bars, placement, focus and graceful closing; tint2 is a
// taskbar with a clock; the wallpaper is generated once with ImageMagick. All optional: without
// them the screen is bare X and every tool action still works. Pure: config text and argv only.
import path from "node:path"

export const WM = "openbox"
export const PANEL = "tint2"
export const PANEL_HEIGHT = 36
export const FONT = "Inter"
// Arrow and text cursors from a real cursor theme instead of X's core bitmap cursors.
export const CURSOR = { XCURSOR_THEME: "Adwaita", XCURSOR_SIZE: "24" }

export const desktopDir = (dataDir: string) => path.join(dataDir, "desktop")
export const desktopFiles = (dataDir: string) => {
  const dir = desktopDir(dataDir)
  return {
    dir,
    // openbox finds themes under $XDG_DATA_HOME/themes; its XDG_DATA_HOME is this directory.
    theme: path.join(dir, "themes", "InfiniteOC", "openbox-3", "themerc"),
    openbox: path.join(dir, "openbox.xml"),
    tint2: path.join(dir, "tint2rc"),
    wallpaper: path.join(dir, "wallpaper.png"),
  }
}

/** Deep night gradient with InfiniteOC purple and pink glows. */
export function wallpaperArgs(file: string, width: number, height: number): string[] {
  const glow = (size: number, color: string, x: number, y: number) => [
    "(",
    "-size",
    `${size}x${size}`,
    `radial-gradient:${color}-none`,
    ")",
    "-geometry",
    `+${x}+${y}`,
    "-compose",
    "screen",
    "-composite",
  ]
  return [
    "-size",
    `${width}x${height}`,
    "gradient:#120f24-#07060d",
    ...glow(Math.round(width * 1.1), "#3b2470", Math.round(-width * 0.35), Math.round(-height * 0.55)),
    ...glow(Math.round(width * 0.9), "#5a1f4c", Math.round(width * 0.5), Math.round(height * 0.35)),
    ...glow(Math.round(width * 0.45), "#2a2f6b", Math.round(width * 0.05), Math.round(height * 0.55)),
    "-compose",
    "over",
    "-depth",
    "8",
    file,
  ]
}

/** A flat dark openbox theme in InfiniteOC colors. */
export function openboxTheme(): string {
  const rows: Record<string, string> = {
    "border.width": "1",
    "padding.width": "10",
    "padding.height": "7",
    "window.handle.width": "0",
    "window.client.padding.width": "0",
    "window.client.padding.height": "0",
    "window.label.text.justify": "center",
    "window.active.border.color": "#4c3d7a",
    "window.inactive.border.color": "#24212f",
    "window.active.title.separator.color": "#2a2540",
    "window.inactive.title.separator.color": "#1c1a26",
    "window.active.title.bg": "flat solid",
    "window.active.title.bg.color": "#1d1a2b",
    "window.inactive.title.bg": "flat solid",
    "window.inactive.title.bg.color": "#15141d",
    "window.active.label.bg": "parentrelative",
    "window.inactive.label.bg": "parentrelative",
    "window.active.label.text.color": "#f1edff",
    "window.inactive.label.text.color": "#7d7896",
    "window.active.handle.bg": "flat solid",
    "window.active.handle.bg.color": "#1d1a2b",
    "window.inactive.handle.bg": "flat solid",
    "window.inactive.handle.bg.color": "#15141d",
    "window.active.grip.bg": "flat solid",
    "window.active.grip.bg.color": "#1d1a2b",
    "window.inactive.grip.bg": "flat solid",
    "window.inactive.grip.bg.color": "#15141d",
    "window.active.button.unpressed.bg": "parentrelative",
    "window.active.button.unpressed.image.color": "#c4bce3",
    "window.active.button.hover.bg": "flat solid",
    "window.active.button.hover.bg.color": "#332d4d",
    "window.active.button.hover.image.color": "#ffffff",
    "window.active.button.pressed.bg": "flat solid",
    "window.active.button.pressed.bg.color": "#7c5cff",
    "window.active.button.pressed.image.color": "#ffffff",
    "window.active.button.disabled.bg": "parentrelative",
    "window.active.button.disabled.image.color": "#4a4560",
    "window.active.button.toggled.bg": "parentrelative",
    "window.active.button.toggled.image.color": "#c4bce3",
    "window.inactive.button.unpressed.bg": "parentrelative",
    "window.inactive.button.unpressed.image.color": "#5f5a78",
    "window.inactive.button.hover.bg": "flat solid",
    "window.inactive.button.hover.bg.color": "#26232f",
    "window.inactive.button.hover.image.color": "#c4bce3",
    "window.inactive.button.pressed.bg": "flat solid",
    "window.inactive.button.pressed.bg.color": "#7c5cff",
    "window.inactive.button.pressed.image.color": "#ffffff",
    "window.inactive.button.disabled.bg": "parentrelative",
    "window.inactive.button.disabled.image.color": "#3a3648",
    "window.inactive.button.toggled.bg": "parentrelative",
    "window.inactive.button.toggled.image.color": "#5f5a78",
    "menu.border.width": "1",
    "menu.border.color": "#3a3155",
    "menu.separator.color": "#2c2840",
    "menu.title.bg": "flat solid",
    "menu.title.bg.color": "#1d1a2b",
    "menu.title.text.color": "#f1edff",
    "menu.items.bg": "flat solid",
    "menu.items.bg.color": "#16141f",
    "menu.items.text.color": "#e4def8",
    "menu.items.disabled.text.color": "#5f5a78",
    "menu.items.active.bg": "flat solid",
    "menu.items.active.bg.color": "#7c5cff",
    "menu.items.active.text.color": "#ffffff",
    "osd.border.width": "1",
    "osd.border.color": "#3a3155",
    "osd.bg": "flat solid",
    "osd.bg.color": "#16141f",
    "osd.label.bg": "parentrelative",
    "osd.label.text.color": "#f1edff",
    "osd.hilight.bg": "flat solid",
    "osd.hilight.bg.color": "#7c5cff",
    "osd.unhilight.bg": "flat solid",
    "osd.unhilight.bg.color": "#2c2840",
  }
  return Object.entries(rows)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n") + "\n"
}

const bind = (button: string, action: string, ...actions: string[]) =>
  `<mousebind button="${button}" action="${action}">${actions.map((name) => (name.startsWith("<") ? name : `<action name="${name}"/>`)).join("")}</mousebind>`
const resize = (edge?: string) => `<action name="Resize">${edge ? `<edge>${edge}</edge>` : ""}</action>`

/** openbox rc.xml: click to focus, smart placement, new windows focused, the usual title bar buttons
 * and edges, alt+F4 / alt+Tab. No root menu: nothing on the desktop launches untracked programs. */
export function openboxConfig(): string {
  const font = (place: string, weight: string, size: number) =>
    `<font place="${place}"><name>${FONT}</name><size>${size}</size><weight>${weight}</weight><slant>Normal</slant></font>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc" xmlns:xi="http://www.w3.org/2001/XInclude">
<resistance><strength>10</strength><screen_edge_strength>20</screen_edge_strength></resistance>
<focus><focusNew>yes</focusNew><followMouse>no</followMouse><focusLast>yes</focusLast><raiseOnFocus>no</raiseOnFocus></focus>
<placement><policy>Smart</policy><center>yes</center><monitor>Primary</monitor></placement>
<theme><name>InfiniteOC</name><titleLayout>NLIMC</titleLayout><keepBorder>yes</keepBorder><animateIconify>yes</animateIconify>
${font("ActiveWindow", "Bold", 10)}${font("InactiveWindow", "Bold", 10)}${font("MenuHeader", "Bold", 10)}${font("MenuItem", "Normal", 10)}${font("ActiveOnScreenDisplay", "Bold", 10)}${font("InactiveOnScreenDisplay", "Bold", 10)}
</theme>
<desktops><number>1</number><firstdesk>1</firstdesk><names><name>Desktop</name></names><popupTime>0</popupTime></desktops>
<resize><drawContents>yes</drawContents><popupShow>Nonpixel</popupShow></resize>
<margins><top>0</top><bottom>0</bottom><left>0</left><right>0</right></margins>
<keyboard>
<keybind key="A-F4"><action name="Close"/></keybind>
<keybind key="A-Tab"><action name="NextWindow"><finalactions><action name="Focus"/><action name="Raise"/><action name="Unshade"/></finalactions></action></keybind>
<keybind key="A-S-Tab"><action name="PreviousWindow"><finalactions><action name="Focus"/><action name="Raise"/><action name="Unshade"/></finalactions></action></keybind>
</keyboard>
<mouse><dragThreshold>3</dragThreshold><doubleClickTime>400</doubleClickTime><screenEdgeWarpTime>0</screenEdgeWarpTime>
<context name="Frame">${bind("A-Left", "Press", "Focus", "Raise")}${bind("A-Left", "Drag", "<action name=\"Move\"/>")}</context>
<context name="Titlebar">${bind("Left", "Drag", "<action name=\"Move\"/>")}${bind("Left", "DoubleClick", "ToggleMaximize")}</context>
<context name="Titlebar Top Right Bottom Left TLCorner TRCorner BRCorner BLCorner">${bind("Left", "Press", "Focus", "Raise", "Unshade")}</context>
<context name="Top">${bind("Left", "Drag", resize("top"))}</context>
<context name="Left">${bind("Left", "Drag", resize("left"))}</context>
<context name="Right">${bind("Left", "Drag", resize("right"))}</context>
<context name="Bottom">${bind("Left", "Drag", resize("bottom"))}</context>
<context name="TRCorner BRCorner TLCorner BLCorner">${bind("Left", "Drag", resize())}</context>
<context name="Client">${bind("Left", "Press", "Focus", "Raise")}${bind("Middle", "Press", "Focus", "Raise")}${bind("Right", "Press", "Focus", "Raise")}</context>
<context name="Icon">${bind("Left", "Press", "Focus", "Raise", "Unshade")}</context>
<context name="AllDesktops">${bind("Left", "Press", "Focus", "Raise", "Unshade")}</context>
<context name="Close">${bind("Left", "Press", "Focus", "Raise", "Unshade")}${bind("Left", "Click", "Close")}</context>
<context name="Maximize">${bind("Left", "Press", "Focus", "Raise", "Unshade")}${bind("Left", "Click", "ToggleMaximize")}</context>
<context name="Iconify">${bind("Left", "Press", "Focus", "Raise")}${bind("Left", "Click", "Iconify")}</context>
</mouse>
<menu><file>menu.xml</file><hideDelay>200</hideDelay><middle>no</middle><submenuShowDelay>100</submenuShowDelay><applicationIcons>yes</applicationIcons></menu>
<applications><application class="*"><decor>yes</decor></application></applications>
</openbox_config>
`
}

/** tint2: a dark taskbar at the bottom with an agent badge, the open windows and a clock. */
export function tint2Config(): string {
  return `# InfiniteOC agent desktop taskbar (generated)
# 1 panel
rounded = 0
border_width = 0
background_color = #0f0d18 92
border_color = #000000 0
border_sides = T
# 2 task
rounded = 7
border_width = 0
background_color = #ffffff 5
border_color = #000000 0
background_color_hover = #ffffff 11
border_color_hover = #000000 0
# 3 active task
rounded = 7
border_width = 1
background_color = #7c5cff 30
border_color = #a48bff 55
background_color_hover = #7c5cff 40
border_color_hover = #a48bff 70
# 4 badge
rounded = 7
border_width = 0
background_color = #c084fc 16
border_color = #000000 0

panel_items = PTC
panel_monitor = all
panel_position = bottom center horizontal
panel_size = 100% ${PANEL_HEIGHT}
panel_margin = 0 0
panel_padding = 8 5 10
panel_background_id = 1
panel_layer = top
panel_dock = 0
wm_menu = 0
strut_policy = follow_size
autohide = 0
font_shadow = 0
disable_transparency = 1
mouse_effects = 1
mouse_hover_icon_asb = 100 0 12
mouse_pressed_icon_asb = 100 0 -8

taskbar_mode = single_desktop
taskbar_padding = 0 0 6
taskbar_background_id = 0
taskbar_active_background_id = 0
taskbar_name = 0
taskbar_hide_if_empty = 0
taskbar_distribute_size = 0

task_text = 1
task_icon = 1
task_centered = 0
task_maximum_size = 230 ${PANEL_HEIGHT - 10}
task_padding = 9 3 7
task_font = ${FONT} 9
task_font_color = #cfc8ee 100
task_active_font_color = #ffffff 100
task_iconified_font_color = #7d7896 100
task_background_id = 2
task_active_background_id = 3
task_iconified_background_id = 2
task_urgent_background_id = 3
task_tooltip = 0
mouse_left = toggle_iconify
mouse_middle = none
mouse_right = none
mouse_scroll_up = none
mouse_scroll_down = none

button = new
button_text = ◆  agent
button_font = ${FONT} Bold 9
button_font_color = #ead9ff 100
button_padding = 10 3
button_background_id = 4
button_centered = 1

time1_format = %H:%M
time2_format = %a %d %b
time1_font = ${FONT} Bold 9
time2_font = ${FONT} 8
clock_font_color = #ece8ff 100
clock_padding = 6 0
clock_background_id = 0
clock_tooltip =
`
}

/** Env for the desktop processes: the agent display, a real cursor theme, openbox's theme directory. */
export function desktopEnv(base: Record<string, string>, dataDir: string): Record<string, string> {
  return { ...base, ...CURSOR, XDG_DATA_HOME: desktopDir(dataDir), XDG_CONFIG_HOME: desktopDir(dataDir) }
}
