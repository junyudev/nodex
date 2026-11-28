import { FormattedMessage, useIntl } from "@/lib/i18n";
import { parsePatchFiles } from "@pierre/diffs";
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  FileDiffProps,
  SelectedLineRange,
} from "@pierre/diffs/react";
import { useMemo, useRef, useState } from "react";
import {
  ChevronRightIcon,
  PanelRightHiddenIcon,
  PanelRightVisibleIcon,
  ReviewCollapseAllDiffsIcon,
  ReviewExpandAllDiffsIcon,
} from "@/components/shared/icons";
import { NodexIconButton } from "@/components/ui/button";
import { LoadingResultsShimmer } from "@/components/ui/loading-results-shimmer";
import { NodexTooltip } from "@/components/ui/tooltip";
import { ReadOnlyFileDiff } from "@/components/ui/read-only-file-diff";
import { ReviewFileTree } from "@/features/review/view/review-file-tree";
import { reviewDiffPreferencesAtom } from "@/features/review/model/review-view-state";
import {
  getNodexDiffHostStyle,
  getNodexDiffOptions,
  NODEX_DIFF_HOST_CLASS,
} from "@/lib/diff-presentation";
import { buildFileTreeAncestorPaths } from "@/lib/file-tree-paths";
import { useScopedAtomValue } from "@/lib/maitai";
import { normalizeReviewDiffRange, type ReviewDiffDraft } from "@/lib/review-diff-annotations";
import type { GitReviewFileStatus, ReviewDiffAnnotationSide } from "@/lib/types";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";
import type {
  GitHubDiffSide,
  GitHubPullRequestDetail,
  GitHubPullRequestFile,
  GitHubPullRequestFileStatus,
  GitHubReviewThread,
} from "../../../shared/github-thread";
import { GitHubMarkdownEditor } from "./github-thread-editor";
import {
  gitHubThreadsByPath,
  isOpenGitHubThread,
  type GitHubChatContextSubject,
} from "./github-thread-model";
import { useOpenOnGitHub } from "./github-thread-parts";
import { useGitHubFileTreeOpen } from "./github-thread-preferences";
import { GitHubReviewThreadCard } from "./github-thread-review-thread";
import type { GitHubThreadCommandRunner } from "./github-thread-surface-types";
import { useGitHubPullRequestFiles } from "./use-github-thread";

/** Files changing more lines than this start folded, so one generated file does not bury the rest. */
const LARGE_FILE_LINES = 400;
/** Past this many changed lines in all, only the first files start open. */
const LARGE_CHANGE_LINES = 2000;
const OPEN_FILES_IN_LARGE_CHANGE = 5;

type AddToChat = ((subject: GitHubChatContextSubject) => void) | null;

function changedLines(file: GitHubPullRequestFile) {
  return file.additions + file.deletions;
}

/**
 * Which files start open: all of a small change, the first few of a large one, never a huge
 * file, and never one the viewer already marked viewed.
 */
export function initiallyOpenFiles(files: readonly GitHubPullRequestFile[]): ReadonlySet<string> {
  const total = files.reduce((sum, file) => sum + changedLines(file), 0);
  const candidates = files.filter(
    (file) =>
      file.patch !== null && file.viewed !== "viewed" && changedLines(file) <= LARGE_FILE_LINES,
  );
  const open =
    total > LARGE_CHANGE_LINES ? candidates.slice(0, OPEN_FILES_IN_LARGE_CHANGE) : candidates;
  return new Set(open.map((file) => file.path));
}

function fileDiffMetadata(file: GitHubPullRequestFile): FileDiffMetadata | null {
  if (file.patch === null) return null;
  const before = file.status === "added" ? "/dev/null" : `a/${file.previousPath ?? file.path}`;
  const after = file.status === "removed" ? "/dev/null" : `b/${file.path}`;
  const header = `diff --git a/${file.previousPath ?? file.path} b/${file.path}\n--- ${before}\n+++ ${after}\n`;
  try {
    return parsePatchFiles(`${header}${file.patch}\n`, `github:${file.path}`)[0]?.files[0] ?? null;
  } catch {
    return null;
  }
}

