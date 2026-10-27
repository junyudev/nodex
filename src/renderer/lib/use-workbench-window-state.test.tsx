import type { PropsWithChildren } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  createDefaultWorkbenchLayoutSnapshot,
  getWorkbenchPrimaryDestination,
} from "../../shared/workbench-layout";
import {
  materializeInitialWorkbenchScene,
  type WorkbenchSceneOwner,
} from "../../shared/workbench-scene";
import type {
  WindowSessionBootstrap,
  WindowSessionSaveLayoutInput,
} from "../../shared/window-session";
import { createMaitaiStore, MaitaiProvider } from "./maitai";
import { useWorkbenchWindowOwner, useWorkbenchWindowState } from "./use-workbench-window-state";
import { useWorkbenchPanelController } from "./use-workbench-panel-controller";
import { WorkbenchPresentationConflict } from "./workbench-window-owner";
import {
  useWindowSessionLayoutPersistence,
  windowSessionLayoutPersistenceTiming,
} from "./use-window-session-layout-persistence";
import { saveWindowSessionLayout } from "./window-sessions";
import { makeWorkbenchSessionPanelSlotKey } from "./workbench-panel-slot-key";

vi.mock("./window-sessions", () => ({ saveWindowSessionLayout: vi.fn() }));

function wrapper() {
  const store = createMaitaiStore();
  return function Wrapper({ children }: PropsWithChildren) {
    return <MaitaiProvider store={store}>{children}</MaitaiProvider>;
  };
}

