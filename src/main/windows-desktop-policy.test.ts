import { describe, expect, test } from "vite-plus/test";
import type { ChatCatalogEntry } from "../shared/chat-search";
import {
  isWindowsStartupActivation,
  shouldHideLastWindow,
  shouldQuitWithoutWindows,
  trayChatLabel,
  windowsLoginItemEnabled,
  windowsQuitWarning,
  windowsTrayChatGroups,
  windowsTrayGuid,
} from "./windows-desktop-policy";

describe("Windows desktop policy", () => {
  test("startup status observes the named per-user registration independently of the AUMID", () => {
    const executable = "C:\\Users\\用户\\Programs\\Nodex\\Nodex.exe";
    const item = {
      name: "Nodex",
      scope: "user" as const,
      enabled: true,
      path: executable.toUpperCase(),
      args: [],
    };
    // Native launchItems excludes switches and openAtLogin reads the AUMID key.
    const status = { openAtLogin: false, launchItems: [item] };
    expect(windowsLoginItemEnabled(executable, status)).toBe(true);
    for (const invalid of [
      { ...item, enabled: false },
      { ...item, scope: "machine" as const },
      { ...item, path: "C:\\Other\\Nodex.exe" },
      { ...item, name: "Other" },
    ])
      expect(windowsLoginItemEnabled(executable, { ...status, launchItems: [invalid] })).toBe(
        false,
      );
    expect(windowsLoginItemEnabled(executable, { launchItems: [] })).toBe(false);
  });
  test("only the explicit Windows startup activation suppresses navigation", () => {
    expect(isWindowsStartupActivation("win32", ["Nodex.exe", "--startup"])).toBe(true);
    for (const [platform, argv] of [
      ["darwin", ["--startup"]],
      ["win32", ["--startup=false"]],
      ["win32", ["nodex://sessions/a"]],
      ["win32", ["--new-window"]],
    ] as const)
      expect(isWindowsStartupActivation(platform, argv)).toBe(false);
  });
  test("only the final primary window hides while an acquired tray is available", () => {
    expect(
      shouldHideLastWindow({
        applicationQuitting: false,
        primaryWindowCount: 1,
        trayAvailable: true,
      }),
    ).toBe(true);
    for (const input of [
      { applicationQuitting: true, primaryWindowCount: 1, trayAvailable: true },
      { applicationQuitting: false, primaryWindowCount: 2, trayAvailable: true },
      { applicationQuitting: false, primaryWindowCount: 1, trayAvailable: false },
    ])
      expect(shouldHideLastWindow(input)).toBe(false);
    expect(shouldQuitWithoutWindows("win32", false)).toBe(false);
    expect(shouldQuitWithoutWindows("win32", true)).toBe(true);
    expect(shouldQuitWithoutWindows("darwin", true)).toBe(false);
    expect(shouldQuitWithoutWindows("linux", false)).toBe(true);
  });
  test("preserves the packaged GUIDs for enabled and disabled updates", () => {
    expect(windowsTrayGuid(true, "enabled")).toBe("e2ce4e99-33a1-40a6-bf07-76b2ca126cef");
    expect(windowsTrayGuid(true, "disabled")).toBe("4c366c1d-c046-4cd9-808c-1a3df9cef174");
    expect(windowsTrayGuid(false, "enabled")).toBeUndefined();
  });
  test("chat labels truncate by Unicode codepoints without splitting surrogate pairs", () => {
    expect(trayChatLabel("🙂".repeat(35))).toBe("🙂".repeat(35));
    expect(trayChatLabel("🙂".repeat(36))).toBe(`${"🙂".repeat(34)}…`);
  });
  test("chat sections use activity, unread identity, pin order and recency without mutating the catalog", () => {
    const chat = (
      id: string,
      recencyAt: number,
      extra: Partial<ChatCatalogEntry> = {},
    ): ChatCatalogEntry => ({
      sessionId: id,
      threadId: id,
      title: id,
      projectId: null,
      projectName: null,
      cwd: null,
      branch: null,
      pullRequests: [],
      pinned: false,
      pinnedOrder: null,
      unread: false,
      activity: "idle",
      createdAt: 0,
      recencyAt,
      ...extra,
    });
    const input = [
      chat("old-pin", 1, { pinned: true, pinnedOrder: 0 }),
      chat("new", 3, { activity: "running" }),
      chat("unread", 2, { unread: true }),
    ];
    expect(
      windowsTrayChatGroups(input).map(({ label, chats }) => [
        label,
        chats.map((chat) => chat.sessionId),
      ]),
    ).toEqual([
      ["Running", ["new"]],
      ["Unread", ["unread"]],
      ["Pinned", ["old-pin"]],
      ["Recent", ["new", "unread", "old-pin"]],
    ]);
    expect(input.map((chat) => chat.sessionId)).toEqual(["old-pin", "new", "unread"]);
    expect(windowsTrayChatGroups([])).toEqual([]);
  });
  test("quit only needs confirmation for work that stops with Desktop", () => {
    expect(windowsQuitWarning({ activeChats: false, scheduledTasks: false })).toBeNull();
    expect(windowsQuitWarning({ activeChats: true, scheduledTasks: false })).toContain(
      "interrupted",
    );
    expect(windowsQuitWarning({ activeChats: false, scheduledTasks: true })).toContain(
      "Automations",
    );
    expect(windowsQuitWarning({ activeChats: true, scheduledTasks: true })).toContain(
      "and Automations",
    );
  });
});
