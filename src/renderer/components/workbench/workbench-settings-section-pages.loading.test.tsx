import { Suspense } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render, settleLazyRender } from "@/test/dom";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";

const moduleInitialization = vi.hoisted(() => ({
  general: vi.fn(),
  browser: vi.fn(),
  agent: vi.fn(),
  backups: vi.fn(),
}));

vi.mock("./general-settings-page", () => {
  moduleInitialization.general();
  return { GeneralSettingsPage: () => <h1>General content</h1> };
});

vi.mock("@/features/browser-sidebar/browser-settings-pages", () => {
  moduleInitialization.browser();
  return { BrowserSettingsPage: () => <h1>Browser content</h1> };
});

vi.mock("./agent-settings-page", () => {
  moduleInitialization.agent();
  return { AgentSettingsPage: () => <h1>Agent content</h1> };
});

vi.mock("./backups-settings-page", () => {
  moduleInitialization.backups();
  return { BackupsSettingsPage: () => <h1>Backups content</h1> };
});

const PAGE_PROPS: SettingsSectionPageProps = {
  activeProjectId: null,
  browserAnchor: null,
  browserDetail: null,
  composerEnterBehavior: "enter",
  isMacPlatform: false,
  onComposerEnterBehaviorChange: () => {},
  onOpenBrowserDetail: () => {},
  onPathChange: () => {},
  onRequestProjectPickerOpen: () => {},
  onTaskShorthandPagePromotionEnabledChange: () => {},
  onThreadQueueFollowUpsEnabledChange: () => {},
  onWorktreeAutoBranchPrefixChange: () => {},
  onWorktreeStartModeChange: () => {},
  open: true,
  path: "/settings/general-settings",
  projects: [],
  taskShorthandPagePromotionEnabled: true,
  threadQueueFollowUpsEnabled: false,
  worktreeAutoBranchPrefix: "codex/",
  worktreeStartMode: "autoBranch",
};

describe("Settings page module loading", () => {
  test("defers page module execution until that page is rendered", async () => {
    const { SETTINGS_PAGE_COMPONENTS } = await import("./workbench-settings-section-pages");

    for (const initialize of Object.values(moduleInitialization)) {
      expect(initialize).not.toHaveBeenCalled();
    }

    const General = SETTINGS_PAGE_COMPONENTS.general;
    const view = render(
      <Suspense fallback={<div role="status">Loading…</div>}>
        <General {...PAGE_PROPS} />
      </Suspense>,
    );
    await settleLazyRender();

    await view.findByRole("heading", { name: "General content" });
    expect(moduleInitialization.general).toHaveBeenCalledOnce();
    expect(moduleInitialization.browser).not.toHaveBeenCalled();
    expect(moduleInitialization.agent).not.toHaveBeenCalled();
    expect(moduleInitialization.backups).not.toHaveBeenCalled();
  });
});
