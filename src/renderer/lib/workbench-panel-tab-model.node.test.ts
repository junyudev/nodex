import { describe, expect, test } from "vite-plus/test";
import {
  buildSideChatParentNavigationPath,
  isAutomationPanelTab,
  isBackgroundAgentPanelTab,
  isImageEditorPanelTab,
  isMcpAppPanelTab,
  isPanelTabClosable,
  isPlanPanelTab,
  isProcessOutputPanelTab,
  isRootThreadRightPanelComposerOverlayEligibleTab,
  isSideChatPanelTab,
  isSubagentsPanelTab,
  isTransientPanelTab,
  makeImageEditorPanelTabId,
  makeProcessOutputPanelTabId,
  routeDeletedSelectedSubagentsToOverview,
  settlePendingSubagentsPanelTab,
  updateImageEditorPanelTabTitle,
  type ImageEditorPanelTab,
  type ProjectSessionRenderableTab,
  type SideChatPanelTab,
  type SubagentsPanelTab,
} from "./workbench-panel-tab-model";
import {
  makeTestWorkbenchSession,
  makeTestWorkbenchTab,
} from "@/components/workbench/workbench-testkit/panel-fixtures";

function transient(discriminant: string): ProjectSessionRenderableTab {
  return {
    [discriminant]: true,
    id: discriminant,
    sessionId: "session-1",
    projectId: "project-1",
    panelId: "right",
    title: discriminant,
    stateKey: 0,
  } as unknown as ProjectSessionRenderableTab;
}

