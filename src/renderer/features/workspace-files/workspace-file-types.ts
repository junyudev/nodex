import type { PanelId, WorkbenchTabProjection, WorkspaceFileMetadata } from "@/lib/types";

export interface WorkspaceFilesDraftState {
  path: string;
  content: string;
  baseMtimeMs: number | null;
  updatedAt: string;
}

export interface WorkspaceFileRevealLocation {
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface WorkspaceFilesTabState {
  draft?: WorkspaceFilesDraftState;
  /** Whether a file that can toggle (Markdown, SVG) shows its rich view instead of its source. */
  richView?: boolean;
  treeVisible?: boolean;
  treeWidth?: number;
  wordWrap?: boolean;
  pendingReveal?: WorkspaceFileRevealLocation;
}

export function normalizeWorkspaceFilesTabState(value: unknown): WorkspaceFilesTabState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const candidate = value as Partial<WorkspaceFilesTabState>;
  const draft = candidate.draft;
  const validDraft =
    typeof draft === "object" &&
    draft !== null &&
    typeof draft.path === "string" &&
    typeof draft.content === "string" &&
    (typeof draft.baseMtimeMs === "number" || draft.baseMtimeMs === null) &&
    typeof draft.updatedAt === "string"
      ? draft
      : undefined;
  return {
    ...(validDraft ? { draft: validDraft } : {}),
    ...(typeof candidate.richView === "boolean" ? { richView: candidate.richView } : {}),
    ...(typeof candidate.treeVisible === "boolean" ? { treeVisible: candidate.treeVisible } : {}),
    ...(typeof candidate.treeWidth === "number" && Number.isFinite(candidate.treeWidth)
      ? { treeWidth: candidate.treeWidth }
      : {}),
    ...(typeof candidate.wordWrap === "boolean" ? { wordWrap: candidate.wordWrap } : {}),
    ...(isValidRevealLocation(candidate.pendingReveal)
      ? { pendingReveal: candidate.pendingReveal }
      : {}),
  };
}

function isValidRevealLocation(value: unknown): value is WorkspaceFileRevealLocation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const hasValidNumber = (key: string) => {
    const item = candidate[key];
    return (
      item === undefined || (typeof item === "number" && Number.isSafeInteger(item) && item > 0)
    );
  };
  const line = candidate.line;
  const endLine = candidate.endLine;
  const endColumn = candidate.endColumn;
  return (
    hasValidNumber("line") &&
    hasValidNumber("column") &&
    hasValidNumber("endLine") &&
    hasValidNumber("endColumn") &&
    typeof line === "number" &&
    (typeof endLine !== "number" || endLine >= line) &&
    (typeof endColumn !== "number" || typeof endLine === "number")
  );
}

export type WorkspaceFilesTab = Omit<WorkbenchTabProjection, "projectId" | "config" | "state"> & {
  projectId: string | null;
  panelId: PanelId;
  preview?: true;
  state: WorkspaceFilesTabState;
  config: {
    projectId: string | null;
    hostId?: string;
    workspaceRoot?: string | null;
    cwd?: string | null;
    path?: string;
  };
};

export interface WorkspaceFilePreviewState {
  status: "idle" | "loading" | "loaded" | "unsupported" | "error";
  path: string | null;
  metadata: WorkspaceFileMetadata | null;
  content: string;
  binaryUrl: string | null;
  message: string | null;
}
