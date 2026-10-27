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
import { readWorkbenchAgentContext } from "./workbench-agent-context";
import { useWorkbenchNewTabPortValue } from "./workbench-new-tab-port";
import { createWorkbenchSceneCommands } from "./workbench-scene-commands";
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

  test.each<WorkbenchSceneOwner>([
    { kind: "session", sessionId: "session" },
    { kind: "project", projectId: "project" },
  ])(
    "selects a tab in the other panel before retiring the New tab in a $kind Scene",
    async (owner) => {
      const store = createMaitaiStore();
      const scene = (
        [
          { panelId: "bottom", id: "target" },
          { panelId: "bottom", id: "other" },
          { panelId: "right", id: "new" },
        ] as const
      ).reduce(
        (current, { panelId, id }) =>
          createWorkbenchSceneSurface(current, {
            panelId,
            surface: {
              id,
              kind: "browser",
              titleSnapshot: id,
              stateKey: 0,
              state: null,
              config: { browserTabId: `${id}-browser` },
            },
          }),
        materializeInitialWorkbenchScene(owner),
      );
      const windowOwner = getWorkbenchWindowOwner(createScopeHandle(getMaitaiRootView(store)), {
        ...createDefaultWorkbenchLayoutSnapshot(),
        ...(owner.kind === "session"
          ? {
              location: {
                kind: "session" as const,
                sessionId: owner.sessionId,
                projectContextId: null,
              },
            }
          : {}),
        scenesByOwnerKey: { [makeWorkbenchSceneKey(owner)]: scene },
      });
      windowOwner.initialize();
      const openedSessions: string[] = [];
      const unregisterOpened = windowOwner.registerSessionOpened((id) => openedSessions.push(id));
      windowOwner.registerPersistenceCommit(async (snapshot) => ({
        ...snapshot,
        sessionId: "window",
        layoutRevision: 1,
      }));
      const selectedWhenClosing: (string | null | undefined)[] = [];
      const executor = createWorkbenchSceneCommands(windowOwner, {
        close: async () => undefined,
        prepareClose: async () => {
          selectedWhenClosing.push(
            readWorkbenchAgentContext(windowOwner.read(), owner)?.groups.find(
              (group) => group.panelId === "bottom",
            )?.selectedTabId,
          );
          return true;
        },
      });
      let operation = 0;
      const executeSceneCommand = vi.fn<ExecuteWorkbenchUiCommand>(async (sceneOwner, command) =>
        executor.execute({
          sceneOwner,
          command,
          operationId: `operation-${++operation}`,
          expectedPresentationRevision: windowOwner.read().presentationRevision,
        }),
      );
      const view = renderHook(() =>
        useWorkbenchNewTabPortValue({
          windowOwner,
          executeSceneCommand,
          isMac: true,
          commandKeymapState: null,
          projects: [],
          commands: {
            resolveOwnerContext: () => null,
            runAction: async () => false,
            openDestination: async () => false,
            openLibraryTarget: async () => false,
            returnToChat: () => undefined,
          },
        }),
      );
      try {
        expect(
          readWorkbenchAgentContext(windowOwner.read(), owner)?.groups.find(
            (group) => group.panelId === "bottom",
          )?.selectedTabId,
        ).toBe("other");
        await act(async () => {
          await view.result.current.open({
            owner,
            surfaceId: "new",
            intent: { kind: "tab", tabId: "missing" },
          });
          await view.result.current.open({
            owner,
            surfaceId: "new",
            intent: { kind: "tab", tabId: "new" },
          });
        });
        expect(executeSceneCommand).not.toHaveBeenCalled();
        await act(async () => {
          await view.result.current.open({
            owner,
            surfaceId: "new",
            intent: { kind: "tab", tabId: "target" },
          });
        });
        const observation = readWorkbenchAgentContext(windowOwner.read(), owner);
        expect(observation?.tabs.some((tab) => tab.tabId === "new")).toBe(false);
        expect(observation?.groups.find((group) => group.panelId === "bottom")?.selectedTabId).toBe(
          "target",
        );
        expect(selectedWhenClosing).toEqual(["target"]);
        expect(openedSessions).toEqual([]);
        if (owner.kind === "session") {
          expect(windowOwner.read().windowState.location).toEqual({
            kind: "session",
            sessionId: owner.sessionId,
            projectContextId: null,
          });
          await act(async () => {
            windowOwner.selectLibrary();
            windowOwner.selectSession({ id: owner.sessionId, projectId: null });
          });
          expect(openedSessions).toEqual([owner.sessionId]);
        }
        expect(executeSceneCommand.mock.calls.map(([, command]) => command)).toEqual([
          { kind: "activate_tab", tabId: "target" },
          { kind: "close_tab", tabId: "new" },
        ]);
      } finally {
        unregisterOpened();
        view.unmount();
        disposeMaitaiStore(store);
      }
    },
  );
});