function accept(input: WindowSessionSaveLayoutInput): WindowSessionBootstrap {
  return {
    session: {
      id: input.sessionId,
      lifecycle: { state: "open" },
      layoutRevision: input.revision,
      layout: input.layout,
      createdAt: "2026-09-08T00:00:00Z",
      updatedAt: "2026-09-08T00:00:00Z",
      focusedAt: "2026-09-08T00:00:00Z",
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Workbench synchronous Window owner", () => {
  test("records only explicit foreground Session navigation, never restoration or background updates", async () => {
    const view = renderHook(() => useWorkbenchWindowState(), { wrapper: wrapper() });
    const owner = view.result.current.owner;
    const opened: string[] = [];
    const unregister = owner.registerSessionOpened((id) => opened.push(id));
    await act(async () => {
      owner.selectSession({ id: "one", projectId: null });
      owner.selectSession({ id: "one", projectId: null });
      owner.selectSession({ id: "two", projectId: null });
      owner.navigateBack();
      owner.navigateForward();
      owner.openRoute({ kind: "automations", path: "/automations" });
      owner.selectProject(null);
      owner.navigateBack();
      owner.presentScheduledSession({
        path: "/automations?runSessionId=scheduled",
        session: { id: "scheduled", projectId: null },
      });
      owner.replaceFromSnapshot({
        ...createDefaultWorkbenchLayoutSnapshot(),
        location: { kind: "session", sessionId: "restored", projectContextId: null },
      });
      owner.navigate(
        { kind: "session", sessionId: "silent", projectContextId: null },
        { record: false },
      );
      await Promise.resolve();
    });
    expect(opened).toEqual(["one", "two", "one", "two", "scheduled"]);
    unregister();
    await act(async () => {
      owner.selectSession({ id: "after-unmount", projectId: null });
      await Promise.resolve();
    });
    expect(opened).toHaveLength(5);
  });

  test("persists and returns to Inbox when Settings opens from Home over Space", async () => {
    const view = renderHook(() => useWorkbenchWindowState(), { wrapper: wrapper() });
    const owner = view.result.current.owner;
    await act(async () => {
      owner.selectLibrary();
      owner.selectInbox();
      owner.openRoute({ kind: "settings", path: "/settings/inbox" });
      await Promise.resolve();
    });
    const origin = { kind: "inbox" };
    expect(getWorkbenchPrimaryDestination(view.result.current.location)).toBe("home");
    expect(owner.snapshotForPersistence().location).toEqual({
      kind: "settings",
      path: "/settings/inbox",
      returnTo: origin,
    });
    expect(owner.read().presentationRevision).toBe(3);
    await act(async () => {
      owner.closeRoute();
      await Promise.resolve();
    });
    expect(view.result.current.location).toEqual(origin);
    expect(owner.read().presentationRevision).toBe(4);
  });

  test("restores Home through the same owner and publishes one transition per destination switch", async () => {
    const view = renderHook(() => useWorkbenchWindowState(), { wrapper: wrapper() });
    const owner = view.result.current.owner;
    const seen: number[] = [];
    const unsubscribe = owner.subscribe(() => seen.push(owner.read().presentationRevision));

    await act(async () => {
      owner.selectInbox();
      owner.selectLibrary();
      expect(owner.snapshotForPersistence().homeLocation).toEqual({ kind: "inbox" });
      owner.selectHome();
      owner.selectHome();
      await Promise.resolve();
    });

    expect(view.result.current.location).toEqual({ kind: "inbox" });
    expect(view.result.current.state.history.backStack).toHaveLength(3);
    expect(seen).toEqual([1, 2, 3]);
    unsubscribe();
  });

  test("a submit reader mounted before the shell does not replace its bootstrap layout", () => {
    const sharedWrapper = wrapper();
    const earlyReader = renderHook(() => useWorkbenchWindowOwner(), { wrapper: sharedWrapper });
    const initialLayout = {
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: { kind: "library" as const },
    };
    const shell = renderHook(() => useWorkbenchWindowState(initialLayout), {
      wrapper: sharedWrapper,
    });
    expect(shell.result.current.owner).toBe(earlyReader.result.current);
    expect(earlyReader.result.current.read().windowState.location).toEqual({ kind: "library" });
    expect(shell.result.current.location).toEqual({ kind: "library" });
    expect(shell.result.current.owner.read().presentationRevision).toBe(0);
  });

  test("shares one live owner per window and fences durable edits against ephemeral and focus changes", async () => {
    const firstWindow = renderHook(
      () => ({ first: useWorkbenchWindowState(), second: useWorkbenchWindowState() }),
      { wrapper: wrapper() },
    );
    const secondWindow = renderHook(() => useWorkbenchWindowState(), { wrapper: wrapper() });
    const owner = firstWindow.result.current.first.owner;
    expect(firstWindow.result.current.second.owner).toBe(owner);
    const seen: number[] = [];
    const unsubscribe = owner.subscribe(() => seen.push(owner.read().presentationRevision));
    const libraryOwner: WorkbenchSceneOwner = { kind: "library" };
    const libraryScene = materializeInitialWorkbenchScene(libraryOwner);

    await act(async () => {
      owner.setScene(libraryOwner, () => libraryScene, { expectedPresentationRevision: 0 });
      owner.dispatchEphemeral({
        type: "update",
        field: "panelCollapsedOverrides",
        update: { "session-a:right": true },
      });
      owner.setFocusedPanelGroup({ ownerKey: "library", panelId: "right", leafId: "leaf-a" });
      const beforeConflict = owner.read();
      expect(beforeConflict.presentationRevision).toBe(3);
      expect(() =>
        owner.setScene(libraryOwner, () => libraryScene, { expectedPresentationRevision: 1 }),
      ).toThrow(WorkbenchPresentationConflict);
      expect(owner.read()).toBe(beforeConflict);
      expect(owner.snapshotForPersistence().scenesByOwnerKey.library).toEqual(libraryScene);
      expect(owner.snapshotForPersistence()).not.toHaveProperty("ephemeralPanels");
      expect(secondWindow.result.current.owner.read().presentationRevision).toBe(0);
      owner.selectLibrary();
      expect(owner.read().focusedPanelGroup).toBeNull();
      await Promise.resolve();
    });

    expect(firstWindow.result.current.second.location).toEqual({ kind: "library" });
    expect(seen).toEqual([1, 2, 3, 4]);
    unsubscribe();
    await act(async () => {
      owner.selectProject("project-b");
      await Promise.resolve();
    });
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  test("selects and removes a newly opened auxiliary tab before React renders again", async () => {
    const view = renderHook(
      () => {
        const window = useWorkbenchWindowState();
        const panels = useWorkbenchPanelController({
          mutateScene: (owner, mutation) => {
            const next = window.owner.setScene(owner, (previous) =>
              mutation(previous ?? materializeInitialWorkbenchScene(owner)),
            );
            const key =
              owner.kind === "session"
                ? `session:${owner.sessionId}`
                : owner.kind === "project"
                  ? `project:${owner.projectId}`
                  : owner.kind;
            return next.windowState.scenesByOwnerKey[key]!;
          },
        });
        return { window, panels };
      },
      { wrapper: wrapper() },
    );
    const { panels, window } = view.result.current;
    await act(async () => {
      panels.updateSideChatTabsBySession({
        "session-a": [
          {
            sideChat: true,
            id: "side-a",
            sessionId: "session-a",
            panelId: "right",
            leafId: "leaf-a",
            parentThreadId: "thread-a",
            parentNavigationPath: "/",
            threadId: null,
            title: "Side chat",
            status: "loading",
            stateKey: 0,
          },
        ],
      });
      expect(
        panels.selectRenderableTab({
          sessionId: "session-a",
          panelId: "right",
          leafId: "leaf-a",
          tabId: "side-a",
          durableTabIds: new Set(),
        }),
      ).toBe(true);
      expect(
        window.owner.read().ephemeralPanels.sideChatActiveTabByPanel[
          makeWorkbenchSessionPanelSlotKey("session-a", "right", "leaf-a")
        ],
      ).toBe("side-a");
      expect(
        panels.removeEphemeralTab({
          sessionId: "session-a",
          panelId: "right",
          leafId: "leaf-a",
          tabId: "side-a",
        })?.id,
      ).toBe("side-a");
      expect(window.owner.read().ephemeralPanels.sideChatTabsBySession["session-a"]).toHaveLength(
        0,
      );
      await Promise.resolve();
    });
    expect(view.result.current.panels.sideChatTabsBySession["session-a"]).toHaveLength(0);
  });

  test("commits a post-command snapshot immediately and preserves later debounced edits", async () => {
    vi.useFakeTimers();
    const initialLayout = createDefaultWorkbenchLayoutSnapshot();
    let finishFirstSave!: (result: WindowSessionBootstrap) => void;
    const firstSave = new Promise<WindowSessionBootstrap>((resolve) => {
      finishFirstSave = resolve;
    });
    vi.mocked(saveWindowSessionLayout)
      .mockImplementationOnce(() => firstSave)
      .mockImplementation(async (input) => accept(input));
    const view = renderHook(
      () => {
        const window = useWorkbenchWindowState(initialLayout);
        useWindowSessionLayoutPersistence({
          sessionId: "window-a",
          initialRevision: 4,
          initialLayout,
          owner: window.owner,
        });
        return window;
      },
      { wrapper: wrapper() },
    );
    const { owner } = view.result.current;
    let receiptPromise: ReturnType<typeof owner.commitCurrent> | undefined;
    await act(async () => {
      owner.selectLibrary();
      receiptPromise = owner.commitCurrent();
      owner.selectProject("project-b");
      await Promise.resolve();
    });
    expect(saveWindowSessionLayout).toHaveBeenCalledTimes(1);
    const firstRequest = vi.mocked(saveWindowSessionLayout).mock.calls[0]![0];
    expect(firstRequest.layout.location).toEqual({ kind: "library" });

    await act(async () => {
      finishFirstSave(accept(firstRequest));
      await receiptPromise;
    });
    await expect(receiptPromise).resolves.toMatchObject({
      layoutRevision: 5,
      presentationRevision: 1,
      layout: { location: { kind: "library" } },
    });
    expect(owner.read().presentationRevision).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(windowSessionLayoutPersistenceTiming.saveDebounceMs);
    });
    expect(saveWindowSessionLayout).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveWindowSessionLayout).mock.calls[1]![0]).toMatchObject({
      revision: 6,
      layout: { location: { kind: "project", projectId: "project-b" } },
    });
    view.unmount();
    await expect(owner.commitCurrent()).rejects.toThrow("persistence is unavailable");
  });
});
