import type { IpcApi } from "./ipc-api";

/** Desktop settings, window management, device input (keyboard and dictation) and installation
 * analytics have no content authority: they run on this desktop whichever Space a window shows.
 * Everything else must carry a Space, including native execution and cleanup commands. */
const desktopPrefixes = [
  "app:",
  "window-sessions:",
  "window:",
  "electron-window:",
  "surface-history:",
  "settings:",
  "diagnostics:",
  "spaces:",
  "app-update:",
  "windows-startup:",
  "nodex-account:",
  "keyboard:",
  "command-keybindings:",
  "codex:dictation:",
  "global-dictation",
  "product-analytics:",
  "chrome-control:",
  "computer-use:",
] as const;
const desktopChannels: readonly (keyof IpcApi)[] = [
  "codex-command-keymap-state",
  "set-codex-command-keybinding",
  // The shells this computer can open, for its device-wide Terminal setting.
  "terminal-shells:list",
];

export const isSpaceIpcChannel = (channel: keyof IpcApi): boolean =>
  [
    "settings:inbox:get",
    "settings:inbox:update",
    "app:get-core-authority-status",
    "app:retry-core-authority",
    "app:relaunch-for-core-authority",
  ].includes(channel) ||
  (!desktopChannels.includes(channel) &&
    !desktopPrefixes.some((prefix) => channel.startsWith(prefix)));

/**
 * Device capabilities a window of any Space reaches on this computer, with its Space envelope:
 * native menus, the clipboard, the system browser and the Composer's own drafting storage (picked
 * files, pasted images and long pasted text) carry no Core resource authority. What a Composer
 * holds reaches a Space only when its message is sent there.
 */
export const DEVICE_CAPABILITY_CHANNELS: readonly (keyof IpcApi)[] = [
  "native-context-menu:show",
  "clipboard:read-paste",
  "clipboard:write-image",
  "clipboard:write-claimed-presentation",
  "shell:open-external-url",
  "shell:default-browser:get",
  "shell:file-link-openers:list-available",
  "composer:pick-files",
  "asset:image:save",
  "codex:pasted-text:create",
  "codex:pasted-text:read",
  "codex:pasted-text:remove",
];

/** The URL chooses a Space only at the renderer-document boundary. */
export function rendererSpaceParameter(url: string): string | null {
  try {
    return new URL(url).searchParams.get("spaceId");
  } catch {
    return null;
  }
}
