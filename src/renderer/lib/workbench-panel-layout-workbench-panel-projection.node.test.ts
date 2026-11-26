import { describe, expect, test, vi } from "vite-plus/test";
import type {
  AgentPanelTab,
  AutomationPanelTab,
  ImageEditorPanelTab,
  McpAppPanelTab,
  PlanPanelTab,
  ProcessOutputPanelTab,
  SideChatPanelTab,
} from "./workbench-panel-tab-model";
import type { ProjectSessionPreviewTab } from "./workbench-panel-preview";
import {
  buildSessionPanelRenderModel,
  collectMountedBrowserTabIds,
  collectPanelPresentedPageIds,
  getRenderablePanelPreviewTab,
  shouldExpandImageEditorPanelForViewChange,
  type SessionPanelRenderModelInput,
} from "./workbench-panel-projection";
import {
  makeWorkbenchSessionPanelSlotKey,
  clearTransientPanelSelection,
  makeWorkbenchPanelSlotKey,
  makeWorkbenchSessionPanelOwnerKey,
  resolveWorkbenchPanelSlotLeafId,
} from "./workbench-panel-slot-key";
import {
  makeTestWorkbenchSession,
  makeTestWorkbenchTab,
} from "@/components/workbench/workbench-testkit/panel-fixtures";
import type { WorkbenchTabProjection } from "../../shared/types";
import {
  closeDurablePanelTabWithRuntime,
  closePreviewPanelTabWithRuntime,
} from "./workbench-panel-runtime-lifecycle";
import {
  createCommandKeymapState,
  PREVIOUS_PANEL_TAB_COMMAND_ID,
} from "../../shared/command-keybindings";
import {
  panelTabCycleRequestDirectionToOffset,
  resolveNextPanelTabId,
  resolvePanelTabCloseShortcut,
  resolvePanelTabCycleDirection,
} from "./workbench-panel-tab-cycle";
import type { AppShellTabItem } from "@/components/workbench/app-shell-tabs";

