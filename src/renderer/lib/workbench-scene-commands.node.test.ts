import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  WORKBENCH_COMMAND_MAX_RECEIPTS,
  WorkbenchCommandEnvelopeSchema,
  type WorkbenchCommand,
  type WorkbenchCommandEnvelope,
} from "../../shared/nodex-app-tools/workbench-commands";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import {
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
} from "../../shared/workbench-scene";
import {
  createMaitaiStore,
  createScopeHandle,
  disposeMaitaiStore,
  getMaitaiRootView,
} from "./maitai/maitai-store";
import { createWorkbenchAgentCommands } from "./workbench-agent-commands";
import { readWorkbenchAgentContext } from "./workbench-agent-context";
import { makeWorkbenchPanelSlotKey } from "./workbench-panel-slot-key";
import { presentWorkbenchSessionPanelsWithScene } from "./workbench-scene-presentation";
import { createWorkbenchPanelTabOpenerStore } from "./workbench-panel-tab-opener-state";
import { workbenchSceneCommandOpenerLifecycle } from "./workbench-scene-command-opener";
import {
  createWorkbenchSceneCommands,
  type WorkbenchSceneCommandLifecycle,
} from "./workbench-scene-commands";
import {
  getWorkbenchWindowOwner,
  type WorkbenchWindowPersistenceReceipt,
} from "./workbench-window-owner";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function page(id: string): WorkbenchSurfaceDescriptor {
  return {
    id,
    kind: "page_stage",
    titleSnapshot: id,
    stateKey: 0,
    state: null,
    config: { accessContext: { kind: "library" }, pageId: `page:${id}` },
  };
}
function browser(id: string): WorkbenchSurfaceDescriptor {
  return {
    id,
    kind: "browser",
    titleSnapshot: id,
    stateKey: 0,
    state: null,
    config: { browserTabId: `browser:${id}` },
  };
}
function seededScene(
  sceneOwner: WorkbenchSceneOwner,
  surfaces: readonly WorkbenchSurfaceDescriptor[],
) {
  return surfaces.reduce(
    (scene, surface) => createWorkbenchSceneSurface(scene, { panelId: "right", surface }),
    materializeInitialWorkbenchScene(sceneOwner),
  );
}

function fixture(scene: WorkbenchSceneSnapshot) {
  const store = createMaitaiStore();
  disposers.push(() => disposeMaitaiStore(store));
  const owner = getWorkbenchWindowOwner(createScopeHandle(getMaitaiRootView(store)), {
    ...createDefaultWorkbenchLayoutSnapshot(),
    scenesByOwnerKey: { [makeWorkbenchSceneKey(scene.owner)]: scene },
  });
  owner.initialize();
  let layoutRevision = 0;
  const commit = vi.fn<
    (
      snapshot: Parameters<Parameters<typeof owner.registerPersistenceCommit>[0]>[0],
    ) => Promise<WorkbenchWindowPersistenceReceipt>
  >(async (snapshot) => ({ ...snapshot, sessionId: "window-a", layoutRevision: ++layoutRevision }));
  owner.registerPersistenceCommit(commit);
  const lifecycle = {
    prepareClose: vi.fn<WorkbenchSceneCommandLifecycle["prepareClose"]>(async () => true),
    close: vi.fn<WorkbenchSceneCommandLifecycle["close"]>(async () => {}),
  };
  const executor = createWorkbenchSceneCommands(owner, lifecycle);
  let nextOperation = 0;
  const envelope = (command: WorkbenchCommand): WorkbenchCommandEnvelope => ({
    operationId: `operation-${++nextOperation}`,
    sceneOwner: scene.owner,
    expectedPresentationRevision: owner.read().presentationRevision,
    command,
  });
  const execute = (command: WorkbenchCommand) => executor.execute(envelope(command));
  const observe = () => readWorkbenchAgentContext(owner.read(), scene.owner)!;
  return { owner, commit, lifecycle, executor, envelope, execute, observe };
}

