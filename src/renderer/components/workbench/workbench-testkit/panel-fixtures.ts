import type { PanelId, ProjectSessionThreadLink, WorkbenchTabProjection } from "@/lib/types";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import {
  insertWorkbenchPanelLeaf,
  makeWorkbenchPanelLayout,
} from "../../../../shared/workbench-panel-layout";

const TIMESTAMP = "2026-07-28T00:00:00.000Z";

export function makeTestWorkbenchTab(
  input:
    | {
        id: string;
        kind: "browser";
        panelId?: PanelId;
        projectId?: string | null;
        url?: string;
      }
    | {
        id: string;
        kind: "page_stage";
        panelId?: PanelId;
        projectId?: string;
        pageId: string;
      }
    | {
        id: string;
        kind: "review";
        panelId?: PanelId;
        projectId?: string;
      }
    | {
        id: string;
        kind: "terminal";
        panelId?: PanelId;
        terminalSessionId?: string;
      },
  sessionId = "session-1",
): WorkbenchTabProjection {
  const projectId =
    "projectId" in input && input.projectId !== undefined ? input.projectId : "project-1";
  const base = {
    id: input.id,
    sessionId,
    projectId,
    panelId: input.panelId ?? "right",
    title: input.id,
    order: 0,
    stateKey: 0,
    state: {},
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };

  switch (input.kind) {
    case "browser":
      return {
        ...base,
        kind: input.kind,
        browserTabId: `browser:${input.id}`,
        config: {
          projectId,
          ...(input.url ? { url: input.url } : {}),
        },
      };
    case "page_stage":
      return {
        ...base,
        projectId,
        kind: input.kind,
        browserTabId: null,
        config: {
          accessContext: { kind: "project", projectId: input.projectId ?? "project-1" },
          pageId: input.pageId,
        },
      };
    case "review":
      return {
        ...base,
        projectId,
        kind: input.kind,
        browserTabId: null,
        config: {
          projectId: input.projectId ?? "project-1",
        },
      };
    case "terminal":
      return {
        ...base,
        kind: input.kind,
        browserTabId: null,
        config: {
          terminalSessionId: input.terminalSessionId ?? `terminal:${input.id}`,
        },
      };
  }
}

export function makeTestWorkbenchSession(
  input: {
    id?: string;
    projectId?: string | null;
    tabs?: WorkbenchTabProjection[];
    rightTabIds?: string[];
    rightActiveTabId?: string | null;
    rightCollapsed?: boolean;
    rightFullWidth?: boolean;
    rightSecondLeafTabIds?: string[];
    rightSecondLeafActiveTabId?: string | null;
    rightMaximizedLeafId?: string | null;
    bottomTabIds?: string[];
    bottomActiveTabId?: string | null;
    bottomCollapsed?: boolean;
    thread?: ProjectSessionThreadLink | null;
  } = {},
): WorkbenchSessionRenderProjection {
  const id = input.id ?? "session-1";
  const tabs = input.tabs ?? [];
  const rightTabIds =
    input.rightTabIds ?? tabs.filter((tab) => tab.panelId === "right").map((tab) => tab.id);
  const bottomTabIds =
    input.bottomTabIds ?? tabs.filter((tab) => tab.panelId === "bottom").map((tab) => tab.id);
  let rightLayout = makeWorkbenchPanelLayout(
    rightTabIds,
    input.rightActiveTabId ?? rightTabIds[0] ?? null,
    "right-leaf",
  );
  if (input.rightSecondLeafTabIds) {
    rightLayout = insertWorkbenchPanelLeaf(rightLayout, {
      leafId: "right-leaf",
      newLeafId: "right-leaf-2",
      newBranchId: "right-branch",
      side: "right",
    });
    rightLayout = {
      ...rightLayout,
      root:
        rightLayout.root.type === "split"
          ? {
              ...rightLayout.root,
              second: {
                type: "leaf",
                id: "right-leaf-2",
                tabIds: input.rightSecondLeafTabIds,
                activeTabId:
                  input.rightSecondLeafActiveTabId ?? input.rightSecondLeafTabIds[0] ?? null,
                mruTabIds: input.rightSecondLeafTabIds,
              },
            }
          : rightLayout.root,
      maximizedLeafId: input.rightMaximizedLeafId ?? null,
    };
  }

  return {
    id,
    projectId: input.projectId === undefined ? "project-1" : input.projectId,
    noThreadFallbackTitle: "Test Session",
    displayTitle: "Test Session",
    order: 0,
    pinned: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    unread: false,
    thread: input.thread ?? null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    tabs,
    panels: {
      right: {
        collapsed: input.rightCollapsed ?? false,
        layout: rightLayout,
        size: {
          widthPx: 600,
          fullWidth: input.rightFullWidth ?? false,
        },
      },
      bottom: {
        collapsed: input.bottomCollapsed ?? true,
        layout: makeWorkbenchPanelLayout(
          bottomTabIds,
          input.bottomActiveTabId ?? bottomTabIds[0] ?? null,
          "bottom-leaf",
        ),
        size: { heightPx: 280 },
      },
    },
  };
}