const STATUS_MARK: Record<
  GitHubPullRequestFileStatus,
  { readonly mark: string; readonly tone: string; readonly tree: GitReviewFileStatus }
> = {
  added: { mark: "A", tone: "text-token-git-decoration-added-resource-foreground", tree: "added" },
  removed: {
    mark: "D",
    tone: "text-token-git-decoration-deleted-resource-foreground",
    tree: "deleted",
  },
  modified: { mark: "M", tone: "text-token-description-foreground", tree: "modified" },
  changed: { mark: "M", tone: "text-token-description-foreground", tree: "modified" },
  renamed: { mark: "R", tone: "text-token-description-foreground", tree: "renamed" },
  copied: { mark: "C", tone: "text-token-description-foreground", tree: "copied" },
  unchanged: { mark: "·", tone: "text-token-description-foreground", tree: "modified" },
};

const annotationSide = (side: GitHubDiffSide): ReviewDiffAnnotationSide =>
  side === "left" ? "deletions" : "additions";
const gitHubSide = (side: ReviewDiffAnnotationSide): GitHubDiffSide =>
  side === "deletions" ? "left" : "right";

/**
 * The change itself: every file the pull request touches, as diffs with their conversations at
 * the lines they discuss, beside a tree of the files. Viewed marks are the viewer's own on
 * GitHub, and a viewed file folds away.
 */
