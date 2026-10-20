import { act, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { AppProviders } from "@/app-providers";
import { __resetThreadNotificationSettingsForTests } from "@/lib/use-thread-notification-settings";
import { __resetWindowRestoreSettingsForTests } from "@/lib/use-window-restore-settings";
import { installWindowApi } from "@/test/browser-globals";
import { render, settleLazyRender } from "@/test/dom";
import { SettingsRouteShell } from "./workbench-settings-route-shell";
import { buildSettingsPath, OPEN_SOURCE_LICENSES_SETTINGS_PATH } from "./workbench-settings-routes";

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

const invokedChannels: string[] = [];

function installSettingsWindowApi(noticesText: string | null): void {
  installWindowApi({
    invoke: async (channel: string) => {
      invokedChannels.push(channel);

      switch (channel) {
        case "settings:git:get":
          return {
            branchPrefix: "codex/",
            commitInstructions: "",
            pullRequestInstructions: "",
          };
        case "settings:third-party-notices:get":
          return { text: noticesText };
        case "settings:thread-notifications:get":
          return {
            turnMode: "unfocused",
            questionsEnabled: true,
          };
        case "settings:app-updates:get":
          return { automaticChecksEnabled: true };
        case "settings:window-restore:get":
          return { policy: "all" };
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

function SettingsLicensesHarness({ initialPath }: { initialPath: string }) {
  const [path, setPath] = useState(initialPath);

  return (
    <AppProviders>
      <SettingsRouteShell
        path={path}
        onPathChange={setPath}
        onBackToApp={() => {}}
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
    </AppProviders>
  );
}

beforeEach(() => {
  invokedChannels.splice(0);
  __resetThreadNotificationSettingsForTests();
  __resetWindowRestoreSettingsForTests();
});

describe("SettingsRouteShell open source licenses", () => {
  test("opens the bundled notices from General and returns to the row", async () => {
    installSettingsWindowApi(["NODEX THIRD-PARTY NOTICES", "", "react@19.2.7 — MIT"].join("\n"));

    const view = render(
      <SettingsLicensesHarness initialPath={buildSettingsPath("general-settings")} />,
    );
    await settleLazyRender();
    const openLicenses = await view.findByRole("button", { name: "View" });

    await act(async () => {
      fireEvent.click(openLicenses);
      await Promise.resolve();
    });
    await settleLazyRender();

    view.getByText("Open source licenses");
    const notices = await view.findByRole("document");
    expect(notices.getAttribute("aria-label")).toContain("react@19.2.7 — MIT");
    expect(invokedChannels).toContain("settings:third-party-notices:get");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Back to General" }));
      await Promise.resolve();
    });
    await settleLazyRender();

    await view.findByRole("button", { name: "View" });
  });

  test("shows an explicit unavailable state when no notice resource exists", async () => {
    installSettingsWindowApi(null);

    const view = render(
      <SettingsLicensesHarness initialPath={OPEN_SOURCE_LICENSES_SETTINGS_PATH} />,
    );
    await settleLazyRender();

    await view.findByText("No third-party notices were found.");
  });
});
