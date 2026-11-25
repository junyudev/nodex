import { expect, test, describe, afterEach, beforeEach, it, vi } from "vite-plus/test";
import { isEligibleMarkdownLinkContext, snapshotLinkActivation } from "./link-activation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  DEFAULT_LINK_OPENING_SETTINGS,
  type LinkOpeningSettings,
} from "../../shared/link-opening-settings";
import { installWindowApi } from "../test/browser-globals";
import {
  resetLinkOpeningSettingsOwnersForTests,
  useLinkOpeningSettings,
} from "./link-opening-settings";

describe("link activation", () => {
  test.each([
    [null, null, false, false, true],
    ["main", null, false, false, false],
    ["main", "tabpanel", false, false, true],
    ["main", null, false, true, true],
    [null, "tabpanel", true, false, false],
    ["main", "tabpanel", true, true, false],
  ] as const)(
    "Markdown context %s/%s controller=%s fullWidth=%s",
    (area, role, controller, fullWidth, expected) => {
      const region = document.createElement("div");
      if (area) region.setAttribute("data-app-shell-focus-area", area);
      if (role) region.setAttribute("role", role);
      if (controller) region.setAttribute("data-app-shell-tab-panel-controller", "right");
      const anchor = document.createElement("a");
      region.append(anchor);
      expect(
        isEligibleMarkdownLinkContext(anchor, {
          platform: "darwin",
          ...(fullWidth ? { metaKey: true, altKey: true } : {}),
        }),
      ).toBe(expected);
    },
  );
  test("captures a detached value and normalizes macOS platform spelling", () => {
    const event = new MouseEvent("auxclick", { button: 1, metaKey: true, shiftKey: true });
    expect(snapshotLinkActivation(event, "MacIntel")).toEqual({
      button: 1,
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      platform: "darwin",
    });
  });
});

describe("link opening settings", () => {
  let saved: LinkOpeningSettings;
  let rejectSave = false;
  const clients: QueryClient[] = [];
  const listeners = new Set<(settings: LinkOpeningSettings) => void>();
  const invoke = vi.fn(async (channel: string, input?: LinkOpeningSettings) => {
    if (channel === "settings:link-opening:get") return saved;
    if (channel !== "settings:link-opening:update" || !input) throw new Error(channel);
    if (rejectSave) throw new Error("Write failed");
    saved = input;
    for (const listener of listeners) listener(saved);
    return saved;
  });
  beforeEach(() => {
    saved = { ...DEFAULT_LINK_OPENING_SETTINGS };
    rejectSave = false;
    invoke.mockClear();
    resetLinkOpeningSettingsOwnersForTests();
    installWindowApi({
      invoke,
      on: (channel: string, callback: (settings: LinkOpeningSettings) => void) => {
        if (channel !== "link-opening-settings-changed") return () => {};
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    });
  });
  afterEach(() => {
    cleanup();
    for (const client of clients.splice(0)) client.clear();
    expect(listeners.size).toBe(0);
  });
  function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    return renderHook(useLinkOpeningSettings, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
  }
  it("loads effective preferences and publishes independent destination changes across windows", async () => {
    const first = mount();
    const second = mount();
    await waitFor(() => {
      expect(first.result.current.isLoading).toBe(false);
      expect(second.result.current.isLoading).toBe(false);
    });
    const desired = {
      ...DEFAULT_LINK_OPENING_SETTINGS,
      openLinkInTarget: "in-app-browser",
      externalBrowserLinkShortcut: "alt",
    } as const;
    await act(async () => {
      await first.result.current.updateSettings(desired);
    });
    await waitFor(() => expect(second.result.current.settings).toEqual(desired));
    expect(first.result.current.settings).toEqual(desired);
    expect(saved.openLocalUrlInTarget).toBe("in-app-browser");
    expect(invoke).toHaveBeenCalledWith("settings:link-opening:update", desired);
  });
  it("rolls back failed preference writes to the saved Profile values", async () => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    rejectSave = true;
    await act(async () => {
      await expect(
        hook.result.current.updateSettings({ ...saved, openLocalUrlInTarget: "external-browser" }),
      ).rejects.toThrow("Write failed");
    });
    expect(hook.result.current.settings).toEqual(DEFAULT_LINK_OPENING_SETTINGS);
    expect(hook.result.current.isSaving).toBe(false);
  });
});
