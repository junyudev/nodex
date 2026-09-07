import type { PropsWithChildren } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
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
  test("a submit reader mounted before the shell does not replace its bootstrap layout", () => {
    const sharedWrapper = wrapper();
    const earlyReader = renderHook(() => useWorkbenchWindowOwner(), { wrapper: sharedWrapper });
    const initialLayout = {
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: { kind: "pages" as const },
    };
    const shell = renderHook(() => useWorkbenchWindowState(initialLayout), {
      wrapper: sharedWrapper,
    });
    expect(shell.result.current.owner).toBe(earlyReader.result.current);
    expect(earlyReader.result.current.read().windowState.location).toEqual({ kind: "pages" });
    expect(shell.result.current.location).toEqual({ kind: "pages" });
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
    const pagesOwner: WorkbenchSceneOwner = { kind: "pages" };
    const pagesScene = materializeInitialWorkbenchScene(pagesOwner);

    await act(async () => {
      owner.setScene(pagesOwner, () => pagesScene, { expectedPresentationRevision: 0 });
      owner.dispatchEphemeral({
        type: "update",
        field: "panelCollapsedOverrides",
        update: { "session-a:right": true },
      });
      owner.setFocusedPanelGroup({ ownerKey: "pages", panelId: "right", leafId: "leaf-a" });
      const beforeConflict = owner.read();
      expect(beforeConflict.presentationRevision).toBe(3);
      expect(() =>
        owner.setScene(pagesOwner, () => pagesScene, { expectedPresentationRevision: 1 }),
      ).toThrow(WorkbenchPresentationConflict);
      expect(owner.read()).toBe(beforeConflict);
      expect(owner.snapshotForPersistence().scenesByOwnerKey.pages).toEqual(pagesScene);
      expect(owner.snapshotForPersistence()).not.toHaveProperty("ephemeralPanels");
      expect(secondWindow.result.current.owner.read().presentationRevision).toBe(0);
      owner.selectPages();
      expect(owner.read().focusedPanelGroup).toBeNull();
      await Promise.resolve();
    });

    expect(firstWindow.result.current.second.location).toEqual({ kind: "pages" });
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
                  : "pages";
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
      owner.selectPages();
      receiptPromise = owner.commitCurrent();
      owner.selectProject("project-b");
      await Promise.resolve();
    });
    expect(saveWindowSessionLayout).toHaveBeenCalledTimes(1);
    const firstRequest = vi.mocked(saveWindowSessionLayout).mock.calls[0]![0];
    expect(firstRequest.layout.location).toEqual({ kind: "pages" });

    await act(async () => {
      finishFirstSave(accept(firstRequest));
      await receiptPromise;
    });
    await expect(receiptPromise).resolves.toMatchObject({
      layoutRevision: 5,
      presentationRevision: 1,
      layout: { location: { kind: "pages" } },
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