describe("workbench panel projection", () => {
  function auxiliaryTabs() {
    const common = {
      sessionId: "session-1",
      projectId: "project-1",
      panelId: "right" as const,
      leafId: "right-leaf",
      stateKey: 0,
    };
    return {
      side: {
        ...common,
        sideChat: true,
        id: "side",
        parentThreadId: "parent",
        parentNavigationPath: "path",
        threadId: "thread-side",
        title: "Side chat",
        status: "ready",
      } satisfies SideChatPanelTab,
      mcp: {
        ...common,
        mcpApp: true,
        id: "mcp",
        title: "MCP",
        app: {},
      } as McpAppPanelTab,
      plan: {
        ...common,
        planPanel: true,
        id: "plan",
        title: "Plan",
        planKey: "plan-key",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        content: "Plan",
        cwd: null,
      } satisfies PlanPanelTab,
      automation: {
        ...common,
        automationPanel: true,
        id: "automation",
        title: "Automation",
        automationId: "automation-1",
        createInput: null,
        mode: "open",
        updateInput: null,
      } satisfies AutomationPanelTab,
      agent: {
        ...common,
        subagentsPanel: true,
        id: "agents",
        rootThreadId: "thread-1",
        selectedThreadId: null,
        selectedDisplayName: null,
        selectedHydration: null,
        title: "Subagents",
      } satisfies AgentPanelTab,
      process: {
        ...common,
        processOutputPanel: true,
        id: "process",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        title: "Process",
        command: "pnpm test",
        cwd: "/workspace",
        terminalSessionId: null,
      } satisfies ProcessOutputPanelTab,
      image: {
        ...common,
        imageEditor: true,
        id: "image:preview",
        projectId: "project-1",
        threadId: "thread-1",
        title: "User attachment",
        tooltip: "User attachment",
        preview: true,
        pinBehavior: "automatic",
        options: {
          availableImageCount: 1,
          composerTarget: null,
          entrypoint: "gallery_edit_button",
          generatedImages: null,
          imageSource: "uploaded",
          images: [
            {
              id: "attachment-1",
              alt: "Attachment",
              attachmentSrc: "data:image/png;base64,AA==",
              source: "uploaded",
              src: "data:image/png;base64,AA==",
            },
          ],
          initialImageId: "attachment-1",
          initialPlaygroundTool: "navigate",
          initialView: "single",
          openInEditor: true,
          policy: "edit_button",
          projectId: "project-1",
          threadId: "thread-1",
          title: "User attachment",
          tooltip: "User attachment",
        },
      } satisfies ImageEditorPanelTab,
    };
  }

  function input(
    overrides: Partial<SessionPanelRenderModelInput> = {},
  ): SessionPanelRenderModelInput {
    const durable = makeTestWorkbenchTab({
      id: "durable",
      kind: "browser",
    });
    const session = makeTestWorkbenchSession({
      tabs: [durable],
      rightActiveTabId: durable.id,
    });
    const tabs = auxiliaryTabs();
    const key = makeWorkbenchSessionPanelSlotKey(session.id, "right", "right-leaf");
    return {
      session,
      previewTabsByPanel: {},
      sideChatTabsBySession: { [session.id]: [tabs.side] },
      sideChatActiveTabByPanel: { [key]: tabs.side.id },
      mcpAppTabsBySession: { [session.id]: [tabs.mcp] },
      mcpAppActiveTabByPanel: { [key]: tabs.mcp.id },
      planTabsBySession: { [session.id]: [tabs.plan] },
      planActiveTabByPanel: { [key]: tabs.plan.id },
      automationTabsBySession: {
        [session.id]: [tabs.automation],
      },
      automationActiveTabByPanel: { [key]: tabs.automation.id },
      backgroundAgentTabsBySession: {
        [session.id]: [tabs.agent],
      },
      backgroundAgentActiveTabByPanel: { [key]: tabs.agent.id },
      processOutputTabsBySession: {
        [session.id]: [tabs.process],
      },
      processOutputActiveTabByPanel: { [key]: tabs.process.id },
      imageEditorTabsBySession: {
        [session.id]: [tabs.image],
      },
      imageEditorActiveTabByPanel: { [key]: tabs.image.id },
      panelCollapsedOverrides: {},
      activePlanKeyBySession: {},
      ...overrides,
    };
  }

  function preview(): ProjectSessionPreviewTab {
    return {
      ...makeTestWorkbenchTab({
        id: "preview",
        kind: "browser",
      }),
      preview: true,
      previewInstanceId: "preview-instance",
    };
  }

  function durableOnlyInput(
    session: SessionPanelRenderModelInput["session"],
  ): SessionPanelRenderModelInput {
    return input({
      session,
      sideChatTabsBySession: {},
      sideChatActiveTabByPanel: {},
      mcpAppTabsBySession: {},
      mcpAppActiveTabByPanel: {},
      planTabsBySession: {},
      planActiveTabByPanel: {},
      automationTabsBySession: {},
      automationActiveTabByPanel: {},
      backgroundAgentTabsBySession: {},
      backgroundAgentActiveTabByPanel: {},
      processOutputTabsBySession: {},
      processOutputActiveTabByPanel: {},
      imageEditorTabsBySession: {},
      imageEditorActiveTabByPanel: {},
    });
  }

  describe("workbench panel projection", () => {
    test("keeps render order independent from active priority", () => {
      const base = input();
      const key = makeWorkbenchSessionPanelSlotKey(base.session.id, "right", "right-leaf");
      const model = buildSessionPanelRenderModel({
        ...base,
        previewTabsByPanel: { [key]: preview() },
      });
      expect(model.rightRenderableTabs.map((tab) => tab.id)).toEqual([
        "durable",
        "side",
        "mcp",
        "plan",
        "automation",
        "agents",
        "process",
        "image:preview",
        "preview",
      ]);
      expect(model.rightActiveTabId).toBe("preview");
    });

    test("applies the explicit auxiliary active priority", () => {
      const cases: Array<{
        expected: string;
        omit: Array<
          | "planActiveTabByPanel"
          | "automationActiveTabByPanel"
          | "mcpAppActiveTabByPanel"
          | "sideChatActiveTabByPanel"
          | "backgroundAgentActiveTabByPanel"
          | "processOutputActiveTabByPanel"
          | "imageEditorActiveTabByPanel"
        >;
      }> = [
        { expected: "plan", omit: [] },
        { expected: "automation", omit: ["planActiveTabByPanel"] },
        {
          expected: "mcp",
          omit: ["planActiveTabByPanel", "automationActiveTabByPanel"],
        },
        {
          expected: "side",
          omit: ["planActiveTabByPanel", "automationActiveTabByPanel", "mcpAppActiveTabByPanel"],
        },
        {
          expected: "agents",
          omit: [
            "planActiveTabByPanel",
            "automationActiveTabByPanel",
            "mcpAppActiveTabByPanel",
            "sideChatActiveTabByPanel",
          ],
        },
        {
          expected: "process",
          omit: [
            "planActiveTabByPanel",
            "automationActiveTabByPanel",
            "mcpAppActiveTabByPanel",
            "sideChatActiveTabByPanel",
            "backgroundAgentActiveTabByPanel",
          ],
        },
        {
          expected: "image:preview",
          omit: [
            "planActiveTabByPanel",
            "automationActiveTabByPanel",
            "mcpAppActiveTabByPanel",
            "sideChatActiveTabByPanel",
            "backgroundAgentActiveTabByPanel",
            "processOutputActiveTabByPanel",
          ],
        },
        {
          expected: "durable",
          omit: [
            "planActiveTabByPanel",
            "automationActiveTabByPanel",
            "mcpAppActiveTabByPanel",
            "sideChatActiveTabByPanel",
            "backgroundAgentActiveTabByPanel",
            "processOutputActiveTabByPanel",
            "imageEditorActiveTabByPanel",
          ],
        },
      ];

      for (const { expected, omit } of cases) {
        const modelInput = input();
        for (const field of omit) modelInput[field] = {};
        expect(buildSessionPanelRenderModel(modelInput).rightActiveTabId).toBe(expected);
      }
    });

    test("uses panel-level fallback only for the active leaf", () => {
      const first = makeTestWorkbenchTab({
        id: "first",
        kind: "browser",
      });
      const second = makeTestWorkbenchTab({
        id: "second",
        kind: "review",
      });
      const session = makeTestWorkbenchSession({
        tabs: [first, second],
        rightTabIds: [first.id],
        rightActiveTabId: first.id,
        rightSecondLeafTabIds: [second.id],
        rightSecondLeafActiveTabId: second.id,
      });
      const side = {
        ...auxiliaryTabs().side,
        leafId: undefined,
      };
      const model = buildSessionPanelRenderModel(
        input({
          session,
          sideChatTabsBySession: { [session.id]: [side] },
          sideChatActiveTabByPanel: {
            [makeWorkbenchSessionPanelSlotKey(session.id, "right")]: side.id,
          },
          mcpAppTabsBySession: {},
          mcpAppActiveTabByPanel: {},
          planTabsBySession: {},
          planActiveTabByPanel: {},
          automationTabsBySession: {},
          automationActiveTabByPanel: {},
          backgroundAgentTabsBySession: {},
          backgroundAgentActiveTabByPanel: {},
          processOutputTabsBySession: {},
          processOutputActiveTabByPanel: {},
          imageEditorTabsBySession: {},
          imageEditorActiveTabByPanel: {},
        }),
      );
      expect(model.activeTabIdsByPanelLeaf.right["right-leaf"]).toBe("first");
      expect(model.activeTabIdsByPanelLeaf.right["right-leaf-2"]).toBe("side");
    });

    test("presents a renderer-only tab whose group closed in its panel's active group", () => {
      const durable = makeTestWorkbenchTab({ id: "durable", kind: "browser" });
      const session = makeTestWorkbenchSession({ tabs: [durable], rightActiveTabId: durable.id });
      const side = { ...auxiliaryTabs().side, leafId: "closed-leaf" };
      const model = buildSessionPanelRenderModel({
        ...durableOnlyInput(session),
        sideChatTabsBySession: { [session.id]: [side] },
      });
      expect(model.renderableTabsByPanelLeaf.right["right-leaf"]?.map((tab) => tab.id)).toEqual([
        "durable",
        "side",
      ]);
    });

    test("suppresses a preview after the same identity becomes durable", () => {
      const durable = makeTestWorkbenchTab({
        id: "same-id",
        kind: "browser",
      });
      const session = makeTestWorkbenchSession({ tabs: [durable] });
      expect(
        getRenderablePanelPreviewTab(session, "right", "right-leaf", {
          [makeWorkbenchSessionPanelSlotKey(session.id, "right", "right-leaf")]: {
            ...durable,
            preview: true,
            previewInstanceId: "preview-instance",
          },
        }),
      ).toBeNull();
    });

    test("projects collapsed/full-width and visible Browser lifecycle", () => {
      const rightBrowser = makeTestWorkbenchTab({
        id: "right-browser",
        kind: "browser",
      });
      const bottomBrowser = makeTestWorkbenchTab({
        id: "bottom-browser",
        kind: "browser",
        panelId: "bottom",
      });
      const session = makeTestWorkbenchSession({
        tabs: [rightBrowser, bottomBrowser],
        rightFullWidth: true,
        bottomCollapsed: true,
      });
      const model = buildSessionPanelRenderModel(durableOnlyInput(session));
      expect(model.rightPanelFullWidth).toBe(true);
      expect(model.browserRetentionTabs.map((tab) => tab.id)).toEqual([
        "right-browser",
        "bottom-browser",
      ]);
      expect([...model.visibleBrowserTabIds]).toEqual(["right-browser"]);
    });

    test("keeps image Canvas width owned by the panel instead of deriving it from tab config", () => {
      const base = input();
      const image = {
        ...auxiliaryTabs().image,
        options: {
          ...auxiliaryTabs().image.options,
          initialView: "playground" as const,
        },
      };
      const model = buildSessionPanelRenderModel({
        ...base,
        planActiveTabByPanel: {},
        automationActiveTabByPanel: {},
        mcpAppActiveTabByPanel: {},
        sideChatActiveTabByPanel: {},
        backgroundAgentActiveTabByPanel: {},
        processOutputActiveTabByPanel: {},
        imageEditorTabsBySession: {
          [base.session.id]: [image],
        },
      });

      expect(model.rightActiveRenderableTab?.id).toBe(image.id);
      expect(model.rightPanel.size.fullWidth).toBe(false);
      expect(model.rightPanelFullWidth).toBe(false);
    });

    test("expands only while entering Canvas, not while restoring an existing Canvas", () => {
      expect(
        shouldExpandImageEditorPanelForViewChange({
          panelIsFullWidth: false,
          previousView: "single",
          view: "playground",
        }),
      ).toBe(true);
      expect(
        shouldExpandImageEditorPanelForViewChange({
          panelIsFullWidth: false,
          previousView: "playground",
          view: "playground",
        }),
      ).toBe(false);
      expect(
        shouldExpandImageEditorPanelForViewChange({
          panelIsFullWidth: true,
          previousView: "single",
          view: "playground",
        }),
      ).toBe(false);
      expect(
        shouldExpandImageEditorPanelForViewChange({
          panelIsFullWidth: true,
          previousView: "playground",
          view: "single",
        }),
      ).toBe(false);
    });

    test("retains the active Browser owner until its panel animation unmounts", () => {
      const browser = makeTestWorkbenchTab({
        id: "right-browser",
        kind: "browser",
      });
      const session = makeTestWorkbenchSession({
        tabs: [browser],
        rightCollapsed: true,
      });
      const model = buildSessionPanelRenderModel(durableOnlyInput(session));

      expect([...model.visibleBrowserTabIds]).toEqual([]);
      expect([
        ...collectMountedBrowserTabIds(session, model, {
          right: true,
          bottom: false,
        }),
      ]).toEqual(["right-browser"]);
      expect([
        ...collectMountedBrowserTabIds(session, model, {
          right: false,
          bottom: false,
        }),
      ]).toEqual([]);
    });

    test("collects only Page IDs visible in open panel leaves", () => {
      const page = makeTestWorkbenchTab({
        id: "page",
        kind: "page_stage",
        projectId: "project-2",
        pageId: "page-2",
      });
      const session = makeTestWorkbenchSession({ tabs: [page] });
      const model = buildSessionPanelRenderModel(durableOnlyInput(session));
      expect([...collectPanelPresentedPageIds(session, model)]).toEqual(["page-2"]);

      const collapsedSession = makeTestWorkbenchSession({
        tabs: [page],
        rightCollapsed: true,
      });
      const collapsed = buildSessionPanelRenderModel(durableOnlyInput(collapsedSession));
      expect(collectPanelPresentedPageIds(collapsedSession, collapsed).size).toBe(0);
    });
  });
});

