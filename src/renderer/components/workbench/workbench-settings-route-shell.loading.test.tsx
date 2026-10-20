import { act, fireEvent, waitFor } from "@testing-library/react";
import { lazy, useState, type ComponentType } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { AppProviders } from "@/app-providers";
import { render, settleAsyncRender } from "@/test/dom";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import { SettingsRouteShell } from "./workbench-settings-route-shell";
import { buildSettingsAnchorPath, buildSettingsPath } from "./workbench-settings-routes";

const pages = vi.hoisted(() => ({
  components: {} as Record<string, ComponentType<SettingsSectionPageProps>>,
}));

vi.mock("./workbench-settings-section-pages", () => ({
  SETTINGS_PAGE_COMPONENTS: pages.components,
}));

function deferredPage(title: string, anchor?: string) {
  let resolve!: (module: { default: ComponentType<SettingsSectionPageProps> }) => void;
  const module = new Promise<{ default: ComponentType<SettingsSectionPageProps> }>((settle) => {
    resolve = settle;
  });
  const load = vi.fn(() => module);

  return {
    Component: lazy(load),
    load,
    async resolve() {
      await act(async () => {
        resolve({ default: () => <h1 id={anchor}>{title}</h1> });
        await module;
      });
    },
  };
}

function SettingsLoadingHarness({
  initialPath = buildSettingsPath("general-settings"),
  onBackToApp = () => {},
}: {
  initialPath?: string;
  onBackToApp?: () => void;
}) {
  const [path, setPath] = useState(initialPath);

  return (
    <AppProviders>
      <SettingsRouteShell
        path={path}
        onPathChange={setPath}
        onBackToApp={onBackToApp}
        onRequestProjectPickerOpen={() => {}}
        projects={[]}
        activeProjectId={null}
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

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
  await settleAsyncRender();
}

beforeEach(() => {
  for (const key of Object.keys(pages.components)) delete pages.components[key];
});

describe("SettingsRouteShell loading", () => {
  test("scrolls to a requested anchor after its deferred page mounts", async () => {
    const general = deferredPage("Notifications", "notifications");
    pages.components.general = general.Component;
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");

    try {
      const view = render(
        <SettingsLoadingHarness
          initialPath={buildSettingsAnchorPath("general-settings", "notifications")}
        />,
      );

      view.getByRole("status");
      expect(view.queryByRole("heading", { name: "Notifications" })).toBeNull();
      expect(scrollIntoView).not.toHaveBeenCalled();

      await general.resolve();
      const notifications = await view.findByRole("heading", { name: "Notifications" });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
      expect(scrollIntoView.mock.contexts[0]).toBe(notifications);
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  test("keeps search, navigation, and Back to app available before the first page loads", async () => {
    const general = deferredPage("General content");
    const shortcuts = deferredPage("Keyboard shortcuts content");
    const appearance = deferredPage("Appearance content");
    pages.components.general = general.Component;
    pages.components["keyboard-shortcuts"] = shortcuts.Component;
    pages.components.appearance = appearance.Component;
    const onBackToApp = vi.fn();
    const view = render(<SettingsLoadingHarness onBackToApp={onBackToApp} />);

    expect(view.getByRole("status").textContent).toBe("Loading…");
    expect(view.getByRole("link", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(general.load).toHaveBeenCalledOnce();
    expect(shortcuts.load).not.toHaveBeenCalled();
    expect(appearance.load).not.toHaveBeenCalled();

    const search = view.getByRole("searchbox", { name: "Search settings" });
    await act(async () => {
      fireEvent.input(search, { target: { value: "keyboard shortcuts" } });
      await Promise.resolve();
    });
    await click(view.getByRole("button", { name: "Keyboard shortcuts, Keyboard shortcuts" }));

    expect(shortcuts.load).toHaveBeenCalledOnce();
    expect(appearance.load).not.toHaveBeenCalled();
    expect(view.getByRole("status").textContent).toBe("Loading…");

    await click(view.getByRole("button", { name: "Back to app" }));
    expect(onBackToApp).toHaveBeenCalledOnce();

    await shortcuts.resolve();
    await view.findByRole("heading", { name: "Keyboard shortcuts content" });
    await general.resolve();
    expect(view.queryByRole("heading", { name: "General content" })).toBeNull();
    expect(view.getByRole("heading", { name: "Keyboard shortcuts content" })).not.toBeNull();
  });

  test("commits section navigation while its content loads and ignores an abandoned load", async () => {
    const appearance = deferredPage("Appearance content");
    pages.components.general = () => <h1>General content</h1>;
    pages.components.appearance = appearance.Component;
    pages.components["keyboard-shortcuts"] = () => <h1>Keyboard shortcuts content</h1>;
    const view = render(<SettingsLoadingHarness />);

    view.getByRole("heading", { name: "General content" });
    await click(view.getByRole("link", { name: "Appearance" }));

    expect(view.getByRole("link", { name: "Appearance" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(view.getByRole("status").textContent).toBe("Loading…");
    expect(view.queryByRole("heading", { name: "General content" })).toBeNull();

    await click(view.getByRole("link", { name: "Keyboard shortcuts" }));
    await view.findByRole("heading", { name: "Keyboard shortcuts content" });
    expect(view.queryByRole("status")).toBeNull();

    await appearance.resolve();
    expect(view.queryByRole("heading", { name: "Appearance content" })).toBeNull();
    expect(view.getByRole("heading", { name: "Keyboard shortcuts content" })).not.toBeNull();
    expect(
      view.getByRole("link", { name: "Keyboard shortcuts" }).getAttribute("aria-current"),
    ).toBe("page");
  });
});
