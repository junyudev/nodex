import type { CSSProperties } from "react";
import { render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import "../../globals.css";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import { resolveWorkbenchWorkspaceInsets } from "@/lib/workbench-shell-geometry";
import { getCodexSidebarFloatingOuterClassName } from "@/lib/codex-sidebar-auto-reveal";
import { WorkbenchWorkspaceFrame } from "./workbench-workspace-frame";
import { WorkbenchRouteHost } from "./workbench-route-host";
import { SettingsRouteShell } from "./workbench-settings-route-shell";

installRendererThemeFixture();

// Page loading is independently covered; this suite measures the real route/frame composition.
vi.mock("./workbench-settings-section-pages", () => ({
  SETTINGS_PAGE_COMPONENTS: { general: () => <h1>General</h1> },
}));

const noop = () => {};
const emptySlot = { content: () => null };

test.each([true, false])(
  "sidebar and workspace content keep their own top edges (application menu: %s)",
  (applicationMenu) => {
    const insets = resolveWorkbenchWorkspaceInsets(applicationMenu, true);
    const menuHeight = applicationMenu ? 36 : 0;
    const view = render(
      <div
        className="fixed inset-0 flex flex-col"
        style={
          {
            "--app-shell-application-menu-height": `${menuHeight}px`,
            "--app-shell-workspace-top-inset": `${insets.workspaceTop}px`,
            "--app-shell-content-top-inset": `${insets.contentTop}px`,
            "--app-shell-surface-top-inset": `${insets.surfaceTop}px`,
          } as CSSProperties
        }
      >
        <div style={{ height: menuHeight, flexShrink: 0 }} />
        <WorkbenchWorkspaceFrame
          rail={<nav aria-label="App rail" style={{ width: 52, height: "100%" }} />}
        >
          <WorkbenchRouteHost
            location={{ kind: "empty" }}
            sidebar={<aside aria-label="Workspace sidebar" style={{ width: 300 }} />}
            sidebarMounted
            settings={null}
            pendingWorktree={emptySlot}
            plugins={emptySlot}
            insights={emptySlot}
            automations={emptySlot}
            session={{ content: () => <article>Page content</article> }}
          />
        </WorkbenchWorkspaceFrame>
        <aside
          aria-label="Peek sidebar"
          className={getCodexSidebarFloatingOuterClassName(applicationMenu)}
        />
      </div>,
    );
    const sidebar = view
      .getByRole("complementary", { name: "Workspace sidebar" })
      .getBoundingClientRect();
    const content = view.getByRole("main").getBoundingClientRect();
    const rail = view.getByRole("navigation").getBoundingClientRect();
    expect(sidebar.top).toBe(applicationMenu ? 36 : 44);
    expect(rail.top).toBe(sidebar.top);
    expect(content.top).toBe(applicationMenu ? 80 : 44);
    expect(content.bottom).toBe(sidebar.bottom);
    expect(content.left).toBe(sidebar.right);
    if (applicationMenu)
      expect(
        view.getByRole("complementary", { name: "Peek sidebar" }).getBoundingClientRect().top,
      ).toBe(36);
  },
);

test("Windows Settings starts at the page gutter and excludes unsupported deep links", async () => {
  const root = document.documentElement;
  const previousOs = root.dataset.codexOs;
  root.dataset.codexOs = "win32";
  const insets = resolveWorkbenchWorkspaceInsets(true, false);
  try {
    const view = render(
      <div
        className="fixed inset-0 flex flex-col"
        style={
          {
            "--app-shell-workspace-top-inset": `${insets.workspaceTop}px`,
            "--app-shell-content-top-inset": `${insets.contentTop}px`,
            "--app-shell-surface-top-inset": `${insets.surfaceTop}px`,
          } as CSSProperties
        }
      >
        <div style={{ height: 36, flexShrink: 0 }} />
        <WorkbenchWorkspaceFrame
          rail={<nav aria-label="App rail" style={{ width: 52, height: "100%" }} />}
        >
          <SettingsRouteShell
            path="/settings/computer-use"
            onPathChange={noop}
            onBackToApp={noop}
            onRequestProjectPickerOpen={noop}
            projects={[]}
            activeProjectId={null}
            threadQueueFollowUpsEnabled={false}
            onThreadQueueFollowUpsEnabledChange={noop}
            composerEnterBehavior="enter"
            onComposerEnterBehaviorChange={noop}
            worktreeStartMode="autoBranch"
            onWorktreeStartModeChange={noop}
            worktreeAutoBranchPrefix="codex/"
            onWorktreeAutoBranchPrefixChange={noop}
            taskShorthandPagePromotionEnabled
            onTaskShorthandPagePromotionEnabledChange={noop}
          />
        </WorkbenchWorkspaceFrame>
      </div>,
    );
    await view.findByRole("heading", { name: "General" });
    expect(view.getByLabelText("Settings", { selector: "div" }).getBoundingClientRect().top).toBe(
      44,
    );
    expect(view.queryByRole("link", { name: "Computer use", hidden: true })).toBeNull();
    expect(view.getByRole("link", { name: "Browser", hidden: true })).toBeTruthy();
  } finally {
    if (previousOs === undefined) delete root.dataset.codexOs;
    else root.dataset.codexOs = previousOs;
  }
});