describe("workbench panel runtime lifecycle", () => {
  function makeTab(
    kind: WorkbenchTabProjection["kind"],
    config: WorkbenchTabProjection["config"],
  ): WorkbenchTabProjection {
    return {
      id: `tab:${kind}`,
      sessionId: "session:one",
      projectId: "project:one",
      panelId: "right",
      title: kind,
      order: 0,
      stateKey: 0,
      state: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      browserTabId: kind === "browser" ? "browser:one" : null,
      kind,
      config,
    } as WorkbenchTabProjection;
  }

  describe("Workbench panel runtime lifecycle", () => {
    test("Files veto prevents descriptor removal", async () => {
      const removeDescriptor = vi.fn();
      const result = await closeDurablePanelTabWithRuntime(
        makeTab("files", {
          projectId: "project:one",
          workspaceRoot: "/work/one",
          path: "notes.md",
        }),
        {
          flushFile: async () => false,
          releaseTerminal: vi.fn(),
          removeDescriptor,
          closeBrowserRuntime: vi.fn(),
          disposePageEditor: vi.fn(),
          disposeCanvas: async () => true,
        },
      );

      expect(result).toEqual({
        status: "vetoed",
        reason: "file-conflict",
      });
      expect(removeDescriptor).not.toHaveBeenCalled();
    });

    test("Terminal release precedes descriptor removal", async () => {
      const calls: string[] = [];
      await closeDurablePanelTabWithRuntime(
        makeTab("terminal", {
          terminalSessionId: "terminal:one",
        }),
        {
          flushFile: async () => true,
          releaseTerminal: () => calls.push("release"),
          removeDescriptor: () => calls.push("remove"),
          closeBrowserRuntime: vi.fn(),
          disposePageEditor: vi.fn(),
          disposeCanvas: async () => true,
        },
      );

      expect(calls).toEqual(["release", "remove"]);
    });

    test("Page editor is disposed exactly once after descriptor removal", async () => {
      const calls: string[] = [];
      await closeDurablePanelTabWithRuntime(
        makeTab("page_stage", {
          projectId: "project:one",
          pageId: "page:one",
        }),
        {
          flushFile: async () => true,
          releaseTerminal: vi.fn(),
          removeDescriptor: () => calls.push("remove"),
          closeBrowserRuntime: vi.fn(),
          disposePageEditor: async () => {
            calls.push("dispose");
          },
          disposeCanvas: async () => true,
        },
      );

      expect(calls).toEqual(["remove", "dispose"]);
    });

    test("Canvas durability veto prevents descriptor removal", async () => {
      const removeDescriptor = vi.fn();
      const result = await closeDurablePanelTabWithRuntime(
        makeTab("canvas_stage", {
          projectId: "project:one",
          canvasBlockId: "canvas:one",
        }),
        {
          flushFile: async () => true,
          releaseTerminal: vi.fn(),
          removeDescriptor,
          closeBrowserRuntime: vi.fn(),
          disposePageEditor: vi.fn(),
          disposeCanvas: async () => false,
        },
      );

      expect(result).toEqual({
        status: "vetoed",
        reason: "canvas-durability",
      });
      expect(removeDescriptor).not.toHaveBeenCalled();
    });

    test("Browser descriptor removal precedes the idempotent runtime close", async () => {
      const calls: string[] = [];
      const result = await closeDurablePanelTabWithRuntime(
        makeTab("browser", {
          projectId: "project:one",
          url: "https://example.com",
        }),
        {
          flushFile: async () => true,
          releaseTerminal: vi.fn(),
          removeDescriptor: () => calls.push("remove"),
          closeBrowserRuntime: async (browserTabId) => {
            calls.push(`close:${browserTabId}`);
          },
          disposePageEditor: vi.fn(),
          disposeCanvas: async () => true,
        },
      );

      expect(result).toEqual({ status: "closed" });
      expect(calls).toEqual(["remove", "close:browser:one"]);
    });

    test("retained Browser preview does not close the shared runtime", async () => {
      const closeBrowserRuntime = vi.fn();
      const removeDescriptor = vi.fn();
      await closePreviewPanelTabWithRuntime(
        {
          ...makeTab("browser", {
            projectId: null,
          }),
          kind: "browser",
          config: { projectId: null },
          browserTabId: "browser:one",
          preview: true,
        } as ProjectSessionPreviewTab,
        {
          flushFile: async () => true,
          isBrowserRuntimeRetained: () => true,
          closeBrowserRuntime,
          removeDescriptor,
        },
      );

      expect(closeBrowserRuntime).not.toHaveBeenCalled();
      expect(removeDescriptor).toHaveBeenCalledOnce();
    });
  });
});

