import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import {
  ChevronDownIcon,
  ContentSearchDiffIcon,
  UndoIcon,
  ReviewRefreshIcon,
} from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexTooltip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { reviewDiffPreferencesAtom } from "@/features/review/model/review-view-state";
import { useScopedAtomValue } from "@/lib/maitai";
import {
  NODEX_DIFF_HOST_CLASS,
  getNodexDiffHostStyle,
  getNodexDiffOptions,
} from "../../../../lib/diff-presentation";
import { getGitWorkerClient } from "../../../../lib/api";
import type { GitWorkerQueryClient } from "@/features/review/data/git-query";
import { useTheme } from "../../../../lib/use-theme";
import type {
  CodexTranscriptEntry,
  CodexTurnDiffReviewSource,
  GitApplyPatchResult,
} from "../../../../lib/types";
import type { ReviewOpenIntent } from "@/features/review/model/review-view-state";
import type { ProjectlessOutputScope } from "../../projection/projectless-output-scope";
import { cn } from "../../../../lib/utils";
import {
  TURN_DIFF_DEFAULT_VISIBLE_FILE_COUNT,
  buildTurnDiffApplyBatches,
  buildTurnDiffDisplayPath,
  buildTurnDiffModel,
  buildTurnDiffReviewIntent,
  buildTurnDiffRows,
  extractTurnDiffPayload,
  getTurnDiffDisclosureLabel,
  getTurnDiffTitle,
  getVisibleTurnDiffRows,
  isLargeTurnDiffFile,
  normalizeTurnDiffBasePath,
  parseUnifiedDiffFileStats,
  resolveTurnDiffReviewAffordance,
  summarizeTurnDiffRows,
  type TurnDiffRowModel,
  type TurnDiffModel,
  type TurnDiffSummary,
} from "./turn-diff-model";
import { DiffStats } from "./tools/diff-file-shared";
import { InlineFileDiff } from "./tools/inline-file-diff";

export type TurnDiffPatchAction = "undo" | "reapply";

export interface TurnDiffPatchFailure {
  action: TurnDiffPatchAction;
  result: GitApplyPatchResult;
}

export interface TurnDiffFileSidePanelTarget {
  cwd?: string | null;
  path: string;
  title: string;
  workspaceRoot?: string | null;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

const TURN_DIFF_PREVIEW_TOOLTIP_WIDTH =
  "clamp(0px, calc(var(--nodex-floating-surface-anchor-width, 0px) - 64px), var(--nodex-floating-surface-available-width, 100vw))";

const TURN_DIFF_PREVIEW_TOOLTIP_MAX_HEIGHT =
  "min(420px, var(--nodex-floating-surface-available-height, 420px), calc(100vh - 16px))";

const TURN_DIFF_PREVIEW_TOOLTIP_STYLE: CSSProperties = {
  width: TURN_DIFF_PREVIEW_TOOLTIP_WIDTH,
  maxWidth: TURN_DIFF_PREVIEW_TOOLTIP_WIDTH,
  maxHeight: TURN_DIFF_PREVIEW_TOOLTIP_MAX_HEIGHT,
};

function ReviewChangesIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="icon-2xs translate-y-[1px] text-token-input-placeholder-foreground transition-colors group-hover:text-token-foreground"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M14.3349 13.3301V6.60645L5.47065 15.4707C5.21095 15.7304 4.78895 15.7304 4.52925 15.4707C4.26955 15.211 4.26955 14.789 4.52925 14.5293L13.3935 5.66504H6.66011C6.29284 5.66504 5.99507 5.36727 5.99507 5C5.99507 4.63273 6.29284 4.33496 6.66011 4.33496H14.9999L15.1337 4.34863C15.4369 4.41057 15.665 4.67857 15.665 5V13.3301C15.6649 13.6973 15.3672 13.9951 14.9999 13.9951C14.6327 13.9951 14.335 13.6973 14.3349 13.3301Z"
        fill="currentColor"
      />
    </svg>
  );
}

function TurnDiffToolbarButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon?: "undo" | "reapply";
  disabled?: boolean;
  onClick: () => void;
}) {
  const Icon = icon === "undo" ? UndoIcon : icon === "reapply" ? ReviewRefreshIcon : null;

  return (
    <button
      type="button"
      className="text-size-chat inline-flex h-7 cursor-interaction items-center gap-1 rounded-md border border-token-border bg-token-main-surface-primary px-2 text-token-foreground transition-colors hover:bg-token-list-hover-background focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
    >
      {Icon ? <Icon className="icon-xs" /> : null}
      <span>{label}</span>
    </button>
  );
}

function TurnDiffPathLabel({ path }: { path: string }) {
  const slashIndex = path.lastIndexOf("/");
  const directory = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "";
  const base = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;

  return (
    <span className="flex min-w-0 flex-1 items-center">
      <span className="sr-only">{path}</span>
      <span className="flex min-w-0 flex-1 items-center" aria-hidden="true">
        {directory.length > 0 ? (
          <span className="min-w-0 truncate text-token-description-foreground">{directory}</span>
        ) : null}
        <span className="max-w-full shrink-0 truncate text-token-foreground">{base}</span>
      </span>
    </span>
  );
}

function TurnDiffPreview({
  row,
  diffHostClassName,
  diffHostStyle,
  diffOptions,
}: {
  row: TurnDiffRowModel;
  diffHostClassName: string;
  diffHostStyle: CSSProperties;
  diffOptions: ReturnType<typeof getNodexDiffOptions>;
}) {
  if (!row.fileDiff || row.isTooLarge) return null;

  return (
    <div className="border-token-border bg-token-dropdown-background pointer-events-auto flex min-h-0 max-h-full w-full flex-col overflow-hidden rounded-lg border shadow-xl focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none focus-visible:ring-inset">
      <div className="text-size-chat flex h-9 w-full shrink-0 items-center gap-2 border-b border-token-border bg-token-dropdown-background px-4 py-[var(--turn-diff-row-padding-y)] text-left extension:bg-token-input-background">
        <TurnDiffPathLabel path={row.displayPath} />
        <DiffStats
          additions={row.additions}
          deletions={row.deletions}
          className="ml-auto shrink-0 text-size-chat"
        />
      </div>
      <div className="max-h-96 min-h-0 flex-1 overflow-y-auto [contain:layout_paint]">
        <InlineFileDiff
          fileDiff={row.fileDiff}
          className={diffHostClassName}
          style={diffHostStyle}
          options={diffOptions}
          displayPath={row.displayPath}
        />
      </div>
    </div>
  );
}

function TurnDiffFileRow({
  row,
  onOpenReview,
  onOpenFileInSidePanel,
  disableHoverPreview,
  diffHostClassName,
  diffHostStyle,
  diffOptions,
  deferOffscreenRendering,
  workspaceRoot,
}: {
  row: TurnDiffRowModel;
  onOpenReview: (() => void) | null;
  onOpenFileInSidePanel?: (target: TurnDiffFileSidePanelTarget) => void | Promise<void>;
  disableHoverPreview?: boolean;
  diffHostClassName: string;
  diffHostStyle: CSSProperties;
  diffOptions: ReturnType<typeof getNodexDiffOptions>;
  deferOffscreenRendering: boolean;
  workspaceRoot: string | null;
}) {
  const canOpenFile = Boolean(row.openPath && onOpenFileInSidePanel);
  const canInteract = Boolean(onOpenReview || canOpenFile);
  const rowLabel = (
    <>
      <TurnDiffPathLabel path={row.displayPath} />
      {row.isTooLarge ? (
        <span className="text-token-description-foreground/80 shrink-0 max-[720px]:hidden">
          Too large to render inline
        </span>
      ) : null}
      <DiffStats
        additions={row.additions}
        deletions={row.deletions}
        className="ml-auto shrink-0 text-size-chat"
      />
    </>
  );
  const handleRowClick = (event: MouseEvent<HTMLButtonElement>) => {
    if ((event.metaKey || event.ctrlKey) && row.openPath && onOpenFileInSidePanel) {
      void onOpenFileInSidePanel({
        path: row.openPath,
        title: row.fileName,
        workspaceRoot,
        ...(row.openLine ? { line: row.openLine } : {}),
      });
      return;
    }
    if (onOpenReview) {
      onOpenReview();
      return;
    }
    if (row.openPath && onOpenFileInSidePanel) {
      void onOpenFileInSidePanel({
        path: row.openPath,
        title: row.fileName,
        workspaceRoot,
        ...(row.openLine ? { line: row.openLine } : {}),
      });
    }
  };
  const button = canInteract ? (
    <button
      type="button"
      className="text-size-chat flex h-9 w-full cursor-interaction items-center gap-2 bg-token-main-surface-primary/70 px-[var(--thread-resource-card-row-padding-x)] py-[var(--turn-diff-row-padding-y)] text-left hover:bg-token-list-hover-background/60 focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none focus-visible:ring-inset extension:bg-token-input-background/70 extension:hover:bg-token-list-hover-background/60"
      onClick={handleRowClick}
    >
      {rowLabel}
    </button>
  ) : (
    <div className="text-size-chat flex h-9 w-full items-center gap-2 bg-token-main-surface-primary/70 px-[var(--thread-resource-card-row-padding-x)] py-[var(--turn-diff-row-padding-y)] text-left extension:bg-token-input-background/70">
      {rowLabel}
    </div>
  );

  return (
    <div className={cn(deferOffscreenRendering && "thread-diff-virtualized")}>
      <NodexTooltip
        delay={800}
        disabled={disableHoverPreview || !row.fileDiff || row.isTooLarge}
        surface="rich"
        hoverable
        side="top"
        align="center"
        sideOffset={0}
        tooltipClassName="flex overflow-visible p-0"
        tooltipBodyClassName="h-full w-full"
        style={TURN_DIFF_PREVIEW_TOOLTIP_STYLE}
        tooltipContent={
          <TurnDiffPreview
            row={row}
            diffHostClassName={diffHostClassName}
            diffHostStyle={diffHostStyle}
            diffOptions={diffOptions}
          />
        }
      >
        {button}
      </NodexTooltip>
    </div>
  );
}