export function GitHubPullRequestFilesView({
  pr,
  run,
  onAddToChat,
}: {
  readonly pr: GitHubPullRequestDetail;
  readonly run: GitHubThreadCommandRunner;
  readonly onAddToChat: AddToChat;
}) {
  const intl = useIntl();
  const openOnGitHub = useOpenOnGitHub();
  const query = useGitHubPullRequestFiles(pr.ref, pr.headSha);
  const result = query.data;
  const files = result?.status === "ready" ? result.files.files : null;
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string> | null>(null);
  const [viewedOverrides, setViewedOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const [treeOpen, setTreeOpen] = useGitHubFileTreeOpen();
  const [treeFilter, setTreeFilter] = useState("");
  const [treeExpanded, setTreeExpanded] = useState<readonly string[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const filesUrl = `${pr.url}/files`;
  const threadsByPath = useMemo(() => gitHubThreadsByPath(pr.reviewThreads), [pr.reviewThreads]);

  if (!result) {
    return (
      <div className="pt-20" role="status" aria-busy="true">
        <LoadingResultsShimmer
          lines={6}
          maxWidth={96}
          minWidth={60}
          seed={`github-files:${pr.url}`}
          size="md"
        />
      </div>
    );
  }
  if (result.status !== "ready" || !files) {
    return (
      <div className="flex flex-col items-start gap-2 pt-20 text-sm">
        <span className="text-token-text-secondary">
          <FormattedMessage
            id="githubThread.files.unavailable"
            defaultMessage="Couldn’t load the changed files"
          />
        </span>
        <div className="flex gap-3">
          <button
            type="button"
            className="cursor-interaction text-token-text-primary hover:underline"
            onClick={() => void query.refetch()}
          >
            <FormattedMessage id="githubThread.retry" defaultMessage="Try again" />
          </button>
          <a
            href={filesUrl}
            onClick={(event) => openOnGitHub(filesUrl, event)}
            className="text-token-description-foreground hover:underline"
          >
            <FormattedMessage id="githubThread.openOnGitHub" defaultMessage="Open on GitHub" />
          </a>
        </div>
      </div>
    );
  }

  const open = openPaths ?? initiallyOpenFiles(files);
  const setOpen = (path: string, value: boolean) => {
    const next = new Set(open);
    if (value) next.add(path);
    else next.delete(path);
    setOpenPaths(next);
  };
  const allOpen = files.every((file) => file.patch === null || open.has(file.path));
  const isViewed = (file: GitHubPullRequestFile) =>
    viewedOverrides.get(file.path) ?? file.viewed === "viewed";
  const viewedCount = files.filter(isViewed).length;

  const setViewed = (file: GitHubPullRequestFile, viewed: boolean) => {
    setViewedOverrides((current) => new Map(current).set(file.path, viewed));
    // Marking a file viewed puts it away; unmarking brings it back.
    setOpen(file.path, !viewed && file.patch !== null);
    void run.run({ type: "set_file_viewed", path: file.path, viewed }).then(() =>
      setViewedOverrides((current) => {
        const next = new Map(current);
        next.delete(file.path);
        return next;
      }),
    );
  };

  const reveal = (path: string) => {
    setSelectedPath(path);
    setOpen(path, true);
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLElement>(`[data-github-file="${CSS.escape(path)}"]`)
        ?.scrollIntoView({ block: "start" }),
    );
  };

  const treeEntries = files.map((file) => ({
    key: file.path,
    displayPath: file.path,
    openPath: null,
    gitStatus: STATUS_MARK[file.status].tree,
  }));
  const commentCounts = new Map(
    [...threadsByPath].map(([path, threads]) => [path, threads.filter(isOpenGitHubThread).length]),
  );
  const canComment = pr.state === "open" && pr.viewer.canComment;

  return (
    <div className="@container pt-14 pb-10" data-github-thread-files="">
      <div className="flex h-8 items-center gap-2 text-sm text-token-text-secondary">
        <FormattedMessage
          id="githubThread.files.summary"
          defaultMessage="{count, plural, one {# file changed} other {# files changed}}"
          values={{ count: pr.changedFiles }}
        />
        <span className="tabular-nums text-token-git-decoration-added-resource-foreground">
          +{pr.additions}
        </span>
        <span className="tabular-nums text-token-git-decoration-deleted-resource-foreground">
          −{pr.deletions}
        </span>
        <span className="ml-auto text-xs tabular-nums text-token-description-foreground">
          <FormattedMessage
            id="githubThread.files.viewedCount"
            defaultMessage="{viewed} of {count} viewed"
            values={{ viewed: viewedCount, count: files.length }}
          />
        </span>
        <NodexIconButton
          size="sm"
          icon={allOpen ? ReviewCollapseAllDiffsIcon : ReviewExpandAllDiffsIcon}
          ariaLabel={
            allOpen
              ? intl.formatMessage({
                  id: "githubThread.files.collapseAll",
                  defaultMessage: "Collapse all files",
                })
              : intl.formatMessage({
                  id: "githubThread.files.expandAll",
                  defaultMessage: "Expand all files",
                })
          }
          onClick={() =>
            setOpenPaths(
              allOpen
                ? new Set()
                : new Set(files.filter((file) => file.patch !== null).map((file) => file.path)),
            )
          }
        />
        <NodexIconButton
          size="sm"
          className="hidden @min-[56rem]:inline-flex"
          icon={treeOpen ? PanelRightVisibleIcon : PanelRightHiddenIcon}
          active={treeOpen}
          ariaLabel={
            treeOpen
              ? intl.formatMessage({
                  id: "githubThread.files.hideTree",
                  defaultMessage: "Hide file tree",
                })
              : intl.formatMessage({
                  id: "githubThread.files.showTree",
                  defaultMessage: "Show file tree",
                })
          }
          onClick={() => setTreeOpen(!treeOpen)}
        />
      </div>
      <div
        className={cn(
          "mt-2 grid grid-cols-[minmax(0,1fr)] gap-4",
          treeOpen && "@min-[56rem]:grid-cols-[minmax(0,1fr)_18rem]",
        )}
      >
        <div ref={listRef} className="flex min-w-0 flex-col gap-2">
          {files.map((file) => (
            <FileCard
              key={file.path}
              file={file}
              pr={pr}
              run={run}
              open={open.has(file.path)}
              onOpenChange={(value) => setOpen(file.path, value)}
              viewed={isViewed(file)}
              onViewedChange={(value) => setViewed(file, value)}
              threads={threadsByPath.get(file.path) ?? []}
              canComment={canComment}
              filesUrl={filesUrl}
              onAddToChat={onAddToChat}
            />
          ))}
          {result.files.truncated ? (
            <a
              href={filesUrl}
              onClick={(event) => openOnGitHub(filesUrl, event)}
              className="self-start py-1 text-sm text-token-description-foreground hover:text-token-text-primary hover:underline"
            >
              <FormattedMessage
                id="githubThread.files.truncated"
                defaultMessage="{shown} of {count} files shown. The rest are on GitHub."
                values={{ shown: files.length, count: pr.changedFiles }}
              />
            </a>
          ) : null}
        </div>
        {treeOpen ? (
          <aside
            aria-label={intl.formatMessage({
              id: "githubThread.files.tree",
              defaultMessage: "Changed files",
            })}
            className="sticky top-14 hidden h-[calc(100vh-9rem)] min-h-64 overflow-hidden rounded-lg ring-[0.5px] ring-token-border ring-inset @min-[56rem]:flex @min-[56rem]:flex-col"
          >
            <ReviewFileTree
              entries={treeEntries}
              selectedPath={selectedPath}
              expandedPaths={
                treeExpanded ?? buildFileTreeAncestorPaths(files.map((file) => file.path))
              }
              filter={treeFilter}
              commentCountByPath={commentCounts}
              onFilterChange={setTreeFilter}
              onSelectPath={reveal}
              onExpandedPathsChange={setTreeExpanded}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

interface GitHubDiffAnnotation {
  readonly kind: "thread" | "draft";
  readonly key: string;
}

function FileCard({
  file,
  pr,
  run,
  open,
  onOpenChange,
  viewed,
  onViewedChange,
  threads,
  canComment,
  filesUrl,
  onAddToChat,
}: {
  readonly file: GitHubPullRequestFile;
  readonly pr: GitHubPullRequestDetail;
  readonly run: GitHubThreadCommandRunner;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly viewed: boolean;
  readonly onViewedChange: (viewed: boolean) => void;
  readonly threads: readonly GitHubReviewThread[];
  readonly canComment: boolean;
  readonly filesUrl: string;
  readonly onAddToChat: AddToChat;
}) {
  const intl = useIntl();
  const openOnGitHub = useOpenOnGitHub();
  const { resolved } = useTheme();
  const { wrap } = useScopedAtomValue(reviewDiffPreferencesAtom);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ReviewDiffDraft>>(() => new Map());
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
  const slash = file.path.lastIndexOf("/");
  const directory = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = file.path.slice(slash + 1);
  const status = STATUS_MARK[file.status];
  const metadata = useMemo(() => (open ? fileDiffMetadata(file) : null), [file, open]);
  const fileThreads = threads.filter((thread) => thread.subject === "file");
  const lineThreads = threads.filter((thread) => thread.subject === "line" && thread.line !== null);
  const openThreads = threads.filter(isOpenGitHubThread).length;

  const threadAt = new Map(
    lineThreads.map((thread) => [`${annotationSide(thread.side)}:${thread.line}`, thread]),
  );
  const annotations: DiffLineAnnotation<GitHubDiffAnnotation>[] = [
    ...lineThreads.map((thread) => ({
      side: annotationSide(thread.side),
      lineNumber: thread.line ?? 0,
      metadata: { kind: "thread" as const, key: thread.id },
    })),
    ...[...drafts.values()].map((draft) => ({
      side: draft.side,
      lineNumber: draft.lineNumber,
      metadata: { kind: "draft" as const, key: draft.key },
    })),
  ];

  const startDraft = (range: SelectedLineRange | null) => {
    setSelectedLines(null);
    if (!range) return;
    const draft = normalizeReviewDiffRange(range);
    if (!draft || drafts.has(draft.key) || threadAt.has(draft.key)) return;
    setDrafts((current) => new Map(current).set(draft.key, { ...draft, path: file.path }));
  };
  const dropDraft = (key: string) =>
    setDrafts((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });

  const renderAnnotation = (annotation: DiffLineAnnotation<GitHubDiffAnnotation>) => {
    const meta = annotation.metadata;
    if (!meta) return null;
    if (meta.kind === "thread") {
      const thread = lineThreads.find((candidate) => candidate.id === meta.key);
      return thread ? (
        <GitHubReviewThreadCard
          thread={thread}
          pr={pr}
          run={run}
          placement="diff"
          onAddToChat={onAddToChat}
        />
      ) : null;
    }
    const draft = drafts.get(meta.key);
    return draft ? (
      <LineCommentDraft draft={draft} pr={pr} run={run} onDone={() => dropDraft(draft.key)} />
    ) : null;
  };

  const diffOptions = {
    ...getNodexDiffOptions(resolved, true, { wrap }),
    ...(canComment
      ? {
          enableLineSelection: true,
          enableGutterUtility: true,
          lineHoverHighlight: "both" as const,
          onGutterUtilityClick: startDraft,
          onLineSelected: startDraft,
          onLineSelectionChange: setSelectedLines,
        }
      : {}),
  } as NonNullable<FileDiffProps<GitHubDiffAnnotation, undefined>["options"]>;

  const viewedLabel = intl.formatMessage(
    { id: "githubThread.files.markViewed", defaultMessage: "Mark {path} as viewed" },
    { path: file.path },
  );
  return (
    <section
      data-github-file={file.path}
      className="scroll-mt-16 overflow-hidden rounded-lg ring-[0.5px] ring-token-border ring-inset"
    >
      <div
        className={cn(
          "flex h-8 w-full min-w-0 items-center gap-2 bg-token-list-hover-background/60 pr-2 text-sm",
          open && "border-b-[0.5px] border-token-border",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          disabled={file.patch === null}
          onClick={() => onOpenChange(!open)}
          className="cursor-interaction flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5 text-left disabled:cursor-default"
        >
          <ChevronRightIcon
            className={cn(
              "icon-2xs shrink-0 text-token-description-foreground transition-transform duration-150",
              open && "rotate-90",
              file.patch === null && "opacity-0",
            )}
          />
          <span className={cn("w-3 shrink-0 text-center font-mono text-xs", status.tone)}>
            {status.mark}
          </span>
          <span className="min-w-0 truncate font-mono text-xs">
            <span className="text-token-description-foreground">{directory}</span>
            <span className="text-token-text-primary">{name}</span>
          </span>
          {file.previousPath && file.previousPath !== file.path ? (
            <span className="min-w-0 shrink truncate font-mono text-xs text-token-description-foreground">
              ← {file.previousPath}
            </span>
          ) : null}
        </button>
        {openThreads > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-token-description-foreground">
            <FormattedMessage
              id="githubThread.files.openThreads"
              defaultMessage="{count, plural, one {# comment} other {# comments}}"
              values={{ count: openThreads }}
            />
          </span>
        ) : null}
        <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums">
          <span className="text-token-git-decoration-added-resource-foreground">
            +{file.additions}
          </span>
          <span className="text-token-git-decoration-deleted-resource-foreground">
            −{file.deletions}
          </span>
        </span>
        {file.viewed === "dismissed" && !viewed ? (
          <span className="shrink-0 text-xs text-token-charts-orange">
            <FormattedMessage
              id="githubThread.files.changedSinceViewed"
              defaultMessage="Changed since viewed"
            />
          </span>
        ) : null}
        <NodexTooltip tooltipContent={viewedLabel} side="top" delayOpen>
          <label
            className={cn(
              "cursor-interaction flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs ring-[0.5px] ring-token-border ring-inset hover:bg-token-foreground/5",
              viewed
                ? "bg-token-foreground/5 text-token-text-primary"
                : "text-token-description-foreground",
            )}
          >
            <input
              type="checkbox"
              aria-label={viewedLabel}
              checked={viewed}
              onChange={(event) => onViewedChange(event.currentTarget.checked)}
              className="size-3 accent-current"
            />
            <FormattedMessage id="githubThread.files.viewed" defaultMessage="Viewed" />
          </label>
        </NodexTooltip>
      </div>
      {open && fileThreads.length > 0 ? (
        <div className="flex flex-col gap-2 border-b-[0.5px] border-token-border p-2">
          {fileThreads.map((thread) => (
            <GitHubReviewThreadCard
              key={thread.id}
              thread={thread}
              pr={pr}
              run={run}
              placement="diff"
              onAddToChat={onAddToChat}
            />
          ))}
        </div>
      ) : null}
      {file.patch === null ? (
        <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-token-description-foreground">
          <FormattedMessage
            id="githubThread.files.noDiff"
            defaultMessage="GitHub doesn’t show this diff here."
          />
          <a
            href={filesUrl}
            onClick={(event) => openOnGitHub(filesUrl, event)}
            className="hover:text-token-text-primary hover:underline"
          >
            <FormattedMessage id="githubThread.openOnGitHub" defaultMessage="Open on GitHub" />
          </a>
        </div>
      ) : metadata ? (
        <div className="bg-token-editor-background">
          <ReadOnlyFileDiff<GitHubDiffAnnotation>
            fileDiff={metadata}
            className={NODEX_DIFF_HOST_CLASS}
            style={getNodexDiffHostStyle(resolved)}
            options={diffOptions}
            lineAnnotations={annotations}
            selectedLines={selectedLines}
            renderAnnotation={renderAnnotation}
          />
        </div>
      ) : null}
    </section>
  );
}

/**
 * A new comment on a line or lines. Without a pending review it can go out at once or open one;
 * with one, it joins it, as GitHub requires.
 */
function LineCommentDraft({
  draft,
  pr,
  run,
  onDone,
}: {
  readonly draft: ReviewDiffDraft;
  readonly pr: GitHubPullRequestDetail;
  readonly run: GitHubThreadCommandRunner;
  readonly onDone: () => void;
}) {
  const intl = useIntl();
  const pending = pr.pendingReview;
  const side = gitHubSide(draft.side);
  const startSide = draft.startSide ? gitHubSide(draft.startSide) : side;
  const isRange =
    draft.startLine !== undefined && (draft.startLine !== draft.lineNumber || startSide !== side);
  const send = async (
    body: string,
    delivery: Extract<
      Parameters<GitHubThreadCommandRunner["run"]>[0],
      { type: "add_review_comment" }
    >["delivery"],
  ) => {
    const done = await run.run({
      type: "add_review_comment",
      path: draft.path,
      side,
      line: draft.lineNumber,
      ...(isRange && draft.startLine !== undefined
        ? { startLine: draft.startLine, startSide }
        : {}),
      body,
      // The lines are the current head's: GitHub anchors the comment there.
      expectedHeadSha: pr.headSha,
      delivery,
    });
    if (done) onDone();
    return done;
  };
  const lines = intl.formatMessage(
    {
      id: "githubThread.lineComment.lines",
      defaultMessage:
        "{range, select, true {Lines {start}–{end}} other {Line {end}}}{removed, select, true { (removed)} other {}}",
    },
    {
      range: String(isRange),
      start: draft.startLine ?? draft.lineNumber,
      end: draft.lineNumber,
      removed: String(side === "left" && startSide === "left"),
    },
  );
  return (
    <div className="my-1.5 font-sans whitespace-normal">
      <GitHubMarkdownEditor
        ariaLabel={intl.formatMessage(
          { id: "githubThread.lineComment.label", defaultMessage: "Comment on {lines}" },
          { lines: lines.toLowerCase() },
        )}
        placeholder={intl.formatMessage({
          id: "githubThread.lineComment.placeholder",
          defaultMessage: "Leave a comment",
        })}
        hint={
          pending
            ? intl.formatMessage({
                id: "githubThread.review.pendingHint",
                defaultMessage: "Only you see it until you submit your review",
              })
            : lines
        }
        onCancel={onDone}
        actions={
          pending
            ? [
                {
                  id: "add",
                  label: intl.formatMessage({
                    id: "githubThread.review.addToReview",
                    defaultMessage: "Add to review",
                  }),
                  submit: (body) => send(body, { kind: "pending_review", reviewId: pending.id }),
                },
              ]
            : [
                {
                  id: "publish",
                  label: intl.formatMessage({
                    id: "githubThread.lineComment.publish",
                    defaultMessage: "Comment",
                  }),
                  tooltip: intl.formatMessage({
                    id: "githubThread.lineComment.publishTooltip",
                    defaultMessage: "Post this comment now, on its own",
                  }),
                  submit: (body) => send(body, { kind: "publish" }),
                },
                {
                  id: "start",
                  label: intl.formatMessage({
                    id: "githubThread.lineComment.startReview",
                    defaultMessage: "Start review",
                  }),
                  tooltip: intl.formatMessage({
                    id: "githubThread.lineComment.startReviewTooltip",
                    defaultMessage:
                      "Keep it private until you submit a review with your other comments",
                  }),
                  submit: (body) => send(body, { kind: "start_review" }),
                },
              ]
        }
      />
    </div>
  );
}