describe("shared Workbench Scene executor", () => {
  test("reactivates the existing runtime tab without duplicating its surface", async () => {
    const subject = fixture(seededScene({ kind: "session", sessionId: "session" }, []));
    const opened = await subject.execute({
      kind: "open_surface",
      panelId: "bottom",
      surface: {
        kind: "terminal",
        titleSnapshot: "Terminal",
        config: {
          terminalSessionId: "terminal",
          context: { kind: "session", sessionId: "session" },
        },
      },
    });
    expect(opened).toMatchObject({ applied: true, error: null });
    const before = subject.observe().tabs.map((tab) => tab.tabId);
    const activated = await subject.execute({ kind: "activate_surface", tabId: opened.tabId! });
    expect(activated).toMatchObject({ tabId: opened.tabId, error: null });
    expect(subject.observe().tabs.map((tab) => tab.tabId)).toEqual(before);
  });

  test("opens a file at a line in a hidden Session without changing location, then navigates through the same receipt boundary", async () => {
    const subject = fixture(seededScene({ kind: "pages" }, [page("visible")]));
    subject.owner.selectPages();
    const sceneOwner = { kind: "session" as const, sessionId: "hidden" };
    const ledger = createWorkbenchAgentCommands(subject.owner, subject.executor);
    const input: WorkbenchCommandEnvelope = {
      operationId: "open-file",
      sceneOwner,
      expectedPresentationRevision: subject.owner.read().presentationRevision,
      command: {
        kind: "open_surface",
        panelId: "right",
        surface: {
          kind: "files",
          titleSnapshot: "app.ts",
          config: {
            projectId: null,
            hostId: "local",
            cwd: "/workspace",
            workspaceRoot: "/workspace",
            path: "/workspace/app.ts",
          },
        },
        reveal: { kind: "file", line: 12 },
      },
    };
    const opened = await ledger.execute(input, () => true);
    expect(opened).toMatchObject({ applied: true, persisted: true, error: null });
    expect(subject.owner.read().windowState.location).toMatchObject({ kind: "pages" });
    const scene =
      subject.owner.read().windowState.scenesByOwnerKey[makeWorkbenchSceneKey(sceneOwner)]!;
    expect(scene.panelSurfacesById[opened.tabId!]).toMatchObject({
      kind: "files",
      state: { pendingReveal: { line: 12 } },
    });
    const revision = subject.owner.read().presentationRevision;
    expect(
      await ledger.execute({ ...input, expectedPresentationRevision: revision }, () => true),
    ).toBe(opened);
    expect(subject.owner.read().presentationRevision).toBe(revision);
    expect(
      await ledger.execute(
        {
          ...input,
          command: { ...input.command, reveal: { kind: "file", line: 20 } } as WorkbenchCommand,
        },
        () => true,
      ),
    ).toMatchObject({ error: "operation_id_reused" });
    const navigated = await ledger.execute(
      {
        operationId: "navigate",
        sceneOwner,
        expectedPresentationRevision: revision,
        command: { kind: "navigate_session", projectId: null },
      },
      () => true,
    );
    expect(navigated).toMatchObject({ applied: true, persisted: true, error: null });
    expect(subject.owner.read().windowState.location).toEqual({
      kind: "session",
      sessionId: "hidden",
      projectContextId: null,
    });
    expect(Object.keys(subject.owner.read().windowState.scenesByOwnerKey)).toContain("pages");
  });

  test("rejects stale Session presentation and mismatched reveals before changing a Scene", async () => {
    const subject = fixture(seededScene({ kind: "session", sessionId: "session" }, []));
    const input = subject.envelope({
      kind: "open_surface",
      panelId: "right",
      surface: { kind: "browser", titleSnapshot: "Browser", config: { browserTabId: "browser" } },
      reveal: { kind: "file", line: 1 },
    });
    expect(await subject.executor.execute(input)).toMatchObject({
      error: "invalid_command",
      applied: false,
    });
    expect(subject.commit).not.toHaveBeenCalled();
    expect(
      await subject.executor.execute({
        ...input,
        expectedPresentationRevision: input.expectedPresentationRevision + 1,
      }),
    ).toMatchObject({ error: "stale_presentation", applied: false });
    expect(
      await subject.executor.execute(
        subject.envelope({ kind: "navigate_session", projectId: null }),
        () => false,
      ),
    ).toMatchObject({ error: "revoked_generation", applied: false });
    const ledger = createWorkbenchAgentCommands(subject.owner, subject.executor);
    const navigation = subject.envelope({ kind: "navigate_session", projectId: null });
    expect(
      await ledger.execute(
        {
          ...navigation,
          expectedPresentationRevision: navigation.expectedPresentationRevision + 1,
        },
        () => true,
      ),
    ).toMatchObject({ error: "stale_presentation", applied: false });
    expect(await ledger.execute(navigation, () => true)).toMatchObject({
      error: null,
      applied: true,
    });
  });

  test("keeps background Browser insertion and opener close routing on the shared executor", async () => {
    const scene = seededScene({ kind: "session", sessionId: "session-a" }, [
      browser("parent"),
      browser("unrelated"),
    ]);
    const subject = fixture(scene);
    const opener = createWorkbenchPanelTabOpenerStore();
    const executor = createWorkbenchSceneCommands(subject.owner, {
      ...subject.lifecycle,
      ...workbenchSceneCommandOpenerLifecycle(opener),
    });
    const execute = (command: WorkbenchCommand, options?: Parameters<typeof executor.execute>[2]) =>
      executor.execute(subject.envelope(command), undefined, options);
    await execute({ kind: "activate_tab", tabId: "parent" });
    const groupId = scene.panels.right.layout.activeLeafId;
    await execute(
      {
        kind: "open_tab",
        panelId: "right",
        groupId,
        surface: {
          kind: "browser",
          titleSnapshot: "Child",
          config: { browserTabId: "child-runtime" },
        },
      },
      {
        surfaceId: "child",
        open: { presentation: "background", targetIndex: 1, openerTabId: "parent" },
      },
    );
    expect(subject.observe().groups.find((group) => group.groupId === groupId)).toMatchObject({
      tabIds: ["parent", "child", "unrelated"],
      selectedTabId: "parent",
    });
    await execute({ kind: "activate_tab", tabId: "child" });
    await execute({ kind: "close_tab", tabId: "child" });
    expect(subject.observe().groups.find((group) => group.groupId === groupId)?.selectedTabId).toBe(
      "parent",
    );
  });

  test.each([
    {
      kind: "page_stage",
      titleSnapshot: "Library Page",
      config: { accessContext: { kind: "library" }, pageId: "page-a" },
    },
    {
      kind: "canvas_stage",
      titleSnapshot: "Library Canvas",
      config: { accessContext: { kind: "library" }, canvasBlockId: "canvas-a" },
    },
    {
      kind: "db_view",
      titleSnapshot: "Library View",
      config: {
        accessContext: { kind: "library" },
        target: { kind: "database-view", databaseViewId: "view-a" },
      },
    },
    {
      kind: "db_view",
      titleSnapshot: "Project default",
      config: {
        accessContext: { kind: "project", projectId: "project-a" },
        target: { kind: "project-default" },
      },
    },
  ] as const)(
    "opens $titleSnapshot in a Session without changing its resource authority",
    async (surface) => {
      const scene = materializeInitialWorkbenchScene({ kind: "session", sessionId: "session-a" });
      const subject = fixture(scene);
      const result = await subject.execute({
        kind: "open_tab",
        panelId: "right",
        groupId: scene.panels.right.layout.activeLeafId,
        surface,
      });
      expect(result).toMatchObject({ applied: true });
      const updated =
        subject.owner.read().windowState.scenesByOwnerKey[makeWorkbenchSceneKey(scene.owner)]!;
      const projection = presentWorkbenchSessionPanelsWithScene(
        { id: "session-a", projectId: "other-project" },
        updated,
      );
      expect(projection.tabs).toHaveLength(1);
      expect(projection.tabs[0]).toMatchObject({ kind: surface.kind, config: surface.config });
      expect(subject.commit).toHaveBeenCalledOnce();
    },
  );

  test("changes a hidden Scene and reports the exact queued layout even when navigation advances", async () => {
    const scene = seededScene({ kind: "pages" }, [page("a"), page("b")]);
    const subject = fixture(scene);
    const acknowledgement = deferred<WorkbenchWindowPersistenceReceipt>();
    subject.commit.mockImplementationOnce(() => acknowledgement.promise);
    const before = subject.owner.read().windowState.location;
    const command = subject.execute({
      kind: "reorder_tabs",
      panelId: "right",
      groupId: scene.panels.right.layout.activeLeafId,
      tabIds: ["b", "a"],
    });
    expect(subject.owner.read().windowState.location).toBe(before);
    expect(subject.observe().groups.find((group) => group.panelId === "right")?.tabIds).toEqual([
      "b",
      "a",
    ]);
    const captured = subject.commit.mock.calls[0]![0];
    subject.owner.selectProject("another-project");
    acknowledgement.resolve({ ...captured, sessionId: "window-a", layoutRevision: 31 });
    expect(await command).toMatchObject({
      applied: true,
      persisted: true,
      presentationRevision: captured.presentationRevision,
      layoutRevision: 31,
      error: null,
    });
    expect(subject.owner.read().presentationRevision).toBeGreaterThan(
      captured.presentationRevision,
    );
  });

  test.each(["revision", "generation"] as const)(
    "checks %s after asynchronous save preparation before removing a tab",
    async (fence) => {
      const subject = fixture(seededScene({ kind: "pages" }, [page("a")]));
      const save = deferred<boolean>();
      subject.lifecycle.prepareClose.mockImplementationOnce(() => save.promise);
      let current = true;
      const result = subject.executor.execute(
        subject.envelope({ kind: "close_tab", tabId: "a" }),
        () => current,
      );
      expect(subject.lifecycle.prepareClose).toHaveBeenCalledOnce();
      if (fence === "revision") subject.owner.selectProject("another-project");
      else current = false;
      save.resolve(true);
      expect(await result).toMatchObject({
        applied: false,
        persisted: false,
        error: fence === "revision" ? "stale_presentation" : "revoked_generation",
      });
      expect(subject.observe().tabs.some((tab) => tab.tabId === "a")).toBe(true);
      expect(subject.lifecycle.close).not.toHaveBeenCalled();
      expect(subject.commit).not.toHaveBeenCalled();
    },
  );

  test("vetoes failed saves and distinguishes an applied change whose persistence failed", async () => {
    const subject = fixture(seededScene({ kind: "pages" }, [page("a")]));
    subject.lifecycle.prepareClose.mockResolvedValueOnce(false);
    expect(await subject.execute({ kind: "close_tab", tabId: "a" })).toMatchObject({
      applied: false,
      error: "save_failed",
    });
    expect(subject.observe().tabs.map((tab) => tab.tabId)).toEqual(["a"]);
    subject.commit.mockRejectedValueOnce(new Error("layout rejected"));
    expect(await subject.execute({ kind: "close_tab", tabId: "a" })).toMatchObject({
      applied: true,
      persisted: false,
      layoutRevision: null,
      error: "persistence_failed",
    });
    expect(subject.observe().tabs).toEqual([]);
    expect(subject.lifecycle.close).toHaveBeenCalledOnce();
  });

  test("closes an existing preview without pinning it or claiming a durable tab change", async () => {
    const scene = materializeInitialWorkbenchScene({ kind: "project", projectId: "project-a" });
    const subject = fixture(scene);
    const groupId = scene.panels.right.layout.activeLeafId;
    const slot = makeWorkbenchPanelSlotKey(makeWorkbenchSceneKey(scene.owner), "right", groupId);
    subject.owner.dispatchEphemeral({
      type: "update",
      field: "previewSurfacesByPanel",
      update: { [slot]: page("preview") },
    });
    const before = subject.owner.snapshotForPersistence();
    expect(await subject.execute({ kind: "close_tab", tabId: "preview" })).toMatchObject({
      applied: true,
      persisted: false,
      error: null,
    });
    expect(subject.owner.snapshotForPersistence()).toEqual(before);
    expect(subject.owner.read().ephemeralPanels.previewSurfacesByPanel).toEqual({});
    expect(subject.lifecycle.prepareClose.mock.calls[0]?.[1].observed).toMatchObject({
      preview: true,
      persisted: false,
    });
    expect(subject.commit.mock.calls[0]?.[0].layout).toEqual(before);
  });

  test("requires complete mixed membership and preserves the protected primary's first position", async () => {
    const scene = seededScene({ kind: "project", projectId: "project-a" }, [
      browser("a"),
      browser("b"),
    ]);
    const subject = fixture(scene);
    const groupId = scene.panels.right.layout.activeLeafId;
    const primaryId = scene.primary!.id;
    for (const command of [
      { kind: "close_tab", tabId: primaryId },
      {
        kind: "move_tab",
        tabId: primaryId,
        panelId: "bottom",
        groupId: scene.panels.bottom.layout.activeLeafId,
        index: 0,
      },
      { kind: "reorder_tabs", panelId: "right", groupId, tabIds: ["a", primaryId, "b"] },
    ] satisfies WorkbenchCommand[])
      expect(await subject.execute(command)).toMatchObject({
        applied: false,
        error: "protected_primary",
      });
    for (const tabIds of [
      [primaryId, "a"],
      [primaryId, "a", "a"],
      [primaryId, "a", "unknown"],
    ]) {
      expect(
        await subject.execute({ kind: "reorder_tabs", panelId: "right", groupId, tabIds }),
      ).toMatchObject({ applied: false, error: "invalid_order" });
    }
    expect(subject.commit).not.toHaveBeenCalled();
    expect(
      await subject.execute({
        kind: "reorder_tabs",
        panelId: "right",
        groupId,
        tabIds: [primaryId, "b", "a"],
      }),
    ).toMatchObject({ applied: true, persisted: true, error: null });
    expect(subject.observe().groups[0]?.tabIds).toEqual([primaryId, "b", "a"]);
  });

  test("reorders and selects auxiliary Session tabs through the same render projection", async () => {
    const scene = seededScene({ kind: "session", sessionId: "session-a" }, [
      browser("a"),
      browser("b"),
    ]);
    const subject = fixture(scene);
    const groupId = scene.panels.right.layout.activeLeafId;
    subject.owner.dispatchEphemeral({
      type: "update",
      field: "sideChatTabsBySession",
      update: {
        "session-a": [
          {
            sideChat: true,
            id: "side-chat",
            sessionId: "session-a",
            panelId: "right",
            leafId: groupId,
            parentThreadId: "parent",
            parentNavigationPath: "session:session-a",
            threadId: "child",
            title: "Side chat",
            status: "ready",
            stateKey: 0,
          },
        ],
      },
    });
    expect(
      await subject.execute({
        kind: "reorder_tabs",
        panelId: "right",
        groupId,
        tabIds: ["side-chat", "b", "a"],
      }),
    ).toMatchObject({ applied: true, persisted: true, error: null });
    expect(subject.observe().groups[0]?.tabIds).toEqual(["side-chat", "b", "a"]);
    await subject.execute({ kind: "activate_tab", tabId: "side-chat" });
    expect(subject.observe().groups[0]?.selectedTabId).toBe("side-chat");
    expect(await subject.execute({ kind: "close_tab", tabId: "side-chat" })).toMatchObject({
      applied: true,
      error: null,
    });
    expect(subject.observe().groups[0]?.tabIds).toEqual(["b", "a"]);
    expect(subject.lifecycle.close.mock.calls[0]?.[1].auxiliary).toMatchObject({
      id: "side-chat",
      threadId: "child",
    });
  });

  test("opens, reuses, moves, splits, merges, and applies panel state without selecting the hidden Scene", async () => {
    const scene = seededScene({ kind: "pages" }, [page("a"), page("b")]);
    const subject = fixture(scene);
    const initialLocation = subject.owner.read().windowState.location;
    const groupId = scene.panels.right.layout.activeLeafId;
    const open: WorkbenchCommand = {
      kind: "open_tab",
      panelId: "right",
      groupId,
      surface: {
        kind: "page_stage",
        titleSnapshot: "C",
        config: { accessContext: { kind: "library" }, pageId: "page:c" },
      },
    };
    const opened = await subject.execute(open);
    expect(opened).toMatchObject({ applied: true, persisted: true, error: null });
    expect((await subject.execute(open)).tabId).toBe(opened.tabId);
    const split = await subject.execute({
      kind: "split_group",
      panelId: "right",
      groupId,
      side: "right",
      tabId: "b",
    });
    expect(split.groupId).not.toBe(groupId);
    expect(
      subject.observe().groups.find((group) => group.groupId === split.groupId)?.tabIds,
    ).toEqual(["b"]);
    expect(
      await subject.execute({
        kind: "move_tab",
        panelId: "right",
        groupId: split.groupId!,
        tabId: "a",
        index: 1,
      }),
    ).toMatchObject({ applied: true, error: null });
    expect(
      subject.observe().groups.find((group) => group.groupId === split.groupId)?.tabIds,
    ).toEqual(["b", "a"]);
    await subject.execute({
      kind: "set_panel_state",
      panelId: "right",
      maximizedGroupId: split.groupId!,
      size: { widthPx: 840 },
      collapsed: false,
    });
    expect(subject.observe().panels[0]).toMatchObject({
      maximizedGroupId: split.groupId,
      size: { widthPx: 840 },
      collapsed: false,
    });
    expect(
      await subject.execute({ kind: "merge_group", panelId: "right", groupId: split.groupId! }),
    ).toMatchObject({ applied: true, error: null });
    expect(subject.observe().groups.filter((group) => group.panelId === "right")).toHaveLength(1);
    expect(subject.owner.read().windowState.location).toBe(initialLocation);
  });

  test("keeps a preview's identity when an explicit open makes it durable", async () => {
    const scene = materializeInitialWorkbenchScene({ kind: "pages" });
    const subject = fixture(scene);
    const groupId = scene.panels.right.layout.activeLeafId;
    const slot = makeWorkbenchPanelSlotKey("pages", "right", groupId);
    subject.owner.dispatchEphemeral({
      type: "update",
      field: "previewSurfacesByPanel",
      update: { [slot]: page("preview") },
    });
    const opened = await subject.execute({
      kind: "open_tab",
      panelId: "right",
      groupId,
      surface: {
        kind: "page_stage",
        titleSnapshot: "Preview",
        config: { accessContext: { kind: "library" }, pageId: "page:preview" },
      },
    });
    expect(opened).toMatchObject({ tabId: "preview", applied: true, persisted: true, error: null });
    expect(subject.observe().tabs).toMatchObject([
      { tabId: "preview", preview: false, persisted: true },
    ]);
    expect(subject.lifecycle.close).not.toHaveBeenCalled();
  });

  test("rejects auxiliary placement outside its supported panel without changing its owner slot", async () => {
    const scene = materializeInitialWorkbenchScene({ kind: "session", sessionId: "session-a" });
    const subject = fixture(scene);
    subject.owner.dispatchEphemeral({
      type: "update",
      field: "processOutputTabsBySession",
      update: {
        "session-a": [
          {
            processOutputPanel: true,
            id: "output",
            sessionId: "session-a",
            projectId: null,
            panelId: "right",
            title: "Process",
            stateKey: 0,
            threadId: "thread-a",
            turnId: null,
            itemId: "item-a",
            command: "echo hi",
            cwd: null,
            terminalSessionId: null,
          },
        ],
      },
    });
    expect(
      await subject.execute({
        kind: "move_tab",
        tabId: "output",
        panelId: "bottom",
        groupId: scene.panels.bottom.layout.activeLeafId,
        index: 0,
      }),
    ).toMatchObject({ applied: false, error: "invalid_placement" });
    expect(subject.commit).not.toHaveBeenCalled();
    expect(subject.observe().tabs.find((tab) => tab.tabId === "output")?.panelId).toBe("right");
  });
});