function TurnDiffDisclosureRow({
  expanded,
  fileCount,
  onToggle,
}: {
  expanded: boolean;
  fileCount: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="text-size-chat flex h-9 w-full cursor-interaction items-center px-[var(--thread-resource-card-row-padding-x)] py-[var(--turn-diff-row-padding-y)] text-left text-token-text-primary hover:bg-token-list-hover-background/30 focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none focus-visible:ring-inset"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span className="min-w-0 truncate">{getTurnDiffDisclosureLabel(fileCount, expanded)}</span>
      <ChevronDownIcon
        className={cn(
          "ml-auto icon-2xs text-token-description-foreground transition-transform duration-150",
          expanded && "rotate-180",
        )}
      />
    </button>
  );
}

function TurnDiffBanner({
  summary,
  onReview,
}: {
  summary: TurnDiffSummary;
  onReview: (() => void) | null;
}) {
  const summaryContent = (
    <>
      <span className="min-w-0 truncate">
        {summary.fileCount} {summary.fileCount === 1 ? "file" : "files"} changed
      </span>
      {summary.additions > 0 || summary.deletions > 0 ? (
        <>
          <span className="text-token-description-foreground/60" aria-hidden="true">
            •
          </span>
          <DiffStats
            additions={summary.additions}
            deletions={summary.deletions}
            className="text-size-chat-sm"
          />
        </>
      ) : null}
    </>
  );

  return (
    <div className="relative overflow-hidden" {...{ "codex.turn_diff.state": "in_progress" }}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
        className="text-size-chat flex min-w-0 items-center gap-1.5 px-3 py-1.5 text-token-description-foreground"
      >
        {onReview ? (
          <button
            type="button"
            aria-label="Review changed files"
            className="inline-flex min-w-0 cursor-interaction items-center gap-1.5 rounded-md focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none"
            onClick={onReview}
          >
            {summaryContent}
          </button>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md">
            {summaryContent}
          </span>
        )}
      </motion.div>
    </div>
  );
}

