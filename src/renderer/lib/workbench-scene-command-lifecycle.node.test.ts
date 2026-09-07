import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import {
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  type WorkbenchSceneOwner,
  type WorkbenchSurfaceDescriptor,
} from "../../shared/workbench-scene";
import {
  createMaitaiStore,
  createScopeHandle,
  disposeMaitaiStore,
  getMaitaiRootView,
} from "./maitai/maitai-store";
import { getWorkbenchWindowOwner } from "./workbench-window-owner";
import { createWorkbenchSceneCommands } from "./workbench-scene-commands";
import { createWorkbenchSceneCommandLifecycle } from "./workbench-scene-command-lifecycle";
import { readWorkbenchAgentContext } from "./workbench-agent-context";

const runtime = vi.hoisted(() => ({
  flushFile: vi.fn(),
  getEditor: vi.fn(),
  disposeEditor: vi.fn(),
  persistPage: vi.fn(),
  flushCanvas: vi.fn(),
  disposeCanvas: vi.fn(),
  releaseTerminal: vi.fn(),
  invoke: vi.fn(),
  discardSideChat: vi.fn(),
}));
vi.mock("../features/workspace-files/workspace-text-document-controller", () => ({
  workspaceTextDocumentRegistry: { flush: runtime.flushFile },
}));
vi.mock("./document-session-registry", () => ({
  documentSessionRegistry: { get: runtime.getEditor, dispose: runtime.disposeEditor },
  makeEditorSurfaceKey: (ownerId: string, tabId: string) => `${ownerId}\u0000${tabId}`,
}));
vi.mock("./canvas-scene-surface-runtime", () => ({
  canvasSceneSurfaceRegistry: {
    flushOwnerCommitted: runtime.flushCanvas,
    dispose: runtime.disposeCanvas,
  },
  makeCanvasSceneSurfaceKey: (windowId: string, ownerId: string, tabId: string) =>
    JSON.stringify([windowId, ownerId, tabId]),
}));
vi.mock("./terminal-session-store", () => ({
  terminalSessionStore: { release: runtime.releaseTerminal },
}));
vi.mock("./renderer-command", () => ({
  defineRendererCommand: (definition: unknown) => definition,
  invokePlainCommand: runtime.invoke,
}));

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
beforeEach(() => {
  vi.resetAllMocks();
  runtime.flushFile.mockResolvedValue(true);
  runtime.persistPage.mockResolvedValue({
    timedOut: false,
    flush: "completed",
    checkpoint: "completed",
  });
  runtime.getEditor.mockReturnValue({ runtime: { persist: runtime.persistPage } });
  runtime.disposeEditor.mockResolvedValue(undefined);
  runtime.flushCanvas.mockResolvedValue(undefined);
  runtime.disposeCanvas.mockResolvedValue(undefined);
  runtime.invoke.mockResolvedValue(undefined);
  runtime.discardSideChat.mockResolvedValue(undefined);
});

function fixture(sceneOwner: WorkbenchSceneOwner, surfaces: readonly WorkbenchSurfaceDescriptor[]) {
  const store = createMaitaiStore();
  disposers.push(() => disposeMaitaiStore(store));
  const scene = surfaces.reduce(
    (current, surface) => createWorkbenchSceneSurface(current, { panelId: "right", surface }),
    materializeInitialWorkbenchScene(sceneOwner),
  );
  const owner = getWorkbenchWindowOwner(createScopeHandle(getMaitaiRootView(store)), {
    ...createDefaultWorkbenchLayoutSnapshot(),
    scenesByOwnerKey: { [makeWorkbenchSceneKey(sceneOwner)]: scene },
  });
  owner.initialize();
  owner.registerPersistenceCommit(async (snapshot) => ({
    ...snapshot,
    sessionId: "window-a",
    layoutRevision: snapshot.presentationRevision,
  }));
  const executor = createWorkbenchSceneCommands(
    owner,
    createWorkbenchSceneCommandLifecycle({
      owner,
      windowSessionId: "window-a",
      discardSideChat: runtime.discardSideChat,
    }),
  );
  let operationId = 0;
  return {
    owner,
    close: (tabId: string) =>
      executor.execute({
        operationId: `close-${++operationId}`,
        sceneOwner,
        expectedPresentationRevision: owner.read().presentationRevision,
        command: { kind: "close_tab", tabId },
      }),
    tabIds: () => readWorkbenchAgentContext(owner.read(), sceneOwner)!.tabs.map((tab) => tab.tabId),
  };
}

