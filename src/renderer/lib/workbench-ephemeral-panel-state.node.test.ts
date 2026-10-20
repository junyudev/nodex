import { describe, expect, test } from "vite-plus/test";
import {
  createWorkbenchEphemeralPanelState,
  reduceWorkbenchEphemeralPanelState,
} from "./workbench-ephemeral-panel-state";
import { makeWorkbenchSceneKey } from "../../shared/workbench-scene";
import {
  makeWorkbenchPanelSlotKey,
  makeWorkbenchSessionPanelSlotKey,
} from "./workbench-panel-slot-key";

describe("Workbench ephemeral panel state", () => {
  test("functional updates are committed through one aggregate", () => {
    const slot = makeWorkbenchSessionPanelSlotKey("session:one", "right", "leaf:right");
    const initial = createWorkbenchEphemeralPanelState();
    const next = reduceWorkbenchEphemeralPanelState(initial, {
      type: "update",
      field: "sideChatActiveTabByPanel",
      update: (current) => ({
        ...current,
        [slot]: "side-chat:one",
      }),
    });

    expect(next.sideChatActiveTabByPanel).toEqual({
      [slot]: "side-chat:one",
    });
    expect(next.mcpAppActiveTabByPanel).toBe(initial.mcpAppActiveTabByPanel);
  });

  test("identity updates preserve the aggregate reference", () => {
    const initial = createWorkbenchEphemeralPanelState();
    const next = reduceWorkbenchEphemeralPanelState(initial, {
      type: "update",
      field: "pendingProcessOutputOpen",
      update: null,
    });

    expect(next).toBe(initial);
  });

  test("session pruning removes every family and slot-keyed override", () => {
    const oneRightLeaf = makeWorkbenchSessionPanelSlotKey("session:one", "right", "leaf:right");
    const twoRightLeaf = makeWorkbenchSessionPanelSlotKey("session:two", "right", "leaf:right");
    const oneBottomLeaf = makeWorkbenchSessionPanelSlotKey("session:one", "bottom", "leaf:bottom");
    const oneRight = makeWorkbenchSessionPanelSlotKey("session:one", "right");
    const twoRight = makeWorkbenchSessionPanelSlotKey("session:two", "right");
    const initial = {
      ...createWorkbenchEphemeralPanelState(),
      sideChatTabsBySession: {
        "session:one": [],
        "session:two": [],
      },
      sideChatActiveTabByPanel: {
        [oneRightLeaf]: "side-chat:one",
        [twoRightLeaf]: "side-chat:two",
      },
      mcpAppTabsBySession: {
        "session:one": [],
      },
      imageEditorTabsBySession: {
        "session:one": [],
        "session:two": [],
      },
      imageEditorActiveTabByPanel: {
        [oneRightLeaf]: "image:one",
        [twoRightLeaf]: "image:two",
      },
      planActiveTabByPanel: {
        [oneBottomLeaf]: "plan:one",
      },
      activePlanKeyBySession: {
        "session:one": "plan:one",
        "session:two": "plan:two",
      },
      panelCollapsedOverrides: {
        [oneRight]: false,
        [twoRight]: true,
      },
    };

    const next = reduceWorkbenchEphemeralPanelState(initial, {
      type: "prune-session",
      sessionId: "session:one",
    });

    expect(next.sideChatTabsBySession).toEqual({
      "session:two": [],
    });
    expect(next.sideChatActiveTabByPanel).toEqual({
      [twoRightLeaf]: "side-chat:two",
    });
    expect(next.mcpAppTabsBySession).toEqual({});
    expect(next.imageEditorTabsBySession).toEqual({
      "session:two": [],
    });
    expect(next.imageEditorActiveTabByPanel).toEqual({
      [twoRightLeaf]: "image:two",
    });
    expect(next.planActiveTabByPanel).toEqual({});
    expect(next.activePlanKeyBySession).toEqual({
      "session:two": "plan:two",
    });
    expect(next.panelCollapsedOverrides).toEqual({
      [twoRight]: true,
    });
  });

  test("owner pruning removes only that Scene's surface previews", () => {
    const projectOwnerKey = makeWorkbenchSceneKey({
      kind: "project",
      projectId: "project:one",
    });
    const pagesOwnerKey = makeWorkbenchSceneKey({ kind: "library" });
    const projectSlot = makeWorkbenchPanelSlotKey(projectOwnerKey, "right", "leaf:project");
    const pagesSlot = makeWorkbenchPanelSlotKey(pagesOwnerKey, "right", "leaf:pages");
    const initial = {
      ...createWorkbenchEphemeralPanelState(),
      previewSurfacesByPanel: {
        [projectSlot]: {
          id: "surface:project",
          kind: "page_stage" as const,
          titleSnapshot: "Project Page",
          config: {
            routingContext: { kind: "project" as const, projectId: "project:one" },
            pageId: "page:project",
          },
          stateKey: 0,
          state: null,
        },
        [pagesSlot]: {
          id: "surface:pages",
          kind: "page_stage" as const,
          titleSnapshot: "Library Page",
          config: {
            routingContext: { kind: "library" as const },
            pageId: "page:pages",
          },
          stateKey: 0,
          state: null,
        },
      },
    };

    const next = reduceWorkbenchEphemeralPanelState(initial, {
      type: "prune-owner",
      ownerKey: projectOwnerKey,
    });

    expect(next.previewSurfacesByPanel).toEqual({
      [pagesSlot]: initial.previewSurfacesByPanel[pagesSlot],
    });
  });

  test("selecting one family atomically clears competing slot selections", () => {
    const slot = makeWorkbenchSessionPanelSlotKey("session:one", "right", "leaf:right");
    const fallback = makeWorkbenchSessionPanelSlotKey("session:one", "right");
    const initial = {
      ...createWorkbenchEphemeralPanelState(),
      previewTabsByPanel: {
        [slot]: { id: "preview" },
      },
      sideChatActiveTabByPanel: {
        [fallback]: "side-chat:one",
      },
      mcpAppActiveTabByPanel: {
        [slot]: "mcp:one",
      },
      processOutputActiveTabByPanel: {
        [slot]: "process:one",
      },
      imageEditorActiveTabByPanel: {
        [slot]: "image:one",
      },
    } as unknown as ReturnType<typeof createWorkbenchEphemeralPanelState>;

    const next = reduceWorkbenchEphemeralPanelState(initial, {
      type: "select-slot",
      slotKeys: [slot, fallback],
      activeField: "planActiveTabByPanel",
      tabId: "plan:one",
      sessionId: "session:one",
      planKey: "turn:one",
    });

    expect(next.previewTabsByPanel).toEqual({});
    expect(next.sideChatActiveTabByPanel).toEqual({});
    expect(next.mcpAppActiveTabByPanel).toEqual({});
    expect(next.processOutputActiveTabByPanel).toEqual({});
    expect(next.imageEditorActiveTabByPanel).toEqual({});
    expect(next.planActiveTabByPanel).toEqual({
      [slot]: "plan:one",
    });
    expect(next.activePlanKeyBySession).toEqual({
      "session:one": "turn:one",
    });
  });

  test("removes an image editor tab and clears only its active slots", () => {
    const slot = makeWorkbenchSessionPanelSlotKey("session:one", "right", "leaf:right");
    const fallback = makeWorkbenchSessionPanelSlotKey("session:one", "right");
    const initial = {
      ...createWorkbenchEphemeralPanelState(),
      imageEditorTabsBySession: {
        "session:one": [{ id: "image:one" }, { id: "image:two" }],
      },
      imageEditorActiveTabByPanel: {
        [slot]: "image:one",
        [fallback]: "image:two",
      },
    } as unknown as ReturnType<typeof createWorkbenchEphemeralPanelState>;

    const next = reduceWorkbenchEphemeralPanelState(initial, {
      type: "remove-ephemeral-tab",
      tabsField: "imageEditorTabsBySession",
      activeField: "imageEditorActiveTabByPanel",
      sessionId: "session:one",
      tabId: "image:one",
      slotKeys: [slot, fallback],
    });

    expect(next.imageEditorTabsBySession["session:one"]).toEqual([{ id: "image:two" }]);
    expect(next.imageEditorActiveTabByPanel).toEqual({
      [fallback]: "image:two",
    });
  });
});
