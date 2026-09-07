import { requireWorkbenchBrowserTabProjectionId } from "../../shared/browser-sidebar";
import { createSecureRuntimeId } from "../../shared/secure-runtime-id";
import type {
  PanelId,
  WorkbenchProjectionTabConfiguration,
  WorkbenchTabCreateInput,
  WorkbenchTabProjection,
} from "@/lib/types";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import {
  isProjectSessionFilesPreviewTab,
  type ProjectSessionFilesPreviewTab,
} from "@/lib/workbench-panel-tab-model";
import type { WorkspaceFileRevealLocation } from "@/features/workspace-files/workspace-file-types";
import { normalizeOptionalPath } from "@/lib/workbench-workspace-context";

const PREVIEWABLE_PROJECT_SESSION_TAB_KINDS = [
  "browser",
  "files",
] as const satisfies readonly WorkbenchTabProjection["kind"][];

export type PreviewableWorkbenchTabKind = (typeof PREVIEWABLE_PROJECT_SESSION_TAB_KINDS)[number];

const PREVIEWABLE_PROJECT_SESSION_TAB_KIND_SET = new Set<WorkbenchTabProjection["kind"]>(
  PREVIEWABLE_PROJECT_SESSION_TAB_KINDS,
);

export type ProjectSessionPreviewTab =
  | (WorkbenchTabProjection & { preview: true })
  | ProjectSessionFilesPreviewTab;

export type WorkbenchTabProjectionDraft = WorkbenchProjectionTabConfiguration & { title: string };

function makeClientWorkbenchTabProjectionId(): string {
  return createSecureRuntimeId("tab");
}

function makeTerminalSessionId(sessionId: string): string {
  return `session:${sessionId}:terminal:${Date.now()}`;
}

function resolveProjectBoundSessionId(session: WorkbenchSessionRenderProjection): string | null {
  return session.projectId;
}

export function makeClientTerminalTabId(terminalSessionId: string): string {
  return `terminal:${terminalSessionId}`;
}

export function isPreviewableWorkbenchTabKind(
  kind: WorkbenchTabProjection["kind"],
): kind is PreviewableWorkbenchTabKind {
  return PREVIEWABLE_PROJECT_SESSION_TAB_KIND_SET.has(kind);
}

/**
 * db_view is excluded: its descriptor requires a resolved Database View
 * identity, so creation goes through focusOrCreateProjectDbViewTab or the
 * destination picker instead of this generic draft path.
 */
export function makeWorkbenchTabProjectionDraft(
  session: WorkbenchSessionRenderProjection,
  kind: Exclude<WorkbenchTabProjection["kind"], "db_view">,
): WorkbenchTabProjectionDraft | null {
  const projectId = resolveProjectBoundSessionId(session);

  if (kind === "browser") {
    return {
      kind,
      title: "Browser",
      config: { projectId },
    };
  }

  if (kind === "terminal") {
    if (projectId === null && (!session.thread || !normalizeOptionalPath(session.thread.cwd))) {
      return null;
    }
    return {
      kind,
      title: "Terminal",
      config: {
        terminalSessionId: makeTerminalSessionId(session.id),
      },
    };
  }

  if (kind === "review") {
    if (!session.thread) return null;
    return {
      kind,
      title: "Review",
      config: { projectId },
    };
  }

  if (projectId === null) return null;

  if (kind === "files") {
    return {
      kind,
      title: "Files",
      config: {
        projectId,
        hostId: "local",
        workspaceRoot: null,
        cwd: session.thread?.cwd ?? null,
      },
    };
  }

  return null;
}

export function makePreviewWorkbenchTabProjection(
  session: WorkbenchSessionRenderProjection,
  panelId: PanelId,
  draft: WorkbenchTabProjectionDraft,
): ProjectSessionPreviewTab {
  const projectId = resolveProjectBoundSessionId(session);
  if (
    projectId === null &&
    draft.kind !== "browser" &&
    draft.kind !== "terminal" &&
    draft.kind !== "review" &&
    draft.kind !== "image_editor"
  ) {
    throw new Error("Projectless sessions cannot own this workbench tab");
  }
  const now = new Date().toISOString();
  const base = {
    id: `preview:${session.id}:${panelId}:${draft.kind}`,
    sessionId: session.id,
    projectId,
    panelId,
    title: draft.title,
    order: session.tabs.filter((tab) => tab.panelId === panelId).length,
    stateKey: 0,
    state: {},
    preview: true,
    createdAt: now,
    updatedAt: now,
  } as const;

  switch (draft.kind) {
    case "browser": {
      const browserTabId = makeClientWorkbenchTabProjectionId();
      return {
        ...base,
        kind: draft.kind,
        config: {
          ...draft.config,
          browserStorageId: draft.config.browserStorageId ?? `browser:${browserTabId}`,
        },
        browserTabId,
      };
    }
    case "db_view":
    case "page_stage":
    case "canvas_stage":
    case "terminal":
    case "review":
    case "files":
    case "image_editor":
      return {
        ...base,
        kind: draft.kind,
        config: draft.config,
        browserTabId: null,
      } as ProjectSessionPreviewTab;
  }
}