describe("generation-local Workbench operation receipts", () => {
  test("canonicalizes equivalent payloads and does not replay applied-but-unpersisted commands", async () => {
    const subject = fixture(seededScene({ kind: "pages" }, [page("a")]));
    subject.commit.mockRejectedValueOnce(new Error("disk"));
    const ledger = createWorkbenchAgentCommands(subject.owner, subject.executor);
    const input = subject.envelope({ kind: "close_tab", tabId: "a" });
    const first = await ledger.execute(input, () => true);
    const equivalent = {
      command: { tabId: "a", kind: "close_tab" as const },
      expectedPresentationRevision: input.expectedPresentationRevision,
      sceneOwner: input.sceneOwner,
      operationId: input.operationId,
    };
    expect(await ledger.execute(equivalent, () => true)).toBe(first);
    expect(first).toMatchObject({ applied: true, persisted: false, error: "persistence_failed" });
    expect(subject.lifecycle.close).toHaveBeenCalledOnce();
    expect(
      await ledger.execute({ ...input, command: { kind: "activate_tab", tabId: "a" } }, () => true),
    ).toMatchObject({ applied: false, error: "operation_id_reused" });
  });

  test("shares an in-flight receipt and refuses an old generation after async digest preparation", async () => {
    const subject = fixture(seededScene({ kind: "pages" }, [page("a")]));
    const save = deferred<boolean>();
    subject.lifecycle.prepareClose.mockImplementation(() => save.promise);
    const ledger = createWorkbenchAgentCommands(subject.owner, subject.executor);
    const input = subject.envelope({ kind: "close_tab", tabId: "a" });
    const first = ledger.execute(input, () => true);
    const second = ledger.execute(input, () => true);
    await vi.waitFor(() => expect(subject.lifecycle.prepareClose).toHaveBeenCalledOnce());
    save.resolve(true);
    expect(await second).toBe(await first);
    const revoked = ledger.execute(
      subject.envelope({
        kind: "open_tab",
        panelId: "right",
        groupId: subject.observe().panels[0]!.activeGroupId,
        surface: {
          kind: "page_stage",
          titleSnapshot: "B",
          config: { accessContext: { kind: "library" }, pageId: "b" },
        },
      }),
      () => false,
    );
    expect(await revoked).toMatchObject({ applied: false, error: "revoked_generation" });
  });

  test("keeps its bound without evicting a receipt and replaying an old operation", async () => {
    const subject = fixture(materializeInitialWorkbenchScene({ kind: "pages" }));
    const ledger = createWorkbenchAgentCommands(subject.owner, subject.executor);
    const first = subject.envelope({ kind: "close_tab", tabId: "absent" });
    const receipt = await ledger.execute(first, () => true);
    for (let index = 1; index < WORKBENCH_COMMAND_MAX_RECEIPTS; index += 1)
      await ledger.execute(subject.envelope({ kind: "close_tab", tabId: "absent" }), () => true);
    expect(
      await ledger.execute(subject.envelope({ kind: "close_tab", tabId: "absent" }), () => true),
    ).toMatchObject({ error: "receipt_capacity" });
    expect(await ledger.execute(first, () => true)).toBe(receipt);
  });

  test("the command grammar excludes arbitrary saved state and unknown patch properties", () => {
    const base = {
      operationId: "op",
      sceneOwner: { kind: "pages" },
      expectedPresentationRevision: 0,
    };
    expect(
      WorkbenchCommandEnvelopeSchema.safeParse({
        ...base,
        command: { kind: "open_tab", panelId: "right", groupId: "leaf", surface: { ...page("a") } },
      }).success,
    ).toBe(false);
    expect(
      WorkbenchCommandEnvelopeSchema.safeParse({
        ...base,
        command: { kind: "set_panel_state", panelId: "right", arbitraryProperty: true },
      }).success,
    ).toBe(false);
  });
});