export function TurnDiffInProgressInlineSummary({
  item,
  rows,
  model,
  projectWorkspacePath,
  threadCwd,
  projectlessOutputDirectory,
  reviewSource = "last-turn",
  onOpenReview,
  showLeadingSeparator = false,
}: {
  item: CodexTranscriptEntry;
  rows?: readonly TurnDiffRowModel[];
  model?: TurnDiffModel;
  projectWorkspacePath?: string;
  threadCwd?: string;
  projectlessOutputDirectory?: string | null;
  reviewSource?: CodexTurnDiffReviewSource;
  onOpenReview?: (intent: ReviewOpenIntent) => void | Promise<void>;
  showLeadingSeparator?: boolean;
}) {
  const scope = useMemo<ProjectlessOutputScope>(
    () => ({ cwd: threadCwd, projectlessOutputDirectory }),
    [projectlessOutputDirectory, threadCwd],
  );
  const payload = extractTurnDiffPayload(item, scope);
  const resolvedModel = useMemo<TurnDiffModel>(
    () =>
      model ??
      (rows
        ? rows.length > 0
          ? { kind: "inline", rows, summary: summarizeTurnDiffRows(rows) }
          : { kind: "empty", rows: [], summary: { fileCount: 0, additions: 0, deletions: 0 } }
        : buildTurnDiffModel(item, threadCwd, projectWorkspacePath, scope)),
    [item, model, projectWorkspacePath, rows, scope, threadCwd],
  );
  const summary = resolvedModel.summary;
  const reviewIntent = useMemo(
    () =>
      buildTurnDiffReviewIntent({
        item,
        threadCwd,
        projectWorkspacePath,
        source: reviewSource,
        scope,
      }),
    [item, projectWorkspacePath, reviewSource, scope, threadCwd],
  );
  const reviewAffordance = resolveTurnDiffReviewAffordance({
    intent: reviewIntent,
    reviewRouteAvailable: typeof onOpenReview === "function",
  });

  if (!payload || resolvedModel.kind === "empty" || summary.fileCount === 0) return null;

  const handleOpenReview =
    onOpenReview && reviewAffordance.kind === "available"
      ? () => {
          void onOpenReview(reviewAffordance.intent);
        }
      : undefined;

  return (
    <div {...{ "codex.turn_diff.state": "in_progress" }}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
        className="flex min-w-0 items-center gap-2"
      >
        {showLeadingSeparator ? (
          <span aria-hidden="true" className="text-token-text-secondary">
            ·
          </span>
        ) : null}
        {handleOpenReview ? (
          <button
            type="button"
            aria-label="Review changed files"
            className="text-size-chat flex min-w-0 cursor-interaction items-center gap-1 rounded-sm text-token-text-secondary hover:text-token-foreground focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none"
            onClick={handleOpenReview}
          >
            <span className="block min-w-0 truncate">
              {summary.fileCount} {summary.fileCount === 1 ? "file" : "files"} changed
            </span>
            <DiffStats
              additions={summary.additions}
              deletions={summary.deletions}
              className="text-size-chat-sm"
            />
          </button>
        ) : (
          <span className="text-size-chat flex min-w-0 items-center gap-1 text-token-text-secondary">
            <span className="block min-w-0 truncate">
              {summary.fileCount} {summary.fileCount === 1 ? "file" : "files"} changed
            </span>
            <DiffStats
              additions={summary.additions}
              deletions={summary.deletions}
              className="text-size-chat-sm"
            />
          </span>
        )}
      </motion.div>
    </div>
  );
}