const common = (id: string) => ({ id, titleSnapshot: id, stateKey: 0, state: null });

describe("Workbench Scene content and runtime close boundary", () => {
  test("requires a completed Page flush and checkpoint before descriptor removal and lease disposal", async () => {
    const subject = fixture({ kind: "pages" }, [
      {
        ...common("page-tab"),
        kind: "page_stage",
        config: { accessContext: { kind: "library" }, pageId: "page-a" },
      },
    ]);
    runtime.persistPage.mockResolvedValueOnce({
      timedOut: false,
      flush: "failed",
      checkpoint: "completed",
    });
    expect(await subject.close("page-tab")).toMatchObject({ applied: false, error: "save_failed" });
    expect(subject.tabIds()).toEqual(["page-tab"]);
    expect(runtime.disposeEditor).not.toHaveBeenCalled();
    runtime.disposeEditor.mockImplementation(async () => {
      expect(subject.tabIds()).toEqual([]);
    });
    expect(await subject.close("page-tab")).toMatchObject({
      applied: true,
      persisted: true,
      error: null,
    });
    expect(runtime.getEditor).toHaveBeenCalledWith("library-page:page-tab");
    expect(runtime.disposeEditor).toHaveBeenCalledExactlyOnceWith("library-page:page-tab");
  });

  test("preserves a File conflict and a Canvas whose pending changes cannot be committed", async () => {
    const file = fixture({ kind: "session", sessionId: "session-a" }, [
      {
        ...common("file-tab"),
        kind: "files",
        config: {
          projectId: null,
          hostId: "local",
          workspaceRoot: "/workspace",
          cwd: "/workspace",
          path: "/workspace/file.md",
        },
      },
    ]);
    runtime.flushFile.mockResolvedValueOnce(false);
    expect(await file.close("file-tab")).toMatchObject({ applied: false, error: "save_failed" });
    expect(file.tabIds()).toContain("file-tab");
    expect(runtime.flushFile).toHaveBeenCalledExactlyOnceWith("file-tab");
    const canvas = fixture({ kind: "pages" }, [
      {
        ...common("canvas-tab"),
        kind: "canvas_stage",
        config: { accessContext: { kind: "library" }, canvasBlockId: "canvas-a" },
      },
    ]);
    runtime.flushCanvas.mockRejectedValueOnce(new Error("offline"));
    expect(await canvas.close("canvas-tab")).toMatchObject({
      applied: false,
      error: "save_failed",
    });
    expect(canvas.tabIds()).toEqual(["canvas-tab"]);
    expect(runtime.disposeCanvas).not.toHaveBeenCalled();
    expect(await canvas.close("canvas-tab")).toMatchObject({ applied: true, error: null });
    expect(runtime.flushCanvas).toHaveBeenCalledWith("canvas-a");
    expect(runtime.disposeCanvas).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(["window-a", "pages", "canvas-tab"]),
    );
  });

  test("releases the Terminal lease through its owner Interface", async () => {
    const subject = fixture({ kind: "session", sessionId: "session-a" }, [
      {
        ...common("terminal-tab"),
        kind: "terminal",
        config: { terminalSessionId: "terminal-runtime-a" },
      },
    ]);
    expect(await subject.close("terminal-tab")).toMatchObject({ applied: true, error: null });
    expect(runtime.releaseTerminal).toHaveBeenCalledExactlyOnceWith("terminal-runtime-a");
    expect(runtime.invoke).not.toHaveBeenCalled();
  });

  test("retains a Browser runtime still presented by another tab and closes the exact owner when its final tab closes", async () => {
    const subject = fixture({ kind: "project", projectId: "project-a" }, [
      { ...common("browser-one"), kind: "browser", config: { browserTabId: "browser-runtime" } },
      { ...common("browser-two"), kind: "browser", config: { browserTabId: "browser-runtime" } },
    ]);
    await subject.close("browser-one");
    expect(runtime.invoke).not.toHaveBeenCalled();
    await subject.close("browser-two");
    expect(runtime.invoke).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ channel: "browser-sidebar-command" }),
      {
        type: "close-tab",
        browserConversationId: "project:project-a",
        browserViewScopeId: "window-a",
        browserTabId: "browser-runtime",
      },
    );
  });
});
