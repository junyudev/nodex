import type { ChatCatalogEntry } from "../shared/chat-search";
import type { LoginItemSettings } from "electron";

export const WINDOWS_STARTUP_ARGUMENT = "--startup";
export const WINDOWS_LOGIN_ITEM_NAME = "Nodex";

// Electron's openAtLogin only observes the AUMID-named Run value. Our NSIS-owned
// value has its own name; launchItems also preserves Windows' approval decision.
// Its args omit switches, so they cannot identify the --startup activation.
export const windowsLoginItemEnabled = (
  executable: string,
  status: Pick<LoginItemSettings, "launchItems">,
): boolean =>
  status.launchItems.some(
    (item) =>
      item.name === WINDOWS_LOGIN_ITEM_NAME &&
      item.scope === "user" &&
      item.enabled &&
      item.path.replaceAll("/", "\\").toLowerCase() ===
        executable.replaceAll("/", "\\").toLowerCase(),
  );

export const isWindowsStartupActivation = (platform: string, argv: readonly string[]): boolean =>
  platform === "win32" && argv.includes(WINDOWS_STARTUP_ARGUMENT);

export const shouldHideLastWindow = (input: {
  readonly applicationQuitting: boolean;
  readonly primaryWindowCount: number;
  readonly trayAvailable: boolean;
}): boolean => !input.applicationQuitting && input.trayAvailable && input.primaryWindowCount === 1;

export const shouldQuitWithoutWindows = (platform: string, startupFailed: boolean): boolean =>
  platform !== "darwin" && (platform !== "win32" || startupFailed);

export const windowsQuitWarning = (input: {
  readonly activeChats: boolean;
  readonly scheduledTasks: boolean;
}): string | null => {
  if (input.activeChats && input.scheduledTasks)
    return "Active chats on this computer will be interrupted and scheduled tasks won’t run while Nodex is closed.";
  if (input.activeChats) return "Active chats on this computer will be interrupted.";
  if (input.scheduledTasks) return "Scheduled tasks won’t run while Nodex is closed.";
  return null;
};

// Packaged channel identity must survive executable upgrades and preference changes.
const TRAY_GUIDS = {
  stable: "e2ce4e99-33a1-40a6-bf07-76b2ca126cef",
  nightly: "70232475-312d-41ed-8050-20b597599bd1",
  disabled: "4c366c1d-c046-4cd9-808c-1a3df9cef174",
} as const;

export const windowsTrayGuid = (
  packaged: boolean,
  channel: keyof typeof TRAY_GUIDS,
): string | undefined => (packaged ? TRAY_GUIDS[channel] : undefined);

export const trayChatLabel = (title: string): string => {
  const points = Array.from(title);
  return points.length <= 35 ? title : `${points.slice(0, 34).join("").trimEnd()}…`;
};

export interface TrayChatGroup {
  readonly label: string;
  readonly chats: readonly ChatCatalogEntry[];
}

/** A bounded projection of existing chat facts, with no transcript or execution ownership. */
export const windowsTrayChatGroups = (
  chats: readonly ChatCatalogEntry[],
): readonly TrayChatGroup[] => {
  const recent = [...chats].sort((a, b) => b.recencyAt - a.recencyAt);
  return [
    { label: "Running", chats: recent.filter((chat) => chat.activity === "running") },
    { label: "Unread", chats: recent.filter((chat) => chat.unread) },
    {
      label: "Pinned",
      chats: chats
        .filter((chat) => chat.pinned)
        .sort(
          (a, b) =>
            (a.pinnedOrder ?? Number.MAX_SAFE_INTEGER) - (b.pinnedOrder ?? Number.MAX_SAFE_INTEGER),
        ),
    },
    { label: "Recent", chats: recent },
  ].filter((group) => group.chats.length > 0);
};
