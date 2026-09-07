import { describe, expect, test } from "vite-plus/test";
import {
  WorkbenchRendererObservationSchema,
  WorkbenchSubmitPresentationSchema,
} from "../../shared/nodex-app-tools/workbench";
import {
  createDefaultWorkbenchLayoutSnapshot,
  type WorkbenchLayoutSnapshot,
} from "../../shared/workbench-layout";
import { findWorkbenchPanelLeafForTab } from "../../shared/workbench-panel-layout";
import {
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  maximizeWorkbenchSceneLeaf,
  patchWorkbenchScenePanel,
  splitWorkbenchSceneLeaf,
  updateWorkbenchSceneSurface,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
} from "../../shared/workbench-scene";
import { normalizeUserAttachmentImageEditorOptions } from "../features/user-attachment-image-editor/model/feature-policy";
import { makeTestWorkbenchTab } from "../components/workbench/workbench-testkit/panel-fixtures";
import { createWorkbenchEphemeralPanelState } from "./workbench-ephemeral-panel-state";
import {
  discoverWorkbenchAgentScenes,
  readWorkbenchAgentContext,
  readWorkbenchSubmitPresentation,
} from "./workbench-agent-context";
import {
  makeWorkbenchPanelSlotKey,
  makeWorkbenchSessionPanelSlotKey,
} from "./workbench-panel-slot-key";
import { makeWorkbenchScenePreviewSlotKey } from "./workbench-scene-preview";
import { createWorkbenchWindowState } from "./workbench-window-state";
import type { WorkbenchWindowPresentationState } from "./workbench-window-owner";

function stateFor(
  scenes: readonly WorkbenchSceneSnapshot[],
  location: WorkbenchLayoutSnapshot["location"],
): WorkbenchWindowPresentationState {
  return {
    presentationRevision: 7,
    windowState: createWorkbenchWindowState({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location,
      scenesByOwnerKey: Object.fromEntries(
        scenes.map((scene) => [makeWorkbenchSceneKey(scene.owner), scene]),
      ),
    }),
    ephemeralPanels: createWorkbenchEphemeralPanelState(),
    focusedPanelGroup: null,
  };
}

function browser(id: string): WorkbenchSurfaceDescriptor {
  return {
    id,
    kind: "browser",
    titleSnapshot: id,
    stateKey: 5,
    state: { privateViewState: true },
    config: { browserTabId: `browser:${id}`, url: `https://example.test/${id}` },
  };
}