export function makePinnedPreviewTabCreateInput(
  session: WorkbenchSessionRenderProjection,
  panelId: PanelId,
  targetLeafId: string,
  previewTab: ProjectSessionPreviewTab,
): WorkbenchTabCreateInput {
  const base = {
    sessionId: session.id,
    panelId,
    targetLeafId,
    title: previewTab.title,
  } as const;

  switch (previewTab.kind) {
    case "db_view":
      return {
        ...base,
        kind: previewTab.kind,
        config: previewTab.config,
      };
    case "terminal":
      return {
        ...base,
        kind: previewTab.kind,
        config: previewTab.config,
      };
    case "review":
      return {
        ...base,
        kind: previewTab.kind,
        config: previewTab.config,
      };
    case "page_stage":
      return {
        ...base,
        kind: previewTab.kind,
        config: previewTab.config,
        clientTabId: previewTab.id,
      };
    case "canvas_stage":
      return {
        ...base,
        kind: previewTab.kind,
        config: previewTab.config,
      };
    case "browser":
      return {
        ...base,
        kind: previewTab.kind,
        config: previewTab.config,
        browserTabId: requireWorkbenchBrowserTabProjectionId(previewTab),
      };
    case "files":
      return {
        ...base,
        kind: previewTab.kind,
        clientTabId: previewTab.id,
        config: isProjectSessionFilesPreviewTab(previewTab)
          ? {
              ...previewTab.config,
              projectId: session.projectId ?? previewTab.config.projectId,
            }
          : previewTab.config,
      };
    case "image_editor":
      return {
        ...base,
        kind: previewTab.kind,
        clientTabId: previewTab.id,
        config: previewTab.config,
      };
  }
}

export function makePreviewWorkspaceFileTab(
  session: WorkbenchSessionRenderProjection,
  panelId: PanelId,
  input: {
    cwd: string | null;
    leafId: string;
    path: string;
    title: string;
    workspaceRoot: string | null;
    location?: WorkspaceFileRevealLocation;
  },
): ProjectSessionFilesPreviewTab {
  const now = new Date().toISOString();
  const projectId = session.projectId;
  return {
    id: `preview:${session.id}:${panelId}:${input.leafId}:files:${input.path}`,
    sessionId: session.id,
    projectId,
    browserTabId: null,
    panelId,
    kind: "files",
    title: input.title,
    order: session.tabs.filter((tab) => tab.panelId === panelId).length,
    config: {
      projectId,
      hostId: "local",
      cwd: input.cwd,
      workspaceRoot: input.workspaceRoot,
      path: input.path,
    },
    stateKey: 0,
    state: input.location ? { pendingReveal: input.location } : {},
    preview: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function makePreviewPageStageTab(
  session: WorkbenchSessionRenderProjection,
  panelId: PanelId,
  input: {
    projectId: string;
    pageId: string;
    titleSnapshot?: string;
  },
): ProjectSessionPreviewTab {
  const projectId = resolveProjectBoundSessionId(session);
  if (projectId === null) {
    throw new Error("Projectless sessions cannot own project-scoped tabs");
  }
  const now = new Date().toISOString();
  const title = input.titleSnapshot || input.pageId;
  return {
    id: makeClientWorkbenchTabProjectionId(),
    sessionId: session.id,
    projectId,
    browserTabId: null,
    panelId,
    kind: "page_stage",
    title,
    order: session.tabs.filter((tab) => tab.panelId === panelId).length,
    config: {
      accessContext: { kind: "project", projectId: input.projectId },
      pageId: input.pageId,
      ...(input.titleSnapshot ? { titleSnapshot: input.titleSnapshot } : {}),
    },
    stateKey: 0,
    state: {},
    preview: true,
    createdAt: now,
    updatedAt: now,
  };
}
