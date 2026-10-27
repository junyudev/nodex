import type { PanelId, WorkbenchTabProjection, WorkspaceFileMetadata } from "@/lib/types";
import type { WorkspaceFileGitSource } from "./workspace-file-git-model";

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

/** Whether a file shows its changes, and against which source once one is chosen or resolved. */
export interface WorkspaceFilesComparisonState {
  readonly path: string;
  readonly visible: boolean;
  readonly source: WorkspaceFileGitSource | null;
}

export interface WorkspaceFilesTabState {
  draft?: WorkspaceFilesDraftState;
  /** Whether a file that can toggle (Markdown, SVG) shows its rich view instead of its source. */
  richView?: boolean;
  treeVisible?: boolean;
  treeWidth?: number;
  wordWrap?: boolean;
  pendingReveal?: WorkspaceFileRevealLocation;
  comparison?: WorkspaceFilesComparisonState;
}

/** Opens a file showing its changes; a null source lets the file pick its comparison. */
export interface WorkspaceFileShowChanges {
  readonly source: WorkspaceFileGitSource | null;
}

/** The tab state a file opens with: a location to reveal, and whether it shows its changes. */
export function workspaceFileOpenState({
  path,
  location,
  showChanges,
}: {
  readonly path: string;
  readonly location?: WorkspaceFileRevealLocation;
  readonly showChanges?: WorkspaceFileShowChanges;
}): WorkspaceFilesTabState | null {
  if (!location && !showChanges) return null;
  return {
    ...(location ? { pendingReveal: location } : {}),
    ...(showChanges ? { comparison: { path, visible: true, source: showChanges.source } } : {}),
  };
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
    ...(normalizeComparison(candidate.comparison)
      ? { comparison: normalizeComparison(candidate.comparison)! }
      : {}),
  };
}

export function normalizeWorkspaceFileGitSource(value: unknown): WorkspaceFileGitSource | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case "uncommitted":
    case "unstaged":
    case "staged":
      return { kind: candidate.kind };
    case "branch":
      return typeof candidate.baseBranch === "string" && candidate.baseBranch
        ? { kind: "branch", baseBranch: candidate.baseBranch }
        : { kind: "branch" };
    case "commit":
      return typeof candidate.commitSha === "string" && candidate.commitSha
        ? {
            kind: "commit",
            commitSha: candidate.commitSha,
            ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
          }
        : null;
    default:
      return null;
  }
}

function normalizeComparison(value: unknown): WorkspaceFilesComparisonState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.path !== "string" || typeof candidate.visible !== "boolean") return null;
  return {
    path: candidate.path,
    visible: candidate.visible,
    source: normalizeWorkspaceFileGitSource(candidate.source),
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
