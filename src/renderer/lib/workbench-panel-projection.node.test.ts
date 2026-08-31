import { describe, expect, test } from "vite-plus/test";
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
import { makeWorkbenchSessionPanelSlotKey } from "./workbench-panel-slot-key";
import {
  makeTestWorkbenchSession,
  makeTestWorkbenchTab,
} from "@/components/workbench/workbench-testkit/panel-fixtures";

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
