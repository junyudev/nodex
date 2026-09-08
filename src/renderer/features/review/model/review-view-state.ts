import type { CodexTurnDiffPatchBatch, GitReviewSource } from "@/lib/types";
import { appScope, scopedAtom, scopedWritableAtom } from "@/lib/maitai";
import { RouteScope } from "@/lib/workbench-ui-scopes";
import type { ReviewDiffExpansionState } from "./review-diff-expansion";

export type ReviewSource = "last-turn" | "selected-turn" | GitReviewSource;
export type ReviewDiffMode = "unified" | "split";

export type CanonicalReviewPath = string & {
  readonly __canonicalReviewPath: unique symbol;
};

export interface ReviewSelectedTurnIdentity {
  readonly threadId: string;
  readonly turnId: string;
  readonly entryId: string;
}

export interface ResolvedTurnDiffReview extends ReviewSelectedTurnIdentity {
  readonly patch: string;
  readonly cwd: string | null;
  readonly showRevertButton: boolean;
  readonly patchBatches?: readonly CodexTurnDiffPatchBatch[];
}

export type ReviewSourceIntent =
  | { readonly kind: "last-turn"; readonly threadId: string }
  | ({ readonly kind: "selected-turn" } & ReviewSelectedTurnIdentity)
  | { readonly kind: "git"; readonly mode: "unstaged" | "staged" }
  | { readonly kind: "git"; readonly mode: "branch"; readonly baseRef: string }
  | { readonly kind: "commit"; readonly sha: string };

export interface ReviewOpenIntent {
  readonly source: ReviewSourceIntent;
  readonly targetPath?: CanonicalReviewPath;
}

export interface PendingReviewReveal {
  readonly requestId: number;
  readonly targetPath: CanonicalReviewPath;
}

export interface ReviewDiffPreferences {
  readonly diffMode: ReviewDiffMode;
  readonly hideWhitespace: boolean;
  readonly wrap: boolean;
  readonly wordDiffsEnabled: boolean;
  readonly richPreviewEnabled: boolean;
  readonly loadFullFilesEnabled: boolean;
}

export interface ReviewRouteState extends ReviewDiffExpansionState {
  readonly initialized: boolean;
  readonly source: ReviewSource;
  readonly transcriptThreadId: string | null;
  readonly selectedTurn: ReviewSelectedTurnIdentity | null;
  readonly commitSha: string | null;
  readonly branchBaseRef: string | null;
  readonly selectedPath: CanonicalReviewPath | null;
  readonly fileTreeOpen: boolean;
  readonly fileTreeWidth: number;
  readonly fileFilter: string;
  readonly filterGeneratedFiles: boolean;
  readonly expandedDirectoryPaths: readonly string[];
  readonly treeExpansionSourceKey: string | null;
  readonly nextRevealRequestId: number;
  readonly pendingReveal: PendingReviewReveal | null;
}

export interface ReviewRouteInitializer {
  readonly source?: ReviewSource;
  readonly commitSha?: string | null;
  readonly fileTreeOpen?: boolean;
}

export const REVIEW_FILE_TREE_DEFAULT_WIDTH_PX = 280;

export const reviewDiffPreferencesAtom = scopedAtom<ReviewDiffPreferences>(
  appScope,
  {
    diffMode: "unified",
    hideWhitespace: false,
    wrap: false,
    wordDiffsEnabled: true,
    richPreviewEnabled: false,
    loadFullFilesEnabled: true,
  },
  { debugLabel: "review-diff-preferences" },
);

export const reviewRouteStateAtom = scopedAtom<ReviewRouteState>(
  RouteScope,
  {
    initialized: false,
    source: "last-turn",
    transcriptThreadId: null,
    selectedTurn: null,
    commitSha: null,
    branchBaseRef: null,
    selectedPath: null,
    fileTreeOpen: false,
    fileTreeWidth: REVIEW_FILE_TREE_DEFAULT_WIDTH_PX,
    fileFilter: "",
    filterGeneratedFiles: false,
    expandedDirectoryPaths: [],
    treeExpansionSourceKey: null,
    allDiffsExpanded: true,
    diffExpansionOverrides: [],
    diffExpansionSourceKey: null,
    nextRevealRequestId: 0,
    pendingReveal: null,
  },
  { debugLabel: "review-route-state" },
);

export const initializeReviewRouteStateAtom = scopedWritableAtom<
  ReviewRouteState,
  [ReviewRouteInitializer],
  void
>(
  RouteScope,
  (get) => get(reviewRouteStateAtom),
  (get, set, initializer) => {
    const current = get(reviewRouteStateAtom);
    if (current.initialized) return;
    const commitSha = initializer.commitSha?.trim() || null;
    set(reviewRouteStateAtom, {
      ...current,
      initialized: true,
      source:
        initializer.source === "commit" && !commitSha
          ? "branch"
          : (initializer.source ?? current.source),
      commitSha,
      fileTreeOpen: initializer.fileTreeOpen ?? current.fileTreeOpen,
    });
  },
  { debugLabel: "initialize-review-route-state" },
);

export const prepareReviewOpenAtom = scopedWritableAtom<
  ReviewRouteState,
  [ReviewOpenIntent],
  number
>(
  RouteScope,
  (get) => get(reviewRouteStateAtom),
  (get, set, intent) => {
    const current = get(reviewRouteStateAtom);
    const requestId = current.nextRevealRequestId + 1;
    const sourceState = resolveReviewSourceIntent(intent.source);
    set(reviewRouteStateAtom, {
      ...current,
      ...sourceState,
      initialized: true,
      nextRevealRequestId: requestId,
      selectedPath: intent.targetPath ?? current.selectedPath,
      pendingReveal: intent.targetPath ? { requestId, targetPath: intent.targetPath } : null,
    });
    return requestId;
  },
  { debugLabel: "prepare-review-open" },
);

export const acknowledgeReviewRevealAtom = scopedWritableAtom<ReviewRouteState, [number], void>(
  RouteScope,
  (get) => get(reviewRouteStateAtom),
  (get, set, requestId) => {
    const current = get(reviewRouteStateAtom);
    if (current.pendingReveal?.requestId !== requestId) return;
    set(reviewRouteStateAtom, { ...current, pendingReveal: null });
  },
  { debugLabel: "acknowledge-review-reveal" },
);

function resolveReviewSourceIntent(
  source: ReviewSourceIntent,
): Pick<
  ReviewRouteState,
  "source" | "transcriptThreadId" | "selectedTurn" | "commitSha" | "branchBaseRef"
> {
  if (source.kind === "last-turn") {
    return {
      source: "last-turn",
      transcriptThreadId: source.threadId,
      selectedTurn: null,
      commitSha: null,
      branchBaseRef: null,
    };
  }
  if (source.kind === "selected-turn") {
    return {
      source: "selected-turn",
      transcriptThreadId: source.threadId,
      selectedTurn: {
        threadId: source.threadId,
        turnId: source.turnId,
        entryId: source.entryId,
      },
      commitSha: null,
      branchBaseRef: null,
    };
  }
  if (source.kind === "commit") {
    return {
      source: "commit",
      transcriptThreadId: null,
      selectedTurn: null,
      commitSha: source.sha.trim() || null,
      branchBaseRef: null,
    };
  }
  if (source.mode === "branch") {
    return {
      source: "branch",
      transcriptThreadId: null,
      selectedTurn: null,
      commitSha: null,
      branchBaseRef: source.baseRef.trim() || null,
    };
  }
  return {
    source: source.mode,
    transcriptThreadId: null,
    selectedTurn: null,
    commitSha: null,
    branchBaseRef: null,
  };
}