describe("workbench panel slot keys", () => {
  test("encodes panel and leaf slots and only decodes matching scope", () => {
    const ownerKey = makeWorkbenchSessionPanelOwnerKey("session:one");
    expect(makeWorkbenchPanelSlotKey(ownerKey, "right")).toBe(`${ownerKey}:right`);
    const key = makeWorkbenchSessionPanelSlotKey("session:one", "bottom", "leaf:two");
    expect(key).toBe(`${ownerKey}:bottom:leaf:two`);
    expect(resolveWorkbenchPanelSlotLeafId(key, "session:one", "bottom")).toBe("leaf:two");
    expect(resolveWorkbenchPanelSlotLeafId(key, "session:other", "bottom")).toBeNull();
    expect(resolveWorkbenchPanelSlotLeafId(key, "session:one", "right")).toBeNull();
    expect(
      resolveWorkbenchPanelSlotLeafId(
        makeWorkbenchSessionPanelSlotKey("session:one", "bottom"),
        "session:one",
        "bottom",
      ),
    ).toBeNull();
  });

  test("preserves object identity on no-op and removes only requested keys", () => {
    const current = {
      right: "right-tab",
      bottom: "bottom-tab",
      other: "other-tab",
    };
    expect(clearTransientPanelSelection(current, "missing")).toBe(current);

    const next = clearTransientPanelSelection(current, "right", "bottom");
    expect(next).toEqual({ other: "other-tab" });
    expect(current).toEqual({
      right: "right-tab",
      bottom: "bottom-tab",
      other: "other-tab",
    });
  });
});

