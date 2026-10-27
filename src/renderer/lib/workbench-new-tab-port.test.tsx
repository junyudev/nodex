import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import {
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  type WorkbenchSceneOwner,
} from "../../shared/workbench-scene";
import {
  createMaitaiStore,
  createScopeHandle,
  disposeMaitaiStore,
  getMaitaiRootView,
} from "./maitai/maitai-store";
import { useWorkbenchNewTabPortValue } from "./workbench-new-tab-port";
import type { ExecuteWorkbenchUiCommand } from "./use-workbench-scene-commands";
import { getWorkbenchWindowOwner } from "./workbench-window-owner";

describe("New tab port", () => {
  test("runs one intent at a time for each New tab", async () => {
    const owner: WorkbenchSceneOwner = { kind: "project", projectId: "project" };
    const store = createMaitaiStore();
    const scene = createWorkbenchSceneSurface(materializeInitialWorkbenchScene(owner), {
      panelId: "right",
      surface: {
        id: "new",
        kind: "browser",
        titleSnapshot: "New tab",
        stateKey: 0,
        state: null,
        config: { browserTabId: "new-browser" },
      },
    });
    const windowOwner = getWorkbenchWindowOwner(createScopeHandle(getMaitaiRootView(store)), {
      ...createDefaultWorkbenchLayoutSnapshot(),
      scenesByOwnerKey: { [makeWorkbenchSceneKey(owner)]: scene },
    });
    windowOwner.initialize();
    let finishCreation: (opened: boolean) => void = () => undefined;
    const runAction = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishCreation = resolve;
        }),
    );
    const view = renderHook(() =>
      useWorkbenchNewTabPortValue({
        windowOwner,
        executeSceneCommand: vi.fn<ExecuteWorkbenchUiCommand>(),
        isMac: true,
        commandKeymapState: null,
        projects: [],
        commands: {
          resolveOwnerContext: () => null,
          runAction,
          openDestination: async () => false,
          openLibraryTarget: async () => false,
          returnToChat: () => undefined,
        },
      }),
    );
    try {
      const intent = { kind: "action", action: "new_page" } as const;
      let first: Promise<void> = Promise.resolve();
      await act(async () => {
        first = view.result.current.open({ owner, surfaceId: "new", intent });
        await view.result.current.open({ owner, surfaceId: "new", intent });
      });
      expect(runAction).toHaveBeenCalledOnce();

      await act(async () => {
        finishCreation(false);
        await first;
      });
      await act(async () => {
        void view.result.current.open({ owner, surfaceId: "new", intent });
        await Promise.resolve();
      });
      expect(runAction).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      disposeMaitaiStore(store);
    }
  });
});
