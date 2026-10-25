import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { AppProviders } from "@/app-providers";
import { render, settleAsyncRender, settleLazyRender } from "@/test/dom";
import { installWindowApi } from "@/test/browser-globals";
import { __resetWindowRestoreSettingsForTests } from "@/lib/use-window-restore-settings";
import { __resetThreadNotificationSettingsForTests } from "@/lib/use-thread-notification-settings";
import { SettingsRouteShell } from "./workbench-settings-route-shell";
import { buildSettingsPath } from "./workbench-settings-routes";

const PROJECTS = [
  {
    id: "default",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active" as const,
    bindingRevision: 1,
    name: "Nodex",
    description: "",
    appearance: { color: "black", marker: { kind: "icon", icon: "folder" } } as const,
    sources: [{ root: "/Users/asc/repo/nodex", order: 0 }],
    primaryWorkspaceRoot: "/Users/asc/repo/nodex",
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-03-01T00:00:00.000Z"),
    updated: new Date("2026-03-01T00:00:00.000Z"),
  },
];

const storageMap = new Map<string, string>();

const mockStorage = {
  getItem(key: string): string | null {
    return storageMap.has(key) ? (storageMap.get(key) ?? null) : null;
  },
  setItem(key: string, value: string): void {
    storageMap.set(key, value);
  },
  removeItem(key: string): void {
    storageMap.delete(key);
  },
};

if (!(globalThis as { localStorage?: unknown }).localStorage) {
  (globalThis as { localStorage: typeof mockStorage }).localStorage = mockStorage;
}

const invokedChannels: Array<{ channel: string; args: unknown[] }> = [];

function resetStorage(): void {
  storageMap.clear();
  invokedChannels.splice(0);
  __resetWindowRestoreSettingsForTests();
  __resetThreadNotificationSettingsForTests();
}

function installSettingsWindowApi() {
  installWindowApi({
    invoke: async (channel: string, ...args: unknown[]) => {
      invokedChannels.push({ channel, args });
      switch (channel) {
        case "settings:git:get":
          return {
            branchPrefix: "codex/",
            commitInstructions: "",
            pullRequestInstructions: "",
          };
        case "settings:thread-notifications:get":
          return {
            turnMode: "unfocused",
            questionsEnabled: true,
          };
        case "settings:app-updates:get":
          return { automaticChecksEnabled: true };
        case "settings:window-restore:get":
          return { policy: "all" };
        case "settings:window-restore:update":
          return args[0];
        case "app:update:status":
          return {
            status: "idle",
            supported: true,
            currentVersion: "0.1.0",
            availableVersion: null,
            releaseName: null,
            releaseDate: null,
            releaseNotes: null,
            progressPercent: null,
            transferredBytes: null,
            totalBytes: null,
            checkedAt: null,
            message: null,
          };
        case "worktrees:managed:list":
          return [];
        default:
          return null;
      }
    },
    on: () => () => {},
  });
}

function renderOverlay({
  path = buildSettingsPath("general-settings"),
  onBackToApp = () => {},
}: {
  path?: string;
  onBackToApp?: () => void;
} = {}) {
  return render(
    <AppProviders>
      <SettingsRouteShell
        path={path}
        onPathChange={() => {}}
        onBackToApp={onBackToApp}
        onRequestProjectPickerOpen={() => {}}
        projects={PROJECTS}
        activeProjectId="default"
        threadQueueFollowUpsEnabled={false}
        onThreadQueueFollowUpsEnabledChange={() => {}}
        composerEnterBehavior="enter"
        onComposerEnterBehaviorChange={() => {}}
        worktreeStartMode="autoBranch"
        onWorktreeStartModeChange={() => {}}
        worktreeAutoBranchPrefix="codex/"
        onWorktreeAutoBranchPrefixChange={() => {}}
        taskShorthandPagePromotionEnabled={true}
        onTaskShorthandPagePromotionEnabledChange={() => {}}
      />
    </AppProviders>,
  );
}

describe("SettingsRouteShell Escape", () => {
  test("backs out on Escape unless focus is inside an editable setting", async () => {
    resetStorage();
    installSettingsWindowApi();
    let backCalls = 0;

    const view = renderOverlay({
      path: buildSettingsPath("git"),
      onBackToApp: () => {
        backCalls += 1;
      },
    });
    await settleLazyRender();

    const autoBranchPrefixInput = await view.findByLabelText("Branch prefix");
    await act(async () => {
      autoBranchPrefixInput.focus();
      fireEvent.keyDown(window, { key: "Escape" });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(backCalls).toBe(0);

    await act(async () => {
      autoBranchPrefixInput.blur();
      fireEvent.keyDown(window, { key: "Escape" });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(backCalls).toBe(1);
  });
});
