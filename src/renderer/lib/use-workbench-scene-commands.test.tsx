import { StrictMode, Suspense, type PropsWithChildren } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import {
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
} from "../../shared/workbench-scene";
import {
  createMaitaiStore,
  createScopeHandle,
  disposeMaitaiStore,
  getMaitaiRootView,
} from "./maitai/maitai-store";
import { createWorkbenchPanelTabOpenerStore } from "./workbench-panel-tab-opener-state";
import { getWorkbenchWindowOwner } from "./workbench-window-owner";
import type { createWorkbenchSceneCommandLifecycle } from "./workbench-scene-command-lifecycle";
import { useWorkbenchSceneCommands } from "./use-workbench-scene-commands";

const boundary = vi.hoisted(() => ({
  prepare: vi.fn<() => Promise<boolean>>(async () => true),
  confirm: vi.fn(async () => true),
  created: vi.fn(),
  danger: vi.fn(),
}));
vi.mock("./use-side-chat-close-confirmation", () => ({
  useSideChatCloseConfirmation: () => boundary.confirm,
}));
vi.mock("../components/ui/toast", () => ({ toast: { danger: boundary.danger } }));
vi.mock("./workbench-scene-command-lifecycle", () => ({
  createWorkbenchSceneCommandLifecycle: (
    input: Parameters<typeof createWorkbenchSceneCommandLifecycle>[0],
  ) => {
    boundary.created();
    return {
      prepareClose: () => boundary.prepare(),
      close: () => input.discardSideChat("child-thread"),
    };
  },
}));

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.clearAllMocks();
});

function fixture() {
  const store = createMaitaiStore();
  disposers.push(() => disposeMaitaiStore(store));
  const sceneOwner = { kind: "library" as const };
  const scene = createWorkbenchSceneSurface(materializeInitialWorkbenchScene(sceneOwner), {
    panelId: "right",
    surface: {
      id: "page",
      kind: "page_stage",
      titleSnapshot: "Page",
      state: null,
      stateKey: 0,
      config: { routingContext: { kind: "library" }, pageId: "page" },
    },
  });
  const owner = getWorkbenchWindowOwner(createScopeHandle(getMaitaiRootView(store)), {
    ...createDefaultWorkbenchLayoutSnapshot(),
    location: { kind: "library" },
    scenesByOwnerKey: { [makeWorkbenchSceneKey(sceneOwner)]: scene },
  });
  owner.initialize();
  owner.registerPersistenceCommit(async (snapshot) => ({
    ...snapshot,
    sessionId: "window",
    layoutRevision: 1,
  }));
  return { owner, sceneOwner, tabOpenerStore: createWorkbenchPanelTabOpenerStore() };
}

const strict = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>;

describe("committed Scene command runtime", () => {
  test("does not construct a lifecycle for suspended, uncommitted work", () => {
    const { owner, tabOpenerStore } = fixture();
    const pending = new Promise<void>(() => {});
    function Probe(): never {
      useWorkbenchSceneCommands(owner, "window", async () => {}, tabOpenerStore);
      throw pending;
    }
    const view = render(
      <Suspense fallback="Waiting">
        <Probe />
      </Suspense>,
    );
    expect(boundary.created).not.toHaveBeenCalled();
    view.unmount();
  });

  test("keeps its executor stable and uses the latest committed handler after preparation", async () => {
    const { owner, sceneOwner, tabOpenerStore } = fixture();
    let release!: (value: boolean) => void;
    boundary.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = vi.fn(async () => {});
    const latest = vi.fn(async () => {});
    const view = renderHook(
      ({ discard }) => useWorkbenchSceneCommands(owner, "window", discard, tabOpenerStore),
      { initialProps: { discard: first }, wrapper: strict },
    );
    const commands = view.result.current;
    let closing!: ReturnType<typeof commands.execute>;
    await act(async () => {
      closing = commands.execute(sceneOwner, { kind: "close_tab", tabId: "page" });
    });
    await waitFor(() => expect(boundary.prepare).toHaveBeenCalledOnce());
    const constructions = boundary.created.mock.calls.length;
    view.rerender({ discard: latest });
    expect(view.result.current.executor).toBe(commands.executor);
    expect(view.result.current.execute).toBe(commands.execute);
    expect(boundary.created).toHaveBeenCalledTimes(constructions);
    await act(async () => {
      release(true);
      expect(await closing).toMatchObject({ applied: true, persisted: true });
    });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith("child-thread");
    view.unmount();
  });

  test.each(["window", "owner", "unmount"])(
    "revokes pending work on %s disposal",
    async (change) => {
      const { owner, sceneOwner, tabOpenerStore } = fixture();
      const replacement = fixture();
      let release!: (value: boolean) => void;
      boundary.prepare.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const discard = vi.fn(async () => {});
      const view = renderHook(
        ({ currentOwner, windowId }) =>
          useWorkbenchSceneCommands(currentOwner, windowId, discard, tabOpenerStore),
        { initialProps: { currentOwner: owner, windowId: "first" }, wrapper: strict },
      );
      let closing!: ReturnType<typeof view.result.current.execute>;
      await act(async () => {
        closing = view.result.current.execute(sceneOwner, { kind: "close_tab", tabId: "page" });
      });
      await waitFor(() => expect(boundary.prepare).toHaveBeenCalledOnce());
      if (change === "unmount") view.unmount();
      else
        view.rerender({
          currentOwner: change === "owner" ? replacement.owner : owner,
          windowId: "second",
        });
      await act(async () => {
        release(true);
        expect(await closing).toMatchObject({ applied: false, error: "revoked_generation" });
      });
      expect(discard).not.toHaveBeenCalled();
      expect(boundary.danger).not.toHaveBeenCalled();
      view.unmount();
    },
  );
});
