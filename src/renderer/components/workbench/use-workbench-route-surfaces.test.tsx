import { act, render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { useWorkbenchRouteSurfaces } from "./use-workbench-route-surfaces";

const loadedRoutes = vi.hoisted(() => [] as string[]);

vi.mock("./workbench-settings-route-shell", () => {
  loadedRoutes.push("settings");
  return {
    SettingsRouteShell: ({ path }: { path: string }) => (
      <output aria-label="Settings route">{path}</output>
    ),
  };
});

vi.mock("./workbench-automations-overlay", () => {
  loadedRoutes.push("automations");
  return {
    WorkbenchAutomationsRouteShell: ({ path }: { path: string }) => (
      <output aria-label="Automations route">{path}</output>
    ),
  };
});

vi.mock("./pending-worktree-route", () => {
  loadedRoutes.push("pending-worktree");
  return {
    PendingWorktreeRoute: ({ clientThreadId }: { clientThreadId: string }) => (
      <output aria-label="Pending worktree">{clientThreadId}</output>
    ),
  };
});

const input: Parameters<typeof useWorkbenchRouteSurfaces>[0] = {
  settings: {
    path: null,
    props: {
      onPathChange: vi.fn(),
      onBackToApp: vi.fn(),
      onRequestProjectPickerOpen: vi.fn(),
      projects: [],
      activeProjectId: null,
      threadQueueFollowUpsEnabled: false,
      onThreadQueueFollowUpsEnabledChange: vi.fn(),
      composerEnterBehavior: "enter",
      onComposerEnterBehaviorChange: vi.fn(),
      worktreeStartMode: "autoBranch",
      onWorktreeStartModeChange: vi.fn(),
      worktreeAutoBranchPrefix: "codex/",
      onWorktreeAutoBranchPrefixChange: vi.fn(),
      taskShorthandPagePromotionEnabled: false,
      onTaskShorthandPagePromotionEnabledChange: vi.fn(),
    },
  },
  automations: { path: null, props: { onPathChange: vi.fn() } },
  pendingWorktree: {
    clientThreadId: null,
    props: { onClose: vi.fn(), onOpenThread: vi.fn(async () => undefined) },
  },
};

function Routes(props: Parameters<typeof useWorkbenchRouteSurfaces>[0]) {
  const { settingsRouteShell, automationsRouteShell, pendingWorktreeRouteShell } =
    useWorkbenchRouteSurfaces(props);
  return (
    <>
      {settingsRouteShell}
      {automationsRouteShell}
      {pendingWorktreeRouteShell}
    </>
  );
}

test("loads auxiliary route modules only when their route is presented", async () => {
  const view = render(<Routes {...input} />);
  expect(loadedRoutes).toEqual([]);

  await act(async () => {
    view.rerender(
      <Routes {...input} settings={{ ...input.settings, path: "/settings/general" }} />,
    );
    await vi.dynamicImportSettled();
  });
  expect((await view.findByRole("status", { name: "Settings route" })).textContent).toBe(
    "/settings/general",
  );
  expect(loadedRoutes).toEqual(["settings"]);

  await act(async () => {
    view.rerender(
      <Routes {...input} automations={{ ...input.automations, path: "/automations" }} />,
    );
    await vi.dynamicImportSettled();
  });
  expect((await view.findByRole("status", { name: "Automations route" })).textContent).toBe(
    "/automations",
  );
  expect(view.queryByRole("status", { name: "Settings route" })).toBeNull();
  expect(loadedRoutes).toEqual(["settings", "automations"]);

  await act(async () => {
    view.rerender(
      <Routes
        {...input}
        pendingWorktree={{ ...input.pendingWorktree, clientThreadId: "pending-1" }}
      />,
    );
    await vi.dynamicImportSettled();
  });
  expect((await view.findByRole("status", { name: "Pending worktree" })).textContent).toBe(
    "pending-1",
  );
  expect(view.queryByRole("status", { name: "Automations route" })).toBeNull();
  expect(loadedRoutes).toEqual(["settings", "automations", "pending-worktree"]);
});