describe("workbench panel tab cycle", () => {
  function keyEvent(input: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">): KeyboardEvent {
    return {
      target: null,
      altKey: false,
      code: "",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...input,
    } as KeyboardEvent;
  }

  const mac = createCommandKeymapState({}, "macOS");
  const windows = createCommandKeymapState({}, "windows");
  const tabs = ["one", "two", "three"].map((id) => ({
    id,
    label: id,
  })) as unknown as AppShellTabItem[];

  describe("workbench panel tab cycle", () => {
    test.each([
      [
        "mac previous",
        keyEvent({ key: "[", code: "BracketLeft", metaKey: true, shiftKey: true }),
        true,
        -1,
      ],
      [
        "mac next",
        keyEvent({ key: "]", code: "BracketRight", metaKey: true, shiftKey: true }),
        true,
        1,
      ],
      [
        "windows previous",
        keyEvent({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true }),
        false,
        -1,
      ],
      [
        "windows next",
        keyEvent({ key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true }),
        false,
        1,
      ],
      ["missing shift", keyEvent({ key: "]", metaKey: true }), true, null],
      [
        "alt blocked",
        keyEvent({ key: "]", metaKey: true, shiftKey: true, altKey: true }),
        true,
        null,
      ],
    ] as const)("%s", (_label, event, isMac, expected) => {
      expect(resolvePanelTabCycleDirection(event, isMac ? mac : windows)).toBe(expected);
    });

    test("wraps and rejects missing or singular active scopes", () => {
      expect(resolveNextPanelTabId(tabs, "one", -1)).toBe("three");
      expect(resolveNextPanelTabId(tabs, "three", 1)).toBe("one");
      expect(resolveNextPanelTabId(tabs, "missing", 1)).toBeNull();
      expect(resolveNextPanelTabId(tabs, null, 1)).toBeNull();
      expect(resolveNextPanelTabId(tabs.slice(0, 1), "one", 1)).toBeNull();
    });

    test("maps native directions and platform close shortcuts", () => {
      expect(panelTabCycleRequestDirectionToOffset("previous")).toBe(-1);
      expect(panelTabCycleRequestDirectionToOffset("next")).toBe(1);
      expect(resolvePanelTabCloseShortcut(keyEvent({ key: "w", metaKey: true }), mac)).toBe(true);
      expect(resolvePanelTabCloseShortcut(keyEvent({ key: "W", ctrlKey: true }), windows)).toBe(
        true,
      );
      expect(
        resolvePanelTabCloseShortcut(
          keyEvent({ key: "w", ctrlKey: true, shiftKey: true }),
          windows,
        ),
      ).toBe(false);
    });

    test("honors custom and explicitly unassigned command bindings", () => {
      const customPrevious = createCommandKeymapState(
        {
          [PREVIOUS_PANEL_TAB_COMMAND_ID]: ["CmdOrCtrl+Alt+P"],
        },
        "macOS",
      );
      expect(
        resolvePanelTabCycleDirection(
          keyEvent({ key: "p", metaKey: true, altKey: true }),
          customPrevious,
        ),
      ).toBe(-1);
      expect(
        resolvePanelTabCycleDirection(
          keyEvent({ key: "[", code: "BracketLeft", metaKey: true, shiftKey: true }),
          customPrevious,
        ),
      ).toBeNull();

      const unassignedClose = createCommandKeymapState({ closeTab: [] }, "macOS");
      expect(
        resolvePanelTabCloseShortcut(keyEvent({ key: "w", metaKey: true }), unassignedClose),
      ).toBe(false);
    });
  });
});