describe("workbench panel tab model", () => {
  test.each([
    ["sideChat", isSideChatPanelTab],
    ["mcpApp", isMcpAppPanelTab],
    ["planPanel", isPlanPanelTab],
    ["automationPanel", isAutomationPanelTab],
    ["backgroundAgent", isBackgroundAgentPanelTab],
    ["subagentsPanel", isSubagentsPanelTab],
    ["processOutputPanel", isProcessOutputPanelTab],
    ["imageEditor", isImageEditorPanelTab],
  ] as const)("recognizes only the %s discriminant", (kind, guard) => {
    expect(guard(transient(kind))).toBe(true);
    expect(guard(transient("different"))).toBe(false);
  });

  test("classifies every auxiliary family as transient", () => {
    for (const discriminant of [
      "sideChat",
      "mcpApp",
      "planPanel",
      "automationPanel",
      "backgroundAgent",
      "subagentsPanel",
      "processOutputPanel",
      "imageEditor",
    ]) {
      expect(isTransientPanelTab(transient(discriminant))).toBe(true);
    }
    expect(
      isTransientPanelTab(
        makeTestWorkbenchTab({
          id: "browser",
          kind: "browser",
        }),
      ),
    ).toBe(false);
  });

  test("keeps loading side chats non-closable", () => {
    const sideChat = {
      sideChat: true,
      id: "side-chat",
      sessionId: "session-1",
      panelId: "right",
      parentThreadId: "parent",
      parentNavigationPath: "path",
      threadId: null,
      title: "Side chat",
      status: "loading",
      stateKey: 0,
    } satisfies SideChatPanelTab;
    expect(isPanelTabClosable(sideChat)).toBe(false);
    expect(isPanelTabClosable({ ...sideChat, status: "ready" })).toBe(true);
    expect(isPanelTabClosable({ ...sideChat, status: "expired" })).toBe(true);
    expect(isPanelTabClosable({ ...sideChat, status: "failed" })).toBe(true);
  });

  test("limits root composer overlay eligibility to durable surfaces", () => {
    for (const tab of [
      makeTestWorkbenchTab({ id: "review", kind: "review" }),
      makeTestWorkbenchTab({ id: "browser", kind: "browser" }),
      makeTestWorkbenchTab({
        id: "page",
        kind: "page_stage",
        pageId: "page-1",
      }),
    ]) {
      expect(isRootThreadRightPanelComposerOverlayEligibleTab(tab)).toBe(true);
    }
    expect(
      isRootThreadRightPanelComposerOverlayEligibleTab(
        makeTestWorkbenchTab({
          id: "terminal",
          kind: "terminal",
        }),
      ),
    ).toBe(false);
    expect(isRootThreadRightPanelComposerOverlayEligibleTab(transient("planPanel"))).toBe(false);
    const imageTab = {
      ...transient("imageEditor"),
      threadId: "thread-1",
      options: {
        composerTarget: null,
        initialView: "single",
      },
    } as ImageEditorPanelTab;
    expect(isRootThreadRightPanelComposerOverlayEligibleTab(imageTab)).toBe(true);
    expect(
      isRootThreadRightPanelComposerOverlayEligibleTab({
        ...imageTab,
        threadId: null,
      } as ImageEditorPanelTab),
    ).toBe(false);
    expect(
      isRootThreadRightPanelComposerOverlayEligibleTab({
        ...imageTab,
        threadId: null,
        options: {
          ...imageTab.options,
          composerTarget: {
            channelId: "/new-chat::root",
            placement: "root",
          },
        },
      }),
    ).toBe(true);
    expect(isRootThreadRightPanelComposerOverlayEligibleTab(null)).toBe(false);
  });

  test("encodes process identities and project-aware side-chat paths", () => {
    expect(makeProcessOutputPanelTabId("thread:a/b", "item:c d")).toBe(
      "process-output:thread%3Aa%2Fb:item%3Ac%20d",
    );
    expect(
      buildSideChatParentNavigationPath(
        makeTestWorkbenchSession({ projectId: "project-1" }),
        "thread-1",
      ),
    ).toBe("project:project-1/session:session-1/thread:thread-1");
    expect(
      buildSideChatParentNavigationPath(makeTestWorkbenchSession({ projectId: null }), "thread-1"),
    ).toBe("session:session-1/thread:thread-1");
  });

  test("creates renderer-local image tab identities", () => {
    expect(makeImageEditorPanelTabId()).toMatch(/^image:[0-9a-f-]{36}$/u);
  });

  test("updates image chrome without changing tab identity", () => {
    const tab = {
      ...transient("imageEditor"),
      id: "image:one",
      title: "User attachment",
      tooltip: "User attachment",
    } as ImageEditorPanelTab;
    const sibling = {
      ...tab,
      id: "image:two",
    } as ImageEditorPanelTab;

    const next = updateImageEditorPanelTabTitle([tab, sibling], tab.id, "  Generated image 2  ");

    expect(next[0]).toMatchObject({
      id: tab.id,
      title: "Generated image 2",
      tooltip: "Generated image 2",
    });
    expect(next[1]).toBe(sibling);
  });

  test("settles only the still-owned pending Subagents route", () => {
    const pending = {
      subagentsPanel: true,
      id: "subagents:root",
      sessionId: "session-1",
      projectId: "project-1",
      panelId: "right",
      rootThreadId: "root",
      selectedThreadId: "child",
      selectedDisplayName: "Child",
      selectedCanInteract: false,
      selectedHydration: { status: "pending", requestId: 7 },
      title: "Subagents",
      stateKey: 10,
    } satisfies SubagentsPanelTab;
    const ready = {
      ...pending,
      selectedCanInteract: true,
      selectedHydration: {
        status: "ready",
        revision: 2,
        fidelity: "attachedSparse",
        checkpoint: "checkpoint",
      },
    } satisfies SubagentsPanelTab;
    const current = { "session-1": [pending] };

    const settled = settlePendingSubagentsPanelTab(current, {
      sessionId: "session-1",
      tabId: pending.id,
      requestId: 7,
      tab: ready,
    });
    expect(settled["session-1"]?.[0]).toMatchObject({
      selectedHydration: { status: "ready" },
      stateKey: 11,
    });

    const closedOrPruned = {};
    expect(
      settlePendingSubagentsPanelTab(closedOrPruned, {
        sessionId: "session-1",
        tabId: pending.id,
        requestId: 7,
        tab: ready,
      }),
    ).toBe(closedOrPruned);
    expect(
      settlePendingSubagentsPanelTab(
        { "session-1": [{ ...pending, selectedHydration: { status: "pending", requestId: 8 } }] },
        {
          sessionId: "session-1",
          tabId: pending.id,
          requestId: 7,
          tab: ready,
        },
      )["session-1"]?.[0],
    ).toMatchObject({ selectedHydration: { status: "pending", requestId: 8 } });
  });

  test("routes deleted selected Subagents to overview across hidden and pending tabs", () => {
    const selected = {
      subagentsPanel: true,
      id: "subagents:root-1",
      sessionId: "session-1",
      projectId: "project-1",
      panelId: "right",
      rootThreadId: "root-1",
      selectedThreadId: "child-deleted",
      selectedDisplayName: "Deleted child",
      selectedCanInteract: true,
      selectedHydration: { status: "pending", requestId: 9 },
      title: "Subagents",
      stateKey: 12,
    } satisfies SubagentsPanelTab;
    const unrelated = {
      ...selected,
      id: "subagents:root-2",
      rootThreadId: "root-2",
      selectedThreadId: "child-kept",
    } satisfies SubagentsPanelTab;
    const current = {
      "session-1": [selected],
      "session-2": [unrelated],
    };

    const routed = routeDeletedSelectedSubagentsToOverview(current, "child-deleted");

    expect(routed["session-1"]?.[0]).toMatchObject({
      selectedThreadId: null,
      selectedDisplayName: null,
      selectedCanInteract: false,
      selectedHydration: null,
      stateKey: 13,
    });
    expect(routed["session-2"]?.[0]).toBe(unrelated);
    expect(routeDeletedSelectedSubagentsToOverview(current, "missing-child")).toBe(current);
  });
});