export function TurnDiffPatchFailureDialog({
  failure,
  onClose,
}: {
  failure: TurnDiffPatchFailure | null;
  onClose: () => void;
}) {
  if (failure === null) return null;

  const result = failure?.result ?? null;
  const action = failure?.action ?? "undo";
  const isUndo = action === "undo";
  const notGitRepo = result?.errorCode === "notGitRepo";
  const appliedCount = result?.appliedPaths.length ?? 0;
  const skippedCount = result?.skippedPaths.length ?? 0;
  const conflictedCount = result?.conflictedPaths.length ?? 0;

  const title = notGitRepo
    ? isUndo
      ? "Undo requires a Git repository"
      : "Reapply requires a Git repository"
    : result?.status === "partial-success"
      ? isUndo
        ? "Some changes reverted"
        : "Some changes reapplied"
      : appliedCount === 0 && skippedCount === 0 && conflictedCount === 0
        ? isUndo
          ? "No changes reverted"
          : "No changes reapplied"
        : isUndo
          ? "Failed to revert changes"
          : "Failed to reapply changes";
  const description = notGitRepo
    ? "This action only works when running in a Git repository."
    : `There were issues ${isUndo ? "reverting" : "reapplying"} some files.`;

  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="wide" showCloseButton={false}>
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>{title}</NodexDialogTitle>
            <NodexDialogDescription>{description}</NodexDialogDescription>
          </NodexDialogHeader>
          {result ? (
            <NodexDialogBody>
              <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto text-sm">
                {result.errorMessage ? (
                  <div className="rounded-lg border border-token-border bg-token-main-surface-primary p-3 text-token-description-foreground">
                    Git apply error: {result.errorMessage}
                  </div>
                ) : null}
                <PatchPathGroup
                  title={`Applied cleanly (${appliedCount})`}
                  paths={result.appliedPaths}
                />
                <PatchPathGroup title={`Skipped (${skippedCount})`} paths={result.skippedPaths} />
                <PatchPathGroup
                  title={`Conflicts (${conflictedCount})`}
                  paths={result.conflictedPaths}
                />
              </div>
            </NodexDialogBody>
          ) : null}
          <NodexDialogFooter>
            <NodexDialogAction tone="primary" onClick={onClose}>
              Close
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function PatchPathGroup({ title, paths }: { title: string; paths: string[] }) {
  if (paths.length === 0) return null;

  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-token-description-foreground">{title}</h3>
      <ul className="rounded-lg border border-token-border bg-token-main-surface-primary">
        {paths.map((path) => (
          <li key={path} className="border-b border-token-border px-3 py-2 last:border-b-0">
            <code className="text-xs text-token-foreground">{path}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TurnDiffSurface({
  item,
  isInProgress,
  projectWorkspacePath,
  threadCwd,
  projectlessOutputDirectory,
  reviewSource = "last-turn",
  onOpenReview,
  onOpenFileInSidePanel,
  disableHoverPreview = false,
  deferOffscreenRendering = false,
  gitWorkerClient = getGitWorkerClient(),
}: {
  item: CodexTranscriptEntry;
  isInProgress: boolean;
  projectWorkspacePath?: string;
  threadCwd?: string;
  projectlessOutputDirectory?: string | null;
  reviewSource?: CodexTurnDiffReviewSource;
  onOpenReview?: (intent: ReviewOpenIntent) => void | Promise<void>;
  onOpenFileInSidePanel?: (target: TurnDiffFileSidePanelTarget) => void | Promise<void>;
  disableHoverPreview?: boolean;
  deferOffscreenRendering?: boolean;
  gitWorkerClient?: Pick<GitWorkerQueryClient, "request">;
}) {
  const scope = useMemo<ProjectlessOutputScope>(
    () => ({ cwd: threadCwd, projectlessOutputDirectory }),
    [projectlessOutputDirectory, threadCwd],
  );
  const payload = extractTurnDiffPayload(item, scope);
  const model = useMemo(
    () => buildTurnDiffModel(item, threadCwd, projectWorkspacePath, scope),
    [item, projectWorkspacePath, scope, threadCwd],
  );
  const rows = model.rows;
  const summary = model.summary;
  const reviewIntent = useMemo(
    () =>
      buildTurnDiffReviewIntent({
        item,
        threadCwd,
        projectWorkspacePath,
        source: reviewSource,
        scope,
      }),
    [item, projectWorkspacePath, reviewSource, scope, threadCwd],
  );
  const reviewAffordance = resolveTurnDiffReviewAffordance({
    intent: reviewIntent,
    reviewRouteAvailable: typeof onOpenReview === "function",
  });
  const basePath = useMemo(
    () => normalizeTurnDiffBasePath(payload, threadCwd, projectWorkspacePath),
    [payload, projectWorkspacePath, threadCwd],
  );
  const applyBatches = useMemo(
    () => buildTurnDiffApplyBatches(payload, basePath),
    [basePath, payload],
  );
  const { resolved } = useTheme();
  const { wrap } = useScopedAtomValue(reviewDiffPreferencesAtom);
  const diffOptions = useMemo(
    () => getNodexDiffOptions(resolved, true, { wrap }),
    [resolved, wrap],
  );
  const diffHostStyle = useMemo(() => getNodexDiffHostStyle(resolved), [resolved]);
  const diffHostClassName = NODEX_DIFF_HOST_CLASS;
  const [expanded, setExpanded] = useState(false);
  const [lastPatchAction, setLastPatchAction] = useState<{
    action: TurnDiffPatchAction;
    unifiedDiff: string;
  } | null>(null);
  const [patchActionInFlight, setPatchActionInFlight] = useState(false);
  const [failure, setFailure] = useState<TurnDiffPatchFailure | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpanded(false);
    setLastPatchAction(null);
    setPatchActionInFlight(false);
    setFailure(null);
  }, [item.entryId, item.itemId, payload?.unifiedDiff]);

  if (!payload || model.kind === "empty" || summary.fileCount === 0) return null;

  const nextPatchAction: TurnDiffPatchAction =
    lastPatchAction?.unifiedDiff === payload.unifiedDiff && lastPatchAction.action === "undo"
      ? "reapply"
      : "undo";

  const handleOpenReview =
    onOpenReview && reviewAffordance.kind === "available"
      ? (path?: TurnDiffRowModel["reviewPath"] | null) => {
          void onOpenReview({
            ...reviewAffordance.intent,
            ...(path ? { targetPath: path } : {}),
          });
        }
      : null;

  const handleToggleExpanded = () => {
    const previousTop = rootRef.current?.getBoundingClientRect().top ?? null;
    setExpanded((current) => !current);
    if (previousTop === null) return;
    requestAnimationFrame(() => {
      const nextTop = rootRef.current?.getBoundingClientRect().top ?? null;
      if (nextTop === null) return;
      if (typeof window.scrollBy !== "function") return;
      window.scrollBy({ top: nextTop - previousTop, behavior: "auto" });
    });
  };

  const handlePatchAction = async () => {
    if (patchActionInFlight || applyBatches.length === 0) return;

    const orderedBatches = nextPatchAction === "undo" ? [...applyBatches].reverse() : applyBatches;
    setPatchActionInFlight(true);
    try {
      for (const batch of orderedBatches) {
        const result = await gitWorkerClient.request({
          method: "apply-patch",
          params: {
            cwd: batch.cwd,
            diff: batch.diff,
            target: "unstaged",
            revert: nextPatchAction === "undo",
            operationSource: "thread_diff",
          },
        });

        if (result.status !== "success") {
          setFailure({ action: nextPatchAction, result });
          return;
        }
      }

      setLastPatchAction({ action: nextPatchAction, unifiedDiff: payload.unifiedDiff });
      toast.success(nextPatchAction === "undo" ? "Changes reverted" : "Changes reapplied", {
        id: "turn-diff-notice",
      });
    } catch (error) {
      setFailure({
        action: nextPatchAction,
        result: {
          status: "error",
          appliedPaths: [],
          skippedPaths: [],
          conflictedPaths: [],
          errorCode: null,
          errorMessage: error instanceof Error ? error.message : "Could not apply patch.",
        },
      });
    } finally {
      setPatchActionInFlight(false);
    }
  };

  if (isInProgress) {
    if (!handleOpenReview) return null;
    return (
      <TurnDiffBanner
        summary={summary}
        onReview={handleOpenReview ? () => handleOpenReview() : null}
      />
    );
  }

  const visibleRows = model.kind === "inline" ? getVisibleTurnDiffRows(rows, expanded) : [];
  const shouldShowFileList = model.kind === "inline" && summary.fileCount > 1;

  return (
    <>
      <div
        ref={rootRef}
        className="mb-2 flex max-w-full flex-col overflow-hidden rounded-lg bg-token-dropdown-background/50 text-base text-token-foreground electron:elevation-stroke extension:border extension:border-token-border extension:bg-token-input-background/50 extension:shadow-sm [--thread-resource-card-row-padding-x:0.75rem] [--turn-diff-row-padding-y:0.25rem]"
      >
        <div className="group/turn-diff-header relative focus-within:[&_.turn-diff-default-subtitle]:hidden hover:[&_.turn-diff-default-subtitle]:hidden focus-within:[&_.turn-diff-hover-subtitle]:inline-flex hover:[&_.turn-diff-hover-subtitle]:inline-flex">
          {handleOpenReview ? (
            <button
              type="button"
              aria-label="Review changed files"
              className="absolute inset-0 cursor-interaction bg-transparent group-hover/turn-diff-header:bg-token-list-hover-background/30 focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none focus-visible:ring-inset"
              onClick={() => handleOpenReview()}
            />
          ) : null}
          <div className="relative z-10 flex w-full min-w-0 items-center gap-3 px-[var(--thread-resource-card-row-padding-x)] py-1.5 pointer-events-none">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-token-bg-secondary text-token-text-secondary">
              <ContentSearchDiffIcon className="icon-sm" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-center">
              <div className="text-size-chat min-w-0 truncate text-token-text-primary">
                {getTurnDiffTitle(
                  summary,
                  model.kind === "inline" ? (rows[0]?.displayPath ?? null) : null,
                )}
              </div>
              <div className="text-size-chat-sm min-h-5 min-w-0 text-token-description-foreground">
                <span className="turn-diff-default-subtitle inline-flex min-w-0 items-center">
                  {model.kind === "tooLarge" ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span>Too large for inline preview</span>
                      <DiffStats
                        additions={summary.additions}
                        deletions={summary.deletions}
                        className="text-size-chat-sm"
                      />
                    </span>
                  ) : (
                    <DiffStats
                      additions={summary.additions}
                      deletions={summary.deletions}
                      className="text-size-chat-sm"
                    />
                  )}
                </span>
                {handleOpenReview ? (
                  <span className="turn-diff-hover-subtitle hidden min-w-0 items-center gap-1 text-token-description-foreground">
                    <span>Review changes</span>
                    <ReviewChangesIcon />
                  </span>
                ) : null}
              </div>
            </div>
            <div className="pointer-events-auto ml-auto flex shrink-0 items-center gap-2">
              {model.kind === "inline" && payload.showRevertButton && applyBatches.length > 0 ? (
                <TurnDiffToolbarButton
                  label={nextPatchAction === "undo" ? "Undo" : "Reapply"}
                  icon={nextPatchAction}
                  disabled={patchActionInFlight}
                  onClick={() => {
                    void handlePatchAction();
                  }}
                />
              ) : null}
              {handleOpenReview ? (
                <TurnDiffToolbarButton
                  label="Review"
                  disabled={patchActionInFlight}
                  onClick={() => handleOpenReview()}
                />
              ) : null}
            </div>
          </div>
        </div>
        {shouldShowFileList ? (
          <div className="flex flex-col border-t border-token-border [--codex-diffs-header-padding-x:var(--thread-resource-card-row-padding-x)] [--codex-diffs-header-padding-y:var(--turn-diff-row-padding-y)] [--codex-diffs-surface-override:color-mix(in_oklab,var(--color-token-dropdown-background)_50%,transparent)] extension:[--codex-diffs-surface-override:color-mix(in_oklab,var(--color-token-input-background)_50%,transparent)]">
            {visibleRows.map((row) => (
              <TurnDiffFileRow
                key={row.key}
                row={row}
                onOpenReview={handleOpenReview ? () => handleOpenReview(row.reviewPath) : null}
                onOpenFileInSidePanel={onOpenFileInSidePanel}
                disableHoverPreview={disableHoverPreview}
                diffHostClassName={diffHostClassName}
                diffHostStyle={diffHostStyle}
                diffOptions={diffOptions}
                deferOffscreenRendering={deferOffscreenRendering}
                workspaceRoot={basePath}
              />
            ))}
            {summary.fileCount > TURN_DIFF_DEFAULT_VISIBLE_FILE_COUNT ? (
              <TurnDiffDisclosureRow
                expanded={expanded}
                fileCount={summary.fileCount}
                onToggle={handleToggleExpanded}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <TurnDiffPatchFailureDialog failure={failure} onClose={() => setFailure(null)} />
    </>
  );
}

export const turnDiffSurfaceTestHelpers = {
  buildTurnDiffApplyBatches,
  buildTurnDiffDisplayPath,
  buildTurnDiffModel,
  buildTurnDiffReviewIntent,
  buildTurnDiffRows,
  extractTurnDiffPayload,
  getTurnDiffDisclosureLabel,
  getTurnDiffTitle,
  isLargeTurnDiffFile,
  parseUnifiedDiffFileStats,
  summarizeTurnDiffRows,
};