describe("Workbench Agent presentation observation", () => {
  test("submission captures selected semantic targets even when a tab ID is later reused", () => {
    const sceneOwner = { kind: "pages" as const };
    let scene = materializeInitialWorkbenchScene(sceneOwner);
    scene = createWorkbenchSceneSurface(scene, {
      panelId: "right",
      surface: {
        id: "page-tab",
        kind: "page_stage",
        titleSnapshot: "First page",
        stateKey: 0,
        state: null,
        config: { accessContext: { kind: "library" }, pageId: "page-first" },
      },
    });
    const state = stateFor([scene], { kind: "pages" });
    const submission = readWorkbenchSubmitPresentation(state, "generation-a");
    const next = updateWorkbenchSceneSurface(scene, "page-tab", {
      config: { accessContext: { kind: "library" }, pageId: "page-second" },
    });
    const after = readWorkbenchSubmitPresentation(
      stateFor([next], { kind: "pages" }),
      "generation-a",
    );
    expect(submission.focusedTarget).toBeNull();
    expect(submission.selectedTabs).toMatchObject([
      { tabId: "page-tab", surface: { config: { pageId: "page-first" } } },
    ]);
    expect(after.selectedTabs).toMatchObject([
      { tabId: "page-tab", surface: { config: { pageId: "page-second" } } },
    ]);
  });
  test("observes Project previews while preserving the one protected primary and exact identities", () => {
    const owner = { kind: "project" as const, projectId: "project-a" };
    const scene = materializeInitialWorkbenchScene(owner);
    const leafId = scene.panels.right.layout.activeLeafId;
    const state = stateFor([scene], { kind: "project", projectId: "project-a" });
    const preview: WorkbenchSurfaceDescriptor = {
      id: "preview-page",
      kind: "page_stage",
      titleSnapshot: "Preview page",
      config: { accessContext: { kind: "project", projectId: "project-a" }, pageId: "page-a" },
      stateKey: 3,
      state: { selectedBlock: "private-block" },
    };
    const observedState = {
      ...state,
      ephemeralPanels: {
        ...state.ephemeralPanels,
        previewSurfacesByPanel: {
          [makeWorkbenchScenePreviewSlotKey(owner, "right", leafId)]: preview,
        },
      },
      focusedPanelGroup: {
        ownerKey: makeWorkbenchSceneKey(owner),
        panelId: "right" as const,
        leafId,
      },
    };

    const observation = readWorkbenchAgentContext(observedState, owner)!;
    expect(WorkbenchRendererObservationSchema.safeParse(observation).success).toBe(true);
    expect(observation.tabs.filter((tab) => tab.protected)).toHaveLength(1);
    expect(observation.tabs.find((tab) => tab.protected)).toMatchObject({
      tabId: scene.primary!.id,
      panelId: "right",
      groupId: leafId,
      selected: false,
      visible: false,
      persisted: true,
      preview: false,
    });
    expect(observation.tabs.find((tab) => tab.tabId === preview.id)).toMatchObject({
      selected: true,
      visible: true,
      persisted: false,
      preview: true,
      surface: { id: preview.id, config: preview.config },
    });
    expect(observation.tabs.find((tab) => tab.tabId === preview.id)?.surface).not.toHaveProperty(
      "state",
    );
    expect(observation.tabs.find((tab) => tab.tabId === preview.id)?.surface).not.toHaveProperty(
      "stateKey",
    );
    expect(observation.focusedTarget).toEqual({
      tabId: preview.id,
      panelId: "right",
      groupId: leafId,
    });
    expect(readWorkbenchAgentContext(observedState, owner)).toEqual(observation);
    expect(
      state.windowState.scenesByOwnerKey[makeWorkbenchSceneKey(owner)]?.panelSurfacesById[
        preview.id
      ],
    ).toBeUndefined();
  });

  test("uses Session auxiliary selection and preview rules without returning auxiliary runtime content", () => {
    const owner = { kind: "session" as const, sessionId: "session-a" };
    const scene = patchWorkbenchScenePanel(
      createWorkbenchSceneSurface(materializeInitialWorkbenchScene(owner), {
        panelId: "right",
        surface: browser("durable"),
      }),
      "right",
      { size: { fullWidth: true } },
    );
    const leafId = scene.panels.right.layout.activeLeafId;
    const state = stateFor([scene], {
      kind: "session",
      sessionId: owner.sessionId,
      projectContextId: null,
    });
    const slotKey = makeWorkbenchSessionPanelSlotKey(owner.sessionId, "right", leafId);
    const common = {
      sessionId: owner.sessionId,
      projectId: "project-a",
      panelId: "right" as const,
      leafId,
      stateKey: 0,
    };
    const ephemeralPanels = {
      ...state.ephemeralPanels,
      sideChatTabsBySession: {
        [owner.sessionId]: [
          {
            ...common,
            sideChat: true as const,
            id: "side",
            parentThreadId: "parent-thread",
            parentNavigationPath: "/",
            threadId: null,
            title: "Side chat",
            status: "loading" as const,
          },
        ],
      },
      mcpAppTabsBySession: {
        [owner.sessionId]: [
          {
            ...common,
            mcpApp: true as const,
            id: "mcp",
            title: "MCP App",
            app: {
              mcpAppId: "app-a",
              capabilityId: "capability-a",
              title: "MCP App",
              threadId: "thread-a",
              server: "server-a",
              tool: "tool-a",
            },
          },
        ],
      },
      planTabsBySession: {
        [owner.sessionId]: [
          {
            ...common,
            planPanel: true as const,
            id: "plan" as const,
            title: "Plan" as const,
            planKey: "plan-a",
            threadId: "thread-a",
            turnId: "turn-a",
            itemId: "item-a",
            content: "Private plan content",
            cwd: "/private/workspace",
          },
        ],
      },
      automationTabsBySession: {
        [owner.sessionId]: [
          {
            ...common,
            automationPanel: true as const,
            id: "automation",
            title: "Automation",
            automationId: "automation-a",
            createInput: null,
            mode: "open" as const,
            updateInput: null,
          },
        ],
      },
      backgroundAgentTabsBySession: {
        [owner.sessionId]: [
          {
            ...common,
            subagentsPanel: true as const,
            id: "agents",
            rootThreadId: "thread-a",
            selectedThreadId: null,
            selectedDisplayName: null,
            selectedHydration: null,
            title: "Subagents" as const,
          },
        ],
      },
      processOutputTabsBySession: {
        [owner.sessionId]: [
          {
            ...common,
            processOutputPanel: true as const,
            id: "process",
            threadId: "thread-a",
            turnId: "turn-a",
            itemId: "item-a",
            title: "Process",
            command: "private command",
            cwd: "/private/workspace",
            terminalSessionId: null,
          },
        ],
      },
      imageEditorTabsBySession: {
        [owner.sessionId]: [
          {
            ...common,
            imageEditor: true as const,
            id: "image:temporary" as const,
            threadId: "thread-a",
            title: "Image",
            tooltip: "Image",
            preview: true as const,
            pinBehavior: "automatic" as const,
            options: normalizeUserAttachmentImageEditorOptions({
              alt: "Private image",
              src: "data:image/png;base64,AA==",
              attachmentSrc: "data:image/png;base64,AA==",
            }),
          },
        ],
      },
      planActiveTabByPanel: { [slotKey]: "plan" },
      previewTabsByPanel: {
        [slotKey]: {
          ...makeTestWorkbenchTab({ id: "preview", kind: "browser" }, owner.sessionId),
          preview: true as const,
        },
      },
    };
    const observedState = {
      ...state,
      ephemeralPanels,
      focusedPanelGroup: {
        ownerKey: makeWorkbenchSceneKey(owner),
        panelId: "right" as const,
        leafId,
      },
    };
    const observation = readWorkbenchAgentContext(observedState, owner)!;
    expect(WorkbenchRendererObservationSchema.safeParse(observation).success).toBe(true);
    expect(observation.tabs.filter((tab) => tab.auxiliary).map((tab) => tab.auxiliary)).toEqual([
      { kind: "side_chat", title: "Side chat" },
      { kind: "mcp_app", title: "MCP App" },
      { kind: "plan", title: "Plan" },
      { kind: "automation", title: "Automation" },
      { kind: "agent", title: "Subagents" },
      { kind: "process_output", title: "Process" },
      { kind: "image_editor", title: "Image" },
    ]);
    expect(observation.tabs.filter((tab) => tab.preview).map((tab) => tab.tabId)).toEqual([
      "image:temporary",
      "preview",
    ]);
    expect(observation.tabs.find((tab) => tab.protected)).toMatchObject({
      panelId: null,
      groupId: null,
      selected: true,
      visible: false,
    });
    expect(observation.focusedTarget).toEqual({
      tabId: "preview",
      panelId: "right",
      groupId: leafId,
    });
    expect(observation.tabs.find((tab) => tab.tabId === "preview")?.surface).toMatchObject({
      kind: "browser",
      config: { browserTabId: "browser:preview" },
    });

    const withoutPreview = {
      ...observedState,
      ephemeralPanels: { ...ephemeralPanels, previewTabsByPanel: {} },
    };
    expect(readWorkbenchAgentContext(withoutPreview, owner)?.focusedTarget?.tabId).toBe("plan");
    const collapsed = readWorkbenchAgentContext(
      {
        ...withoutPreview,
        ephemeralPanels: {
          ...withoutPreview.ephemeralPanels,
          panelCollapsedOverrides: {
            [makeWorkbenchPanelSlotKey(makeWorkbenchSceneKey(owner), "right")]: true,
          },
        },
      },
      owner,
    )!;
    expect(collapsed.focusedTarget).toBeNull();
    expect(collapsed.tabs.find((tab) => tab.protected)?.visible).toBe(true);
    expect(
      collapsed.tabs.filter((tab) => tab.panelId === "right").every((tab) => !tab.visible),
    ).toBe(true);
  });

  test("describes split groups and maximization while keeping hidden Scene selection unchanged", () => {
    const owner = { kind: "session" as const, sessionId: "session-a" };
    let scene = materializeInitialWorkbenchScene(owner);
    scene = createWorkbenchSceneSurface(scene, { panelId: "right", surface: browser("one") });
    scene = createWorkbenchSceneSurface(scene, { panelId: "right", surface: browser("two") });
    const firstLeaf = scene.panels.right.layout.activeLeafId;
    scene = splitWorkbenchSceneLeaf(scene, {
      panelId: "right",
      leafId: firstLeaf,
      side: "right",
      surfaceId: "two",
    });
    const secondLeaf = findWorkbenchPanelLeafForTab(scene.panels.right.layout, "two")!.id;
    scene = maximizeWorkbenchSceneLeaf(scene, { panelId: "right", leafId: secondLeaf });
    const state = stateFor([scene], {
      kind: "session",
      sessionId: owner.sessionId,
      projectContextId: null,
    });
    const observation = readWorkbenchAgentContext(state, owner)!;
    expect(
      observation.groups
        .filter((group) => group.panelId === "right" && group.visible)
        .map((group) => group.groupId),
    ).toEqual([secondLeaf]);
    expect(observation.splits).toMatchObject([
      {
        panelId: "right",
        direction: "horizontal",
        firstGroupIds: [firstLeaf],
        secondGroupIds: [secondLeaf],
      },
    ]);
    expect(observation.tabs.find((tab) => tab.tabId === "one")).toMatchObject({
      selected: true,
      visible: false,
    });
    expect(observation.tabs.find((tab) => tab.tabId === "two")).toMatchObject({
      selected: true,
      visible: true,
    });
    const hiddenState = {
      ...state,
      windowState: { ...state.windowState, location: { kind: "pages" as const } },
    };
    const hidden = readWorkbenchAgentContext(hiddenState, owner)!;
    expect(hidden.mounted).toBe(false);
    expect(hidden.selectedSceneOwner).toEqual({ kind: "pages" });
    expect(hidden.tabs.every((tab) => !tab.visible)).toBe(true);
    expect(hiddenState.windowState.location).toEqual({ kind: "pages" });
  });

  test("discovers exact Session and Project Dock owners and captures the submitting Scene", () => {
    const session = materializeInitialWorkbenchScene({ kind: "session", sessionId: "session-a" });
    const project = materializeInitialWorkbenchScene({ kind: "project", projectId: "project-a" });
    const dockScene = {
      ...project,
      agentDock: {
        binding: { kind: "session" as const, sessionId: "session-a" },
        newDraftId: project.agentDock!.newDraftId,
      },
    };
    const pages = materializeInitialWorkbenchScene({ kind: "pages" });
    const state = stateFor([session, dockScene, pages], {
      kind: "project",
      projectId: "project-a",
    });
    expect(discoverWorkbenchAgentScenes(state, "session-a")).toEqual({
      kind: "discover",
      presentationRevision: 7,
      selectedSceneOwner: project.owner,
      sceneOwners: [session.owner, project.owner],
    });
    expect(discoverWorkbenchAgentScenes(state, "missing").sceneOwners).toEqual([]);
    const submit = readWorkbenchSubmitPresentation(state, "renderer-a");
    expect(WorkbenchSubmitPresentationSchema.safeParse(submit).success).toBe(true);
    expect(submit).toEqual({
      rendererGeneration: "renderer-a",
      sceneOwner: project.owner,
      presentationRevision: 7,
      focusedTarget: null,
      selectedTabs: readWorkbenchAgentContext(state, project.owner)?.tabs.filter(
        (tab) => tab.selected,
      ),
    });
    expect(readWorkbenchAgentContext(state, { kind: "session", sessionId: "absent" })).toBeNull();
    expect(readWorkbenchAgentContext(state, { kind: "pages" })?.tabs).toEqual([]);
    const routed = {
      ...state,
      windowState: {
        ...state.windowState,
        location: {
          kind: "settings" as const,
          path: "/settings",
          returnTo: { kind: "project" as const, projectId: "project-a" },
        },
      },
    };
    expect(readWorkbenchSubmitPresentation(routed, "renderer-a").sceneOwner).toBeNull();
    expect(readWorkbenchAgentContext(routed, project.owner)?.mounted).toBe(false);
  });
});
