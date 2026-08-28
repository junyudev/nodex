import type { OnDiffLineEnterLeaveProps } from "@pierre/diffs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  FileDiffProps,
  SelectedLineRange,
} from "@pierre/diffs/react";
import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  ChevronDownIcon,
  CheckmarkIcon,
  CloseIcon,
  SidePanelFilesIcon,
  FileIcon,
  FileTreeChevronIcon,
  FileTreeLockIcon,
  ReviewCollapseAllDiffsIcon,
  ReviewCommitOrPushIcon,
  ReviewCreatePrIcon,
  ReviewDisableRichPreviewIcon,
  ReviewDisableWordDiffsIcon,
  ReviewDisableWordWrapIcon,
  ReviewEnableWordWrapIcon,
  ReviewFileToggleChevronIcon,
  ReviewExpandAllDiffsIcon,
  ReviewHideWhitespaceIcon,
  ReviewJumpToFileIcon,
  ReviewOpenInIcon,
  ReviewRefreshIcon,
  ReviewRichPreviewIcon,
  SearchIcon,
  ReviewSplitDiffIcon,
  ReviewUnifiedDiffIcon,
  ReviewWordDiffsIcon,
  MoreActionsIcon,
} from "../shared/icons";
import { FileTypeIcon, FileTypeIconSprite } from "@/components/shared/icons";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownMessage,
  NodexDropdownScrollList,
  NodexDropdownSearchInput,
  NodexDropdownSeparator,
} from "../ui/dropdown";
import { NodexTooltip } from "../ui/tooltip";
import { toast } from "../ui/toast";
import {
  useRegisterContentSearchSource,
  type ContentSearchLocalMatch,
  type ContentSearchLocalSource,
} from "@/features/content-search/content-search-context";
import {
  CONTENT_SEARCH_ACTIVE_MARK_CLASS,
  applyContentSearchDiffDomMarks,
  clearContentSearchMarks,
  findContentSearchDomMatch,
} from "@/features/content-search/content-search-dom";
import {
  NODEX_DIFF_HOST_CLASS,
  getNodexDiffHostStyle,
  getNodexReviewDiffOptions,
} from "@/lib/diff-presentation";
import {
  GIT_ACTION_COMMIT_OR_PUSH_PROMPT,
  GIT_ACTION_CREATE_PR_PROMPT,
} from "@/lib/git-action-prompts";
import { writeTextToClipboard } from "@/lib/clipboard";
import { RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE } from "@/lib/right-panel-composer-overlay-reserve";
import {
  middleTruncateReviewJumpText,
  selectReviewJumpToFileMatches,
  splitReviewJumpToFilePath,
} from "@/lib/review-jump-to-file";
import { useScopedAtom, useSetScopedAtom } from "@/lib/maitai";
import {
  acknowledgeReviewRevealAtom,
  initializeReviewRouteStateAtom,
  REVIEW_FILE_TREE_DEFAULT_WIDTH_PX,
  reviewDiffPreferencesAtom,
  reviewRouteStateAtom,
  type CanonicalReviewPath,
  type ReviewDiffMode,
  type ReviewRouteState,
  type ReviewSource,
  type ResolvedTurnDiffReview,
} from "@/features/review/model/review-view-state";
import {
  reconcileReviewDiffExpansionSource,
  setAllReviewDiffsExpanded,
  setReviewDiffExpanded,
  toggleReviewDiffExpanded,
} from "@/features/review/model/review-diff-expansion";
import {
  canonicalizeReviewPath,
  getReviewPathAliases,
  resolveReviewPathCandidate,
} from "@/features/review/model/review-path";
import {
  filterReviewFiles,
  buildReviewVisibleFiles,
  getReviewTotalChangedBytes,
  getReviewTotalChangedLines,
  isReviewLargeDiff,
  isReviewWordDiffEnabled,
  resolveReviewSelectedPath,
  REVIEW_CAPPED_MATCH_PAGE_SIZE,
} from "@/lib/review-diff-model";
import {
  buildReviewFileTreeDefaultExpandedPaths,
  buildReviewFileTreeExpandedPathsForSelection,
  buildReviewFileTreeModel,
  buildReviewFileTreeVisibleState,
  resolveReviewFileTreeItemIdForPath,
  resolveReviewFileTreeSelectedVisibleIndex,
  type ReviewFileTreeRow,
} from "@/lib/review-file-tree-model";
import {
  REVIEW_FILE_TREE_FALLBACK_ITEM_HEIGHT_PX,
  REVIEW_FILE_TREE_VIRTUALIZE_THRESHOLD,
  REVIEW_FILE_TREE_VIRTUAL_OVERSCAN,
  areReviewFileTreeRangesEqual,
  getReviewFileTreeOffset,
  getReviewFileTreeScrollTopForIndex,
  getReviewFileTreeVirtualLayout,
  getReviewFileTreeVirtualRange,
  isReviewFileTreeVirtualizationEnabled,
  resolveReviewFileTreeItemHeight,
  type ReviewFileTreeVirtualRange,
} from "@/lib/review-file-tree-virtualization";
import {
  filterReviewCodeCommentsForPath,
  type ReviewCodeComment,
} from "@/lib/review-code-comments";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import type {
  CodexTurnDiffPatchBatch,
  GitReviewBranchCommit,
  GitCatFileResult,
  GitReviewFileSummary,
  GitReviewFileStatus,
  GitReviewPatchResult,
  GitReviewSnapshot,
  GitReviewSource,
  ReviewDiffEntry,
  ReviewDiffLoadStatus,
  ReviewFileSafety,
  CodexReviewDiffCommentAttachment,
  ReviewDiffAnnotationSide,
} from "@/lib/types";
import type { ReviewConversationProjection } from "@/features/review/model/review-conversation-projection";
import { recordReviewRuntimeEvent } from "@/features/review/testing/review-runtime-probe";
import { cn } from "@/lib/utils";
import { showNativeContextMenu } from "@/lib/native-context-menu";
import { readExactWorkspaceTextFile } from "@/lib/read-exact-workspace-text-file";
import { ComposerPromptEditor } from "@/features/local-conversation/view/composer/composer-prompt-editor";
import {
  addReviewDiffCommentAttachment,
  removeReviewDiffCommentAttachment,
  updateReviewDiffCommentAttachment,
  useReviewDiffCommentAttachments,
} from "@/lib/review-diff-comment-attachment-store";
import {
  buildReviewDiffCommentAttachment,
  buildReviewDiffDraftAnnotation,
  buildReviewDiffDraftStorageScope,
  createReviewDiffDraftFromLine,
  createReviewDiffDraftFromRange,
  readReviewDiffDraftStorage,
  shouldBlockReviewDiffDraft,
  writeReviewDiffDraftStorage,
  type ReviewDiffAnnotationMetadata,
  type ReviewDiffDraft,
} from "@/lib/review-diff-annotations";
import {
  buildReviewDiffAnnotationKey,
  formatReviewDiffCommentLineLabel,
  getReviewDiffCommentText,
  mapReviewDiffPositionSideToAnnotationSide,
} from "../../../shared/review-diff-comments";
import {
  buildReviewFileSafety,
  describeReviewFileSafety,
} from "../../../shared/review-file-safety";
import { expandPartialDiffMetadata } from "@/features/review/model/expand-partial-diff-metadata";
import {
  REVIEW_SEARCH_MATCH_LIMIT,
  buildReviewSearchFiles,
  searchReviewFiles,
  type ReviewSearchLocation,
} from "@/features/review/model/review-search";
import {
  loadReviewFullContent,
  useReviewFullContentState,
  type ReviewFullFileContents,
} from "@/features/review/data/review-full-content-store";
import { requestReviewCatFile } from "@/features/review/data/review-cat-file-batcher";
import { getGitWorkerClient } from "@/lib/api";
import {
  createGitLiveWorkerQuery,
  getGitLiveQueryCoordinator,
  type GitQueryRepositoryIdentity,
  type GitWorkerQueryClient,
} from "@/features/review/data/git-query";
import {
  useReviewPathDiffs,
  type ReviewPathDiffState,
} from "@/features/review/data/use-review-path-diffs";
import {
  parsePatchFiles as defaultParsePatchFiles,
  FileDiff as defaultFileDiff,
  invoke as defaultInvoke,
  useTheme as defaultUseTheme,
  Virtualizer as ReviewDiffVirtualizer,
} from "./review-diff-panel-deps";
import {
  DiffStats,
  FilenameButton,
  normalizePathSegments,
  resolveOpenPath,
  stripPatchPrefix,
  summarizeFileDiffMetadata,
} from "@/features/local-conversation/view/shared/tools/diff-file-shared";

type TranscriptReviewSource = "selected-turn" | "last-turn";
type GitReviewLoadStatus = "idle" | "loading" | "loaded" | "load-failed";

interface ReviewDiffPanelProps {
  conversationProjection: ReviewConversationProjection;
  onStartThreadPrompt: (threadId: string, prompt: string) => Promise<unknown>;
  threadId?: string | null;
  projectWorkspacePath?: string | null;
  selectedTurnDiff?: ResolvedTurnDiffReview | null;
  initialSource?: ReviewSource;
  initialCommitSha?: string | null;
  initialFileTreeOpen?: boolean;
  searchOpenTick?: number;
  deps?: Partial<ReviewDiffPanelDeps>;
}

interface ReviewDiffPanelDeps {
  parsePatchFiles: typeof defaultParsePatchFiles;
  invoke: typeof defaultInvoke;
  useTheme: typeof defaultUseTheme;
  FileDiff: typeof defaultFileDiff;
  gitWorkerClient?: GitWorkerQueryClient;
  initialSummaryQuery?: boolean;
}

function resolveStateUpdate<Value>(current: Value, update: SetStateAction<Value>): Value {
  return typeof update === "function" ? (update as (previous: Value) => Value)(current) : update;
}

interface ReviewFileEntry {
  key: string;
  displayPath: string;
  previousPath: string | null;
  gitStatus: GitReviewFileStatus | null;
  revision: string | null;
  oldOid: string | null;
  newOid: string | null;
  patchText: string;
  openPath: string | null;
  openLine: number | undefined;
  additions: number | null;
  deletions: number | null;
  diffBytes: number;
  changedBytes: number;
  fileDiff: FileDiffMetadata | null;
  loadStatus: ReviewDiffLoadStatus;
  safety: ReviewFileSafety;
  generated?: boolean | null;
}

interface GitReviewFileEntryCacheRecord {
  basePath: string | null;
  parsePatchFiles: ReviewDiffPanelDeps["parsePatchFiles"];
  entry: ReviewFileEntry;
}

const gitReviewFileEntryCache = new WeakMap<GitReviewFileSummary, GitReviewFileEntryCacheRecord>();
const EMPTY_REVIEW_CODE_COMMENTS: ReviewCodeComment[] = [];
const EMPTY_REVIEW_COMMENT_ATTACHMENTS: CodexReviewDiffCommentAttachment[] = [];
const EMPTY_REVIEW_BRANCH_COMMITS: GitReviewBranchCommit[] = [];

interface ReviewSnapshot {
  source: ReviewSource;
  patch: string;
  files: ReviewFileEntry[];
  cwd: string | null;
  isGitRepository: boolean;
  baseRef: string | null;
  currentBranch: string | null;
  defaultBranch: string | null;
  errorMessage: string | null;
  emptyReason: "noDiff" | "noLongerAvailable" | null;
  snapshotGeneration: number;
}

interface ReviewEmptyStateCopy {
  title: string;
  description: string;
  showIllustration: boolean;
  showViewBranchDiffAction: boolean;
}

const REVIEW_FILE_TREE_MIN_WIDTH_PX = 200;
const REVIEW_FILE_TREE_MAX_WIDTH_RATIO = 0.6;
const REVIEW_FILE_TREE_SEARCH_INPUT_ID = "review-file-search";
const REVIEW_FULL_FILE_MAX_BYTES = 5_000_000;
const REVIEW_OPTIONS_MENU_ICON_CLASS_NAME = "icon-xs shrink-0";
const REVIEW_AGGREGATE_DIFF_STATS_CLASS_NAME = "text-size-chat mr-1 shrink-0 select-none";
const REVIEW_EMPTY_STATE_ACTION_BUTTON_CLASS_NAME =
  "border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg text-token-foreground bg-token-foreground/5 enabled:hover:bg-token-foreground/10 data-[state=open]:bg-token-foreground/10 border-transparent h-token-button-composer px-2 py-0 text-base leading-[18px]";
const REVIEW_EMPTY_STATE_ILLUSTRATION_PATH =
  "M20.4622 0.247806C21.3984 -0.00979114 22.5424 -0.0833059 24.3919 0.107181C26.2731 0.300998 28.6338 0.734691 31.9925 1.35718L50.5852 4.80249C53.6017 5.36157 54.6803 5.57925 55.6038 5.99488L55.929 6.15015C56.6787 6.52555 57.3664 7.00409 57.9681 7.57202C58.6934 8.25736 59.2703 9.14603 60.8177 11.6287L62.7884 14.7898C64.336 17.2728 64.8793 18.1822 65.1751 19.1355C65.455 20.0387 65.5807 20.9906 65.5491 21.9519C65.5479 21.9883 65.5432 22.0246 65.5413 22.0613C65.5596 22.3428 65.5672 22.6264 65.5579 22.9109V22.9119C65.5243 23.9209 65.245 24.9841 64.4183 27.9392L56.0804 57.7429C55.1602 61.0318 54.5093 63.3424 53.8548 65.1169V65.1179C53.2117 66.8608 52.6407 67.8608 51.9915 68.5945L51.9905 68.5955C50.6374 70.1236 48.849 71.2391 46.8811 71.781C45.9363 72.0411 44.7864 72.1129 42.9378 71.9226C41.0562 71.7288 38.6945 71.295 35.3362 70.6726L14.0296 66.7234C10.6714 66.101 8.31217 65.6599 6.51298 65.1716C4.74539 64.6918 3.74685 64.2213 3.03348 63.6541C1.54801 62.4722 0.529247 60.8364 0.122352 58.9822V58.9812C0.00960176 58.4665 -0.0292753 57.8806 0.0227425 57.1306C-0.0250512 56.373 0.0534353 55.4382 0.303016 54.1472C0.657029 52.3165 1.29974 50.004 2.22001 46.7146L11.302 14.2527C12.2224 10.9631 12.8721 8.65292 13.5266 6.87867C14.1702 5.13425 14.7404 4.13988 15.3841 3.41285C16.7292 1.89375 18.5059 0.78636 20.4622 0.247806ZM42.9808 70.9324C43.6743 71.0038 44.2688 71.0384 44.7903 71.0398C44.2691 71.0384 43.675 71.0038 42.9817 70.9324C42.7465 70.9081 42.5034 70.88 42.2522 70.8484L42.9808 70.9324ZM9.73075 64.908C10.9652 65.1573 12.3945 65.4229 14.0735 65.7341L35.3802 69.6824C37.4793 70.0714 39.1889 70.3869 40.635 70.616L39.7347 70.4675C38.4898 70.2571 37.0602 69.9936 35.3811 69.6824L14.0745 65.7341C12.3951 65.4229 10.9652 65.1573 9.73075 64.908ZM24.3411 0.604251C22.523 0.41699 21.4475 0.494741 20.595 0.729251C18.7322 1.24208 17.039 2.29737 15.7581 3.7439C15.1719 4.40597 14.6292 5.33725 13.9964 7.05249C13.3505 8.80345 12.7059 11.0904 11.7835 14.3875L2.70145 46.8494C1.77899 50.1466 1.14345 52.4359 0.794227 54.2419C0.452241 56.0108 0.446252 57.0412 0.622352 57.8445C1.00742 59.5997 1.972 61.1476 3.37821 62.2664C4.02189 62.7782 4.95004 63.227 6.68876 63.699C8.46395 64.1808 10.799 64.618 14.1653 65.2419L35.472 69.1912C38.8383 69.8151 41.176 70.2441 43.0325 70.4353C44.8509 70.6226 45.9261 70.545 46.7786 70.3103C48.6414 69.7974 50.3347 68.7422 51.6155 67.2957C52.2015 66.6336 52.7446 65.7028 53.3772 63.988C54.0232 62.237 54.6677 59.9493 55.5901 56.6521L63.928 26.8484C64.3266 25.4238 64.5906 24.4522 64.764 23.7244L53.3714 21.4041C52.1934 21.1641 51.6039 21.0432 51.2161 20.7195C50.9667 20.5111 50.7735 20.2461 50.6507 19.949C50.3911 19.6602 50.208 19.3084 50.1243 18.9255C50.06 18.6309 50.081 18.3236 50.1536 17.9578C50.2257 17.5945 50.3541 17.1493 50.5188 16.5759L53.5852 5.90015C52.8637 5.73959 51.8946 5.55438 50.4934 5.29468L31.9007 1.84839C28.5347 1.22455 26.1975 0.795542 24.3411 0.604251ZM48.5755 70.1746C48.2997 70.3039 48.0182 70.4211 47.7317 70.5261C48.0182 70.421 48.2997 70.3039 48.5755 70.1746ZM49.0227 69.9539L49.0218 69.9548L49.0227 69.9539ZM50.5677 68.9568C50.4229 69.0691 50.2746 69.1764 50.1243 69.281C50.2746 69.1764 50.4229 69.0691 50.5677 68.9568ZM51.8548 67.7722C51.771 67.8633 51.6848 67.9519 51.5979 68.0398C51.6848 67.9519 51.771 67.8633 51.8548 67.7722ZM0.428016 58.9783C0.944949 60.4218 1.85125 61.691 3.06669 62.658C3.78719 63.2307 4.79047 63.7019 6.55692 64.1814C6.78191 64.2425 7.01573 64.303 7.25907 64.363L6.5579 64.1814C5.23267 63.8217 4.33703 63.4667 3.66825 63.0701C3.55675 63.004 3.45169 62.9366 3.35184 62.8679C3.25212 62.7993 3.15765 62.7295 3.06766 62.658C2.0389 61.8396 1.23176 60.8043 0.694618 59.6306C0.645767 59.5239 0.59834 59.4164 0.553993 59.3074C0.509667 59.1984 0.467769 59.0884 0.428016 58.9773V58.9783ZM54.3792 60.9002C54.1696 61.606 53.9696 62.2451 53.7766 62.8298C54 62.1525 54.2305 61.4017 54.4778 60.5593C54.4441 60.6743 54.4123 60.7886 54.3792 60.9002ZM55.8245 57.6638C55.4675 58.9368 55.1526 60.0532 54.8587 61.0427C55.1526 60.0532 55.4675 58.9367 55.8245 57.6638ZM0.0764534 57.6433C0.0924277 57.7492 0.111172 57.8519 0.133094 57.9519C0.184295 58.1852 0.245507 58.4153 0.315711 58.6414L0.218055 58.2996C0.187644 58.1846 0.159687 58.0687 0.134071 57.9519C0.11215 57.8519 0.0928863 57.7491 0.0764534 57.6433ZM19.6155 45.2244C19.9624 43.9875 21.2673 43.1731 22.5306 43.407L36.8714 46.0652C38.1329 46.3007 38.8774 47.4939 38.5325 48.7302C38.1864 49.9672 36.8795 50.7801 35.6165 50.5476L21.2766 47.8904C20.0128 47.6561 19.2692 46.4622 19.6155 45.2244ZM34.096 22.2293C34.4424 20.9919 35.7486 20.1784 37.012 20.4119C38.2747 20.6469 39.0191 21.8407 38.6731 23.0779L37.3362 27.8572L42.219 28.7625C43.4806 28.9978 44.226 30.1911 43.8811 31.4275C43.5351 32.6645 42.2282 33.4774 40.9651 33.2449L36.0823 32.3406L34.7444 37.1228C34.3978 38.3595 33.0914 39.1732 31.8284 38.9402C30.5656 38.7055 29.8208 37.5113 30.1663 36.2742L31.5052 31.4919L26.6253 30.5877C25.3614 30.3533 24.6169 29.1595 24.9632 27.9216C25.3101 26.6846 26.6158 25.8702 27.8792 26.1043L32.7591 27.0085L34.096 22.2293ZM50.9993 16.7146C50.8323 17.296 50.7099 17.7177 50.6429 18.0554C50.5765 18.39 50.5694 18.6196 50.6126 18.8181C50.6955 19.1975 50.9025 19.5398 51.2005 19.7888C51.3566 19.919 51.5644 20.0181 51.8919 20.114C52.2222 20.2107 52.652 20.299 53.2444 20.4197L64.9554 22.8044C65.0101 22.4792 65.0411 22.2051 65.0501 21.9353C65.0799 21.0284 64.9606 20.1319 64.6975 19.283C64.4254 18.406 63.9256 17.5606 62.3636 15.0544L60.3938 11.8933C58.8317 9.38706 58.2918 8.56584 57.6243 7.93531C56.9781 7.32527 56.226 6.82357 55.3987 6.45093C55.0334 6.28652 54.6399 6.15562 54.0725 6.01441L50.9993 16.7146Z";

type ReviewFileTreeHostStyle = CSSProperties & Record<`--${string}`, string>;

const REVIEW_FILE_TREE_HOST_STYLE = {
  "--trees-row-height": "28px",
  "--trees-font-size": "13px",
  "--trees-item-padding-x": "6px",
  "--trees-item-margin-x": "0px",
  "--trees-item-row-gap": "10px",
  "--trees-icon-width": "16px",
  "--trees-level-gap": "0px",
  "--trees-border-radius": "6px",
  "--trees-fg": "var(--color-token-foreground)",
  "--trees-file-fg": "var(--color-token-description-foreground)",
  "--trees-fg-muted": "light-dark(#84848a, #84848a)",
  "--trees-bg": "var(--color-token-main-surface-primary)",
  "--trees-bg-muted": "var(--color-token-list-hover-background)",
  "--trees-border-color": "var(--color-token-border)",
  "--trees-indent-guide-bg": "color-mix(in lab, var(--trees-fg-muted) 25%, transparent)",
  "--trees-selected-fg": "var(--color-token-list-active-selection-foreground)",
  "--trees-selected-bg": "var(--color-token-list-active-selection-background)",
  "--trees-focus-ring-color": "var(--color-token-list-focus-outline)",
  "--trees-search-bg": "var(--color-token-bg-fog)",
  "--trees-search-fg": "var(--color-token-foreground)",
} satisfies ReviewFileTreeHostStyle;

const DEFAULT_REVIEW_DIFF_PANEL_DEPS: ReviewDiffPanelDeps = {
  parsePatchFiles: defaultParsePatchFiles,
  invoke: defaultInvoke,
  useTheme: defaultUseTheme,
  FileDiff: defaultFileDiff,
};

const REVIEW_RENDERABLE_FILE_SAFETY = buildReviewFileSafety();

function getReviewChangedLines(entry: Pick<ReviewFileEntry, "additions" | "deletions">): number {
  return (entry.additions ?? 0) + (entry.deletions ?? 0);
}

interface ReviewSearchMatchMeta {
  location: ReviewSearchLocation;
  pathMatches: readonly {
    id: string;
    location: ReviewSearchLocation;
  }[];
}

function isReviewSearchMatchMeta(value: unknown): value is ReviewSearchMatchMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<ReviewSearchMatchMeta>;
  return (
    typeof meta.location === "object" &&
    meta.location !== null &&
    typeof meta.location.path === "string" &&
    Array.isArray(meta.pathMatches)
  );
}

function buildReviewContentSearchMatches(input: {
  contextId: string;
  locations: readonly ReviewSearchLocation[];
}): ContentSearchLocalMatch[] {
  const matchesByPath = new Map<string, Array<{ id: string; location: ReviewSearchLocation }>>();
  const identities = input.locations.map(
    (location) => `diff:${location.path}:${location.hunkId}:${location.start}`,
  );
  input.locations.forEach((location, index) => {
    const matches = matchesByPath.get(location.path) ?? [];
    matches.push({ id: identities[index] ?? "", location });
    matchesByPath.set(location.path, matches);
  });

  return input.locations.map((location, index) => ({
    id: identities[index] ?? "",
    domain: "diff",
    contextId: input.contextId,
    ordinal: index + 1,
    label: location.path,
    meta: {
      location,
      pathMatches: matchesByPath.get(location.path) ?? [],
    } satisfies ReviewSearchMatchMeta,
  }));
}

function nextReviewAnimationFrame(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Review search aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    let frameId: number | null = null;
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      cleanup();
      reject(new DOMException("Review search aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    frameId = requestAnimationFrame(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    });
    if (signal?.aborted) abort();
  });
}

function waitForReviewRevealRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Review reveal aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 50);
    const abort = () => {
      window.clearTimeout(timerId);
      reject(new DOMException("Review reveal aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

const SOURCE_LABELS: Record<ReviewSource, string> = {
  "selected-turn": "Last turn",
  "last-turn": "Last turn",
  branch: "Branch",
  commit: "Commit",
  staged: "Staged",
  unstaged: "Unstaged",
};

function formatReviewCommitRelativeTime(committedAt: string): string {
  const committedAtMs = Date.parse(committedAt);
  if (!Number.isFinite(committedAtMs)) return "";

  const elapsedMs = Math.max(0, Date.now() - committedAtMs);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return "now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `${elapsedDays}d`;

  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return `${elapsedMonths}mo`;

  return `${Math.floor(elapsedMonths / 12)}y`;
}

function ReviewSourceCountBadge({ count }: { count: number }) {
  return (
    <span className="disambiguated-digits rounded bg-token-foreground/10 px-1.5 py-0.5 text-xs font-medium text-token-description-foreground">
      {count}
    </span>
  );
}

function buildReviewJumpCanvasFont(style: CSSStyleDeclaration): string {
  return [
    style.fontStyle || "normal",
    style.fontVariant || "normal",
    style.fontWeight || "400",
    style.fontSize || "14px",
    style.fontFamily || "sans-serif",
  ].join(" ");
}

function createReviewJumpTextMeasurer(font: string): ((value: string) => number | null) | null {
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.font = font;
  return (value: string) => {
    const width = context.measureText(value).width;
    return Number.isFinite(width) ? width : null;
  };
}

function ReviewJumpMiddleTruncatedText({ className, text }: { className?: string; text: string }) {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const [measurement, setMeasurement] = useState<{
    font: string;
    maxWidthPx: number;
  } | null>(null);

  const updateMeasurement = useCallback(() => {
    if (!element || element.clientWidth <= 0) {
      setMeasurement(null);
      return;
    }

    const ownerWindow = element.ownerDocument.defaultView ?? window;
    const style = ownerWindow.getComputedStyle(element);
    const nextMeasurement = {
      font: buildReviewJumpCanvasFont(style),
      maxWidthPx: element.clientWidth,
    };
    setMeasurement((current) =>
      current?.font === nextMeasurement.font && current.maxWidthPx === nextMeasurement.maxWidthPx
        ? current
        : nextMeasurement,
    );
  }, [element]);

  useLayoutEffect(() => {
    updateMeasurement();
    if (!element || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => updateMeasurement());
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, updateMeasurement]);

  const renderedText = useMemo(() => {
    if (!measurement) return text;
    const measureTextWidth = createReviewJumpTextMeasurer(measurement.font);
    if (!measureTextWidth) return text;
    return middleTruncateReviewJumpText(text, measurement.maxWidthPx, measureTextWidth);
  }, [measurement, text]);

  const body = (
    <span
      ref={setElement}
      className={cn("block min-w-0 overflow-hidden whitespace-nowrap", className)}
    >
      {renderedText}
    </span>
  );

  return (
    <NodexTooltip tooltipContent={text} disabled={renderedText === text}>
      {body}
    </NodexTooltip>
  );
}

function ReviewJumpFilePathLabel({ displayPath }: { displayPath: string }) {
  const { fileName, parentPath } = useMemo(
    () => splitReviewJumpToFilePath(displayPath),
    [displayPath],
  );

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-token-foreground">{fileName}</span>
      {parentPath.length > 0 ? (
        <ReviewJumpMiddleTruncatedText
          className="min-w-0 flex-1 text-token-description-foreground"
          text={parentPath}
        />
      ) : null}
    </span>
  );
}

function buildReviewGitApplyCommand(diff: string): string {
  return ` (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' \n${diff.trimEnd()} \nEOF\n)`;
}

function isTranscriptReviewSource(source: ReviewSource): source is TranscriptReviewSource {
  return source === "selected-turn" || source === "last-turn";
}

function isGitReviewSource(source: ReviewSource): source is GitReviewSource {
  return source === "branch" || source === "commit" || source === "staged" || source === "unstaged";
}

function resolveReviewNoFilesEmptyStateCopy(
  source: ReviewSource,
  emptyReason: ReviewSnapshot["emptyReason"],
): ReviewEmptyStateCopy {
  if (source === "staged") {
    return {
      title: "No staged changes",
      description: "Accept edits to stage them",
      showIllustration: false,
      showViewBranchDiffAction: true,
    };
  }

  if (source === "unstaged") {
    return {
      title: "No unstaged changes",
      description: "Code changes will appear here",
      showIllustration: false,
      showViewBranchDiffAction: true,
    };
  }

  if (emptyReason === "noLongerAvailable") {
    return {
      title: "No file changes yet",
      description:
        source === "selected-turn"
          ? "The selected turn diff is no longer available."
          : "The latest diffs are no longer available.",
      showIllustration: true,
      showViewBranchDiffAction: source !== "branch",
    };
  }

  if (source === "last-turn") {
    return {
      title: "No file changes yet",
      description: "The last turn was committed or reverted.",
      showIllustration: true,
      showViewBranchDiffAction: true,
    };
  }

  return {
    title: "No file changes yet",
    description: "Changes in this project will appear here.",
    showIllustration: true,
    showViewBranchDiffAction: source !== "branch",
  };
}

function ReviewPanelIcon({ className }: { className?: string }) {
  return (
    <svg
      width="66"
      height="73"
      viewBox="0 0 66 73"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("h-18 w-auto text-token-input-placeholder-foreground", className)}
    >
      <path d={REVIEW_EMPTY_STATE_ILLUSTRATION_PATH} fill="currentColor" />
    </svg>
  );
}

function normalizeReviewBasePath(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const normalizedPath = normalizePathSegments(cwd);
  return normalizedPath.length > 0 ? normalizedPath : null;
}

function resolveOpenLine(fileDiff: FileDiffMetadata): number | undefined {
  const firstHunk = fileDiff.hunks[0];
  if (!firstHunk) return undefined;

  const line = firstHunk.additionStart > 0 ? firstHunk.additionStart : firstHunk.deletionStart;
  return line > 0 ? line : 1;
}

function resolveReviewEntryLoadStatus(input: {
  safety: ReviewFileSafety;
  fileDiff: FileDiffMetadata | null;
  fallbackStatus?: ReviewDiffLoadStatus | null;
}): ReviewDiffLoadStatus {
  if (input.safety.skipReason === "binary") return "binary";
  if (input.safety.skipReason === "tooLarge") return "diff-too-large";
  if (input.safety.skipReason === "invalidText" || input.safety.skipReason === "unsupported")
    return "unsupported";
  if (input.fallbackStatus) return input.fallbackStatus;
  return input.fileDiff ? "loaded" : "unsupported";
}

function readReviewDiffEntryStatus(summary: GitReviewFileSummary): ReviewDiffLoadStatus | null {
  const candidate = summary as Partial<ReviewDiffEntry>;
  const loadStatus = candidate.loadStatus;
  return typeof loadStatus === "string" ? loadStatus : null;
}

function readReviewDiffEntryPatch(summary: GitReviewFileSummary): string | null {
  const candidate = summary as Partial<ReviewDiffEntry>;
  return typeof candidate.diff === "string" ? candidate.diff : null;
}

function readReviewDiffEntryBytes(
  summary: GitReviewFileSummary,
  field: "diffBytes" | "changedBytes",
): number | null {
  const value = (summary as Partial<ReviewDiffEntry>)[field];
  return typeof value === "number" ? value : null;
}

function buildReviewFileEntryFromSummary(
  summary: GitReviewFileSummary,
  basePath: string | null,
  existing: ReviewFileEntry | null,
): ReviewFileEntry {
  const displayPath = stripPatchPrefix(summary.path);
  const summarySafety = summary.safety ?? REVIEW_RENDERABLE_FILE_SAFETY;
  const summaryPatch = readReviewDiffEntryPatch(summary);
  const summaryLoadStatus = readReviewDiffEntryStatus(summary);
  const fileDiff = summarySafety.renderable ? (existing?.fileDiff ?? null) : null;
  const patchText = summarySafety.renderable ? (summaryPatch ?? existing?.patchText ?? "") : "";
  const safety = summarySafety.renderable && existing?.safety ? existing.safety : summarySafety;
  const fallbackStatus =
    summarySafety.renderable && !fileDiff
      ? (summaryLoadStatus ?? (patchText.trim().length > 0 ? "loaded" : "loading"))
      : summaryLoadStatus;

  return {
    key: displayPath,
    displayPath,
    previousPath: summary.previousPath ?? existing?.previousPath ?? null,
    gitStatus: summary.status,
    revision: summary.revision,
    oldOid: summary.oldOid,
    newOid: summary.newOid,
    patchText,
    openPath: resolveOpenPath(displayPath, basePath),
    openLine: existing?.openLine,
    additions: summary.additions,
    deletions: summary.deletions,
    diffBytes: readReviewDiffEntryBytes(summary, "diffBytes") ?? existing?.diffBytes ?? 0,
    changedBytes: readReviewDiffEntryBytes(summary, "changedBytes") ?? existing?.changedBytes ?? 0,
    fileDiff,
    loadStatus: resolveReviewEntryLoadStatus({
      safety,
      fileDiff,
      fallbackStatus,
    }),
    safety,
    generated: summary.generated,
  };
}

function splitPatchByFiles(patch: string): string[] {
  const trimmedPatch = patch.trim();
  if (trimmedPatch.length === 0) return [];

  const lines = patch.split("\n");
  const patches: string[] = [];
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && currentLines.length > 0) {
      patches.push(currentLines.join("\n").trimEnd());
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
  }

  if (currentLines.length > 0) {
    const nextPatch = currentLines.join("\n").trimEnd();
    if (nextPatch.length > 0) {
      patches.push(nextPatch);
    }
  }

  return patches;
}

function buildReviewFileEntries(
  patch: string,
  basePath: string | null,
  parsePatchFiles: ReviewDiffPanelDeps["parsePatchFiles"],
  metadataFiles: GitReviewFileSummary[] = [],
): ReviewFileEntry[] {
  const metadataByPath = new Map(metadataFiles.map((file) => [stripPatchPrefix(file.path), file]));
  const entriesByPath = new Map<string, ReviewFileEntry>();
  const orderedPaths: string[] = [];

  if (patch.trim()) {
    const filePatches = splitPatchByFiles(patch);
    let flatFileIndex = 0;

    try {
      for (const [patchIndex, parsedPatch] of parsePatchFiles(patch).entries()) {
        for (const [fileIndex, fileDiff] of parsedPatch.files.entries()) {
          const additionsDeletions = summarizeFileDiffMetadata(fileDiff);
          const displayPath = stripPatchPrefix(
            fileDiff.name ?? fileDiff.prevName ?? `file-${patchIndex}-${fileIndex}`,
          );
          const patchText = filePatches[flatFileIndex] ?? patch;
          flatFileIndex += 1;
          const existing = entriesByPath.get(displayPath) ?? null;
          const metadata = metadataByPath.get(displayPath) ?? null;
          const nextPatchText = existing ? `${existing.patchText}\n${patchText}` : patchText;
          const safety = metadata?.safety ?? REVIEW_RENDERABLE_FILE_SAFETY;
          const fileDiffForEntry = safety.renderable ? fileDiff : null;
          const diffBytes = metadata ? readReviewDiffEntryBytes(metadata, "diffBytes") : null;
          const changedBytes = metadata ? readReviewDiffEntryBytes(metadata, "changedBytes") : null;
          const fallbackPatchBytes =
            diffBytes === null || changedBytes === null
              ? new TextEncoder().encode(nextPatchText).length
              : 0;

          if (!existing) orderedPaths.push(displayPath);
          entriesByPath.set(displayPath, {
            key: displayPath,
            displayPath,
            previousPath:
              fileDiff.prevName ?? metadata?.previousPath ?? existing?.previousPath ?? null,
            gitStatus: metadata?.status ?? null,
            revision: metadata?.revision ?? existing?.revision ?? null,
            oldOid: metadata?.oldOid ?? fileDiff.prevObjectId ?? existing?.oldOid ?? null,
            newOid: metadata?.newOid ?? fileDiff.newObjectId ?? existing?.newOid ?? null,
            patchText: safety.renderable ? nextPatchText : "",
            openPath: resolveOpenPath(displayPath, basePath),
            openLine: resolveOpenLine(fileDiff) ?? existing?.openLine,
            additions:
              metadata?.additions ?? (existing?.additions ?? 0) + additionsDeletions.additions,
            deletions:
              metadata?.deletions ?? (existing?.deletions ?? 0) + additionsDeletions.deletions,
            diffBytes: diffBytes ?? fallbackPatchBytes,
            changedBytes: changedBytes ?? fallbackPatchBytes,
            fileDiff: fileDiffForEntry,
            loadStatus: resolveReviewEntryLoadStatus({
              safety,
              fileDiff: fileDiffForEntry,
            }),
            safety,
            generated: metadata?.generated,
          } satisfies ReviewFileEntry);
        }
      }
    } catch {
      entriesByPath.clear();
      orderedPaths.splice(0, orderedPaths.length);
    }
  }

  for (const metadata of metadataFiles) {
    const displayPath = stripPatchPrefix(metadata.path);
    const existing = entriesByPath.get(displayPath) ?? null;
    if (!existing) orderedPaths.push(displayPath);
    entriesByPath.set(displayPath, buildReviewFileEntryFromSummary(metadata, basePath, existing));
  }

  return orderedPaths.flatMap((displayPath) => {
    const entry = entriesByPath.get(displayPath);
    return entry ? [entry] : [];
  });
}

function buildGitReviewFileEntries(
  basePath: string | null,
  parsePatchFiles: ReviewDiffPanelDeps["parsePatchFiles"],
  metadataFiles: GitReviewFileSummary[],
): ReviewFileEntry[] {
  return metadataFiles.flatMap((file) => {
    const cached = gitReviewFileEntryCache.get(file);
    if (cached?.basePath === basePath && cached.parsePatchFiles === parsePatchFiles) {
      return [cached.entry];
    }

    let entry: ReviewFileEntry;
    if (isReviewDiffEntryLike(file) && file.diff.trim().length > 0) {
      recordReviewRuntimeEvent({ type: "partial-parse", path: file.path });
      entry =
        buildReviewFileEntries(file.diff, basePath, parsePatchFiles, [file])[0] ??
        buildReviewFileEntryFromSummary(file, basePath, null);
    } else {
      entry = buildReviewFileEntryFromSummary(file, basePath, null);
    }

    gitReviewFileEntryCache.set(file, { basePath, parsePatchFiles, entry });
    return [entry];
  });
}

function isReviewFileSafety(value: unknown): value is ReviewFileSafety {
  if (typeof value !== "object" || value === null) return false;
  const safety = value as Partial<ReviewFileSafety>;
  return (
    typeof safety.binary === "boolean" &&
    typeof safety.tooLarge === "boolean" &&
    typeof safety.invalidText === "boolean" &&
    typeof safety.renderable === "boolean" &&
    "skipReason" in safety
  );
}

function mapCodexChangeKindToGitStatus(kind: string): GitReviewFileStatus {
  if (kind === "add") return "added";
  if (kind === "delete") return "deleted";
  return "modified";
}

function buildPatchBatchMetadataFiles(
  patchBatches: readonly CodexTurnDiffPatchBatch[] | null | undefined,
): GitReviewFileSummary[] {
  const summariesByPath = new Map<string, GitReviewFileSummary>();

  for (const batch of patchBatches ?? []) {
    for (const change of batch.changes) {
      if (typeof change !== "object" || change === null) continue;
      const candidate = change as {
        path?: unknown;
        type?: unknown;
        originalType?: unknown;
        movePath?: unknown;
        safety?: unknown;
      };
      if (candidate.type !== "nonRenderable") continue;
      if (typeof candidate.path !== "string" || candidate.path.trim().length === 0) continue;
      if (!isReviewFileSafety(candidate.safety)) continue;

      const displayPath = stripPatchPrefix(candidate.path.trim());
      summariesByPath.set(displayPath, {
        path: displayPath,
        previousPath:
          typeof candidate.movePath === "string" && candidate.movePath.trim().length > 0
            ? candidate.movePath
            : null,
        status: mapCodexChangeKindToGitStatus(String(candidate.originalType ?? "update")),
        rawStatus: null,
        oldOid: null,
        newOid: null,
        revision: null,
        additions: null,
        deletions: null,
        safety: candidate.safety,
      });
    }
  }

  return Array.from(summariesByPath.values());
}

function isTextualFullDiffCandidate(entry: ReviewFileEntry): boolean {
  const fileDiff = entry.fileDiff;
  return (
    entry.safety.renderable &&
    entry.generated !== true &&
    entry.generated !== null &&
    fileDiff !== null &&
    fileDiff.isPartial &&
    fileDiff.mode !== "160000" &&
    fileDiff.type !== "new" &&
    fileDiff.type !== "deleted" &&
    fileDiff.type !== "rename-pure" &&
    getReviewChangedLines(entry) > 0
  );
}

function splitReviewFileContents(contents: string): string[] {
  const lines = contents.split(/(?<=\n)/);
  if (lines.length === 1 && lines[0] === "") return [];
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function buildReviewFullContentKey(input: {
  entry: ReviewFileEntry;
  cwd: string | null;
  hostConfigKey: string;
  nextFallbackToDisk: boolean;
  ignoreWhitespace: boolean;
  loadFullFilesEnabled: boolean;
  snapshotGeneration: number | null;
}): string {
  const { entry } = input;
  const metadata = entry.fileDiff;
  const metadataIdentity =
    metadata?.cacheKey ??
    `${metadata?.name ?? entry.displayPath}:${metadata?.prevObjectId ?? "none"}:${metadata?.newObjectId ?? "none"}:${entry.additions ?? 0}:${entry.deletions ?? 0}`;
  return JSON.stringify([
    metadataIdentity,
    metadata?.prevName ?? "",
    metadata?.name ?? entry.displayPath,
    input.cwd ?? "",
    input.hostConfigKey,
    input.nextFallbackToDisk ? "next-disk-fallback" : "next-object-only",
    input.ignoreWhitespace ? "ignore-whitespace" : "exact-whitespace",
    input.loadFullFilesEnabled ? "full" : "partial",
    input.snapshotGeneration ?? "unversioned",
  ]);
}

function buildUnavailableReviewFullContents(entry: ReviewFileEntry): ReviewFullFileContents {
  return {
    path: entry.displayPath,
    previousPath: entry.previousPath,
    oldText: null,
    newText: null,
    oldExists: false,
    newExists: false,
    oldStatus: "unsupported",
    newStatus: "unsupported",
    safety: entry.safety.renderable ? buildReviewFileSafety({ unsupported: true }) : entry.safety,
    errorMessage: null,
  };
}

interface ReviewCatFileTextRead {
  text: string | null;
  exists: boolean;
  status: ReviewDiffLoadStatus;
  safety: ReviewFileSafety;
}

function normalizeReviewObjectId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized || /^0+$/.test(normalized)) return null;
  return normalized;
}

function buildReviewCatFileTextRead(result: GitCatFileResult | undefined): ReviewCatFileTextRead {
  if (!result || (result.type === "error" && result.error.type === "unknown")) {
    return {
      text: null,
      exists: false,
      status: "load-failed",
      safety: buildReviewFileSafety({ unsupported: true }),
    };
  }
  if (result.type === "error" && result.error.type === "not-found") {
    return {
      text: null,
      exists: false,
      status: "loaded",
      safety: buildReviewFileSafety(),
    };
  }
  if (result.type === "error" && result.error.type === "too-large") {
    return {
      text: null,
      exists: true,
      status: "diff-too-large",
      safety: buildReviewFileSafety({
        tooLarge: true,
        sizeBytes: result.error.limitBytes,
      }),
    };
  }
  if (result.type === "error") {
    return {
      text: null,
      exists: false,
      status: "load-failed",
      safety: buildReviewFileSafety({ unsupported: true }),
    };
  }

  const text = result.lines.join("");
  return {
    text,
    exists: true,
    status: "loaded",
    safety: buildReviewFileSafety({ sizeBytes: text.length }),
  };
}

function mergeReviewCatFileSafety(
  oldRead: ReviewCatFileTextRead,
  newRead: ReviewCatFileTextRead,
): ReviewFileSafety {
  if (!oldRead.safety.renderable) return oldRead.safety;
  if (!newRead.safety.renderable) return newRead.safety;
  return buildReviewFileSafety({
    sizeBytes: (oldRead.safety.sizeBytes ?? 0) + (newRead.safety.sizeBytes ?? 0),
  });
}

function isReviewNewFile(fileDiff: FileDiffMetadata): boolean {
  return String(fileDiff.type) === "new" || String(fileDiff.type) === "add";
}

function isReviewDeletedFile(fileDiff: FileDiffMetadata): boolean {
  return String(fileDiff.type) === "deleted" || String(fileDiff.type) === "delete";
}

function hasPatchLineArrays(fileDiff: FileDiffMetadata): boolean {
  const candidate = fileDiff as {
    additionLines?: unknown;
    deletionLines?: unknown;
    hunks?: unknown;
  };
  if (!Array.isArray(candidate.additionLines)) return false;
  if (!Array.isArray(candidate.deletionLines)) return false;
  if (!Array.isArray(candidate.hunks)) return false;
  return candidate.hunks.every((hunk) => {
    if (typeof hunk !== "object" || hunk === null) return false;
    const value = hunk as Partial<FileDiffMetadata["hunks"][number]>;
    return (
      Number.isInteger(value.additionStart) &&
      Number.isInteger(value.additionCount) &&
      Number.isInteger(value.additionLineIndex) &&
      Number.isInteger(value.deletionCount) &&
      Number.isInteger(value.deletionLineIndex)
    );
  });
}

function splitLinesPreservingNewlines(contents: string): string[] {
  if (contents.length === 0) return [];

  const lines: string[] = [];
  let startIndex = 0;
  for (;;) {
    const newlineIndex = contents.indexOf("\n", startIndex);
    if (newlineIndex === -1) break;
    lines.push(contents.slice(startIndex, newlineIndex + 1));
    startIndex = newlineIndex + 1;
  }
  if (startIndex < contents.length) {
    lines.push(contents.slice(startIndex));
  }
  return lines;
}

function areLineArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}

function slicePatchLines(lines: string[], startIndex: number, count: number): string[] | null {
  if (startIndex < 0 || count < 0) return null;
  const endIndex = startIndex + count;
  if (endIndex > lines.length) return null;
  return lines.slice(startIndex, endIndex);
}

function reconstructOldTextFromCurrentText(
  fileDiff: FileDiffMetadata,
  currentText: string,
): string | null {
  if (!hasPatchLineArrays(fileDiff)) return null;

  const oldLines = splitLinesPreservingNewlines(currentText);
  for (const hunk of [...fileDiff.hunks].reverse()) {
    const startIndex = hunk.additionStart - 1;
    const expectedNewLines = slicePatchLines(
      fileDiff.additionLines,
      hunk.additionLineIndex,
      hunk.additionCount,
    );
    const replacementOldLines = slicePatchLines(
      fileDiff.deletionLines,
      hunk.deletionLineIndex,
      hunk.deletionCount,
    );
    if (!expectedNewLines || !replacementOldLines) return null;
    if (
      !areLineArraysEqual(
        oldLines.slice(startIndex, startIndex + expectedNewLines.length),
        expectedNewLines,
      )
    ) {
      return null;
    }
    oldLines.splice(startIndex, expectedNewLines.length, ...replacementOldLines);
  }

  return oldLines.join("");
}

function buildTranscriptFullContentsFromPatch(
  entry: ReviewFileEntry,
  currentText: string,
): ReviewFullFileContents {
  if (!entry.fileDiff) return buildUnavailableReviewFullContents(entry);
  const oldText = reconstructOldTextFromCurrentText(entry.fileDiff, currentText);
  if (oldText === null) return buildUnavailableReviewFullContents(entry);

  return {
    path: entry.displayPath,
    previousPath: entry.previousPath,
    oldText,
    newText: currentText,
    oldExists: true,
    newExists: true,
    oldStatus: "loaded",
    newStatus: "loaded",
    safety: buildReviewFileSafety({
      sizeBytes: oldText.length + currentText.length,
    }),
    errorMessage: null,
  };
}

function buildTranscriptDeletedFileContents(entry: ReviewFileEntry): ReviewFullFileContents {
  if (!entry.fileDiff) return buildUnavailableReviewFullContents(entry);
  if (!hasPatchLineArrays(entry.fileDiff)) return buildUnavailableReviewFullContents(entry);

  return {
    path: entry.displayPath,
    previousPath: entry.previousPath,
    oldText: entry.fileDiff.deletionLines.join(""),
    newText: null,
    oldExists: true,
    newExists: false,
    oldStatus: "loaded",
    newStatus: "loaded",
    safety: buildReviewFileSafety({
      sizeBytes: entry.fileDiff.deletionLines.join("").length,
    }),
    errorMessage: null,
  };
}

function buildTranscriptNewFileContentsFromPatch(entry: ReviewFileEntry): ReviewFullFileContents {
  if (!entry.fileDiff) return buildUnavailableReviewFullContents(entry);
  if (!hasPatchLineArrays(entry.fileDiff)) return buildUnavailableReviewFullContents(entry);

  return {
    path: entry.displayPath,
    previousPath: entry.previousPath,
    oldText: "",
    newText: entry.fileDiff.additionLines.join(""),
    oldExists: false,
    newExists: true,
    oldStatus: "loaded",
    newStatus: "loaded",
    safety: buildReviewFileSafety({
      sizeBytes: entry.fileDiff.additionLines.join("").length,
    }),
    errorMessage: null,
  };
}

function buildLastTurnSnapshot(
  conversation: ReviewConversationProjection,
  projectWorkspacePath: string | null | undefined,
  parsePatchFiles: ReviewDiffPanelDeps["parsePatchFiles"],
  isGitRepository: boolean,
): ReviewSnapshot {
  const patch = conversation.lastTurnPatch;
  const cwd = conversation.cwd ?? projectWorkspacePath ?? null;
  const basePath = normalizeReviewBasePath(cwd);
  const metadataFiles = buildPatchBatchMetadataFiles(conversation.lastTurnPatchBatches);
  const files = buildReviewFileEntries(patch, basePath, parsePatchFiles, metadataFiles);

  return {
    source: "last-turn",
    patch,
    files,
    cwd,
    isGitRepository,
    baseRef: null,
    currentBranch: null,
    defaultBranch: null,
    errorMessage: null,
    emptyReason: patch.trim().length === 0 && files.length === 0 ? "noLongerAvailable" : null,
    snapshotGeneration: 0,
  };
}

function buildSelectedTurnSnapshot(
  selectedTurnDiff: ResolvedTurnDiffReview | null | undefined,
  conversation: ReviewConversationProjection,
  projectWorkspacePath: string | null | undefined,
  parsePatchFiles: ReviewDiffPanelDeps["parsePatchFiles"],
  isGitRepository: boolean,
): ReviewSnapshot {
  const patch = selectedTurnDiff?.patch ?? "";
  const cwd = selectedTurnDiff?.cwd ?? conversation.cwd ?? projectWorkspacePath ?? null;
  const basePath = normalizeReviewBasePath(cwd);
  const metadataFiles = buildPatchBatchMetadataFiles(selectedTurnDiff?.patchBatches);
  const files = buildReviewFileEntries(patch, basePath, parsePatchFiles, metadataFiles);

  return {
    source: "selected-turn",
    patch,
    files,
    cwd,
    isGitRepository,
    baseRef: null,
    currentBranch: null,
    defaultBranch: null,
    errorMessage: null,
    emptyReason: patch.trim().length === 0 && files.length === 0 ? "noLongerAvailable" : null,
    snapshotGeneration: 0,
  };
}

function buildGitSnapshot(
  gitSnapshot: GitReviewSnapshot | null,
  parsePatchFiles: ReviewDiffPanelDeps["parsePatchFiles"],
): ReviewSnapshot {
  const cwd = gitSnapshot?.cwd ?? null;
  const basePath = normalizeReviewBasePath(cwd);
  const patch = gitSnapshot?.patch ?? "";
  const files = buildGitReviewFileEntries(basePath, parsePatchFiles, gitSnapshot?.files ?? []);

  return {
    source: gitSnapshot?.source ?? "unstaged",
    patch,
    files,
    cwd,
    isGitRepository: gitSnapshot?.isGitRepository ?? false,
    baseRef: gitSnapshot?.baseRef ?? null,
    currentBranch: gitSnapshot?.currentBranch ?? null,
    defaultBranch: gitSnapshot?.defaultBranch ?? null,
    errorMessage: gitSnapshot?.errorMessage ?? null,
    emptyReason: patch.trim().length === 0 && files.length === 0 ? "noDiff" : null,
    snapshotGeneration: gitSnapshot?.snapshotGeneration ?? 0,
  };
}

function isReviewDiffEntryLike(file: GitReviewFileSummary): file is ReviewDiffEntry {
  const candidate = file as Partial<ReviewDiffEntry>;
  return typeof candidate.diff === "string" && typeof candidate.loadStatus === "string";
}

interface GitReviewFilePathDiffCacheRecord {
  source: ReviewDiffEntry | Error;
  entry: ReviewDiffEntry;
}

interface GitReviewSnapshotPathDiffCacheRecord {
  files: GitReviewFileSummary[];
  snapshot: GitReviewSnapshot;
}

const gitReviewFilePathDiffCache = new WeakMap<
  GitReviewFileSummary,
  GitReviewFilePathDiffCacheRecord
>();
const gitReviewSnapshotPathDiffCache = new WeakMap<
  GitReviewSnapshot,
  GitReviewSnapshotPathDiffCacheRecord
>();

function buildFailedGitReviewPathDiff(file: GitReviewFileSummary, error: Error): ReviewDiffEntry {
  const loadStatus = error.message.includes("timed out") ? "timed-out" : "load-failed";
  return {
    ...file,
    diff: "",
    loadStatus,
    renderKey: `${file.revision ?? file.path}:error:${loadStatus}`,
    diffBytes: 0,
    diffError: error.message,
    canApplyPatchActions: false,
    changedBytes: 0,
    tooLarge: false,
    tooLargeReason: null,
  };
}

function mergeGitReviewFileWithPathDiff(
  file: GitReviewFileSummary,
  state: ReviewPathDiffState | undefined,
): GitReviewFileSummary {
  const source = state?.data ?? state?.error ?? null;
  if (!source) return file;

  const cached = gitReviewFilePathDiffCache.get(file);
  if (cached?.source === source) return cached.entry;

  const entry =
    state?.data !== null && state?.data !== undefined
      ? { ...file, ...state.data }
      : buildFailedGitReviewPathDiff(file, source as Error);
  gitReviewFilePathDiffCache.set(file, { source, entry });
  return entry;
}

function mergeGitSnapshotWithPathDiffs(
  snapshot: GitReviewSnapshot | null,
  pathDiffs: ReadonlyMap<string, ReviewPathDiffState>,
): GitReviewSnapshot | null {
  if (!snapshot) return null;

  const files = snapshot.files.map((file) =>
    mergeGitReviewFileWithPathDiff(file, pathDiffs.get(file.path)),
  );
  const cached = gitReviewSnapshotPathDiffCache.get(snapshot);
  if (
    cached?.files.length === files.length &&
    cached.files.every((file, index) => file === files[index])
  ) {
    return cached.snapshot;
  }

  const nextSnapshot = files.every((file, index) => file === snapshot.files[index])
    ? snapshot
    : { ...snapshot, files };
  gitReviewSnapshotPathDiffCache.set(snapshot, {
    files,
    snapshot: nextSnapshot,
  });
  return nextSnapshot;
}

const REVIEW_TOOLBAR_ICON_BUTTON_BASE_CLASS_NAME =
  "border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg border-transparent h-token-button-composer px-2 py-0 text-base leading-[18px] aspect-square items-center justify-center !px-0";
const REVIEW_TOOLBAR_ICON_BUTTON_IDLE_CLASS_NAME =
  "text-token-text-tertiary enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background";
const REVIEW_TOOLBAR_ICON_BUTTON_ACTIVE_CLASS_NAME =
  "text-token-foreground bg-token-foreground/5 enabled:hover:bg-token-foreground/10 data-[state=open]:bg-token-foreground/10";
const REVIEW_HEADER_ACTION_BUTTON_CLASS_NAME =
  "border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg border-token-border text-token-button-tertiary-foreground bg-token-bg-fog enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border h-token-button-composer px-2 py-0 text-base leading-[18px] min-w-0 px-2 enabled:text-token-foreground gap-0 [@container_review-header_(max-width:624px)]:aspect-square [@container_review-header_(max-width:624px)]:justify-center [@container_review-header_(max-width:624px)]:!px-0";
const REVIEW_HEADER_ACTION_LABEL_CLASS_NAME =
  "hidden [@container_review-header_(min-width:625px)]:inline min-w-0 shrink-0 whitespace-nowrap";
const REVIEW_FILE_ROW_SURFACE_STYLE = {
  "--codex-diffs-surface":
    "var(--codex-diffs-surface-override, var(--color-token-main-surface-primary))",
  backgroundColor: "var(--codex-diffs-surface)",
} satisfies CSSProperties & Record<`--${string}`, string>;
const REVIEW_FILE_ROW_HEADER_STYLE = {
  backgroundColor: "color-mix(in srgb, var(--codex-diffs-surface) 88%, transparent)",
} satisfies CSSProperties;

function toolbarIconButtonClassName(options?: {
  active?: boolean;
  extraClassName?: string;
}): string {
  return cn(
    REVIEW_TOOLBAR_ICON_BUTTON_BASE_CLASS_NAME,
    options?.active
      ? REVIEW_TOOLBAR_ICON_BUTTON_ACTIVE_CLASS_NAME
      : REVIEW_TOOLBAR_ICON_BUTTON_IDLE_CLASS_NAME,
    options?.extraClassName,
  );
}

function toolbarSourceButtonClassName(): string {
  return "border-token-border user-select-none no-drag cursor-interaction flex h-7 w-fit max-w-[320px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-transparent px-1.5 text-base leading-[18px] text-token-foreground outline-hidden enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background disabled:cursor-not-allowed disabled:opacity-40 electron:rounded-md";
}

function ReviewPanelEmptyState({
  title,
  description,
  illustration,
  action,
  className,
}: {
  title: string;
  description: string;
  illustration?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex w-full flex-col items-center justify-center px-3 py-6 h-full", className)}
    >
      <div className="flex w-full max-w-xl flex-col items-center justify-center text-center gap-6">
        {illustration ? (
          <div className="pointer-events-none text-token-input-placeholder-foreground">
            <div className="flex justify-center">{illustration}</div>
          </div>
        ) : null}
        <div className="flex flex-col items-center gap-2">
          <div className="font-medium text-base text-token-foreground">{title}</div>
          <div className="text-base text-token-description-foreground">{description}</div>
        </div>
        {action ? (
          <div className="flex w-full flex-wrap items-center justify-center gap-2">{action}</div>
        ) : null}
      </div>
    </div>
  );
}

function hashReviewDiffSourceKey(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function createReviewDiffCommentId(): string {
  return `review_comment_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ReviewDiffCommentAnnotationCard({
  metadata,
  value,
  readonly = false,
  onChange,
  onCancel,
  onSubmit,
  onDelete,
}: {
  metadata: ReviewDiffAnnotationMetadata;
  value: string;
  readonly?: boolean;
  onChange?: (value: string) => void;
  onCancel?: () => void;
  onSubmit?: (value: string) => void;
  onDelete?: () => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [metadata.key, value]);

  const lineLabel = formatReviewDiffCommentLineLabel({
    side: metadata.side,
    line: metadata.lineNumber,
    ...(metadata.startSide ? { startSide: metadata.startSide } : {}),
    ...(metadata.startLine ? { startLine: metadata.startLine } : {}),
  });
  const trimmedValue = draftValue.trim();
  const isLocalComment = metadata.kind === "local-comment";
  const authorLabel = metadata.kind === "model-comment" ? "Nodex" : "Local comment";
  const title = metadata.title?.trim() || authorLabel;

  return (
    <div className="flex w-full justify-center">
      <div
        className="w-full max-w-3xl min-w-0 gap-2 p-1.5 font-sans"
        data-review-diff-comment-card={metadata.kind}
      >
        <div className="group/comment overflow-hidden rounded-[12px] border border-token-border/14 bg-token-dropdown-background composer-surface-chrome">
          <div className="flex min-w-0 items-center gap-2 px-2.5 py-2">
            <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-token-foreground/8 text-[10px] font-medium text-token-description-foreground">
              {authorLabel === "Nodex" ? "N" : "L"}
            </div>
            <div className="min-w-0 truncate text-sm font-medium text-token-foreground">
              {title}
            </div>
            <div className="ml-auto shrink-0 text-xs text-token-description-foreground">
              {lineLabel}
            </div>
          </div>
          {readonly ? (
            <div className="px-2.5 pb-2 text-sm leading-5 text-token-foreground whitespace-pre-wrap">
              {value}
            </div>
          ) : (
            <>
              <div className="px-2.5 pb-2">
                <ComposerPromptEditor
                  value={draftValue}
                  placeholder="Request change"
                  disabled={false}
                  className="max-h-[25dvh] min-h-[52px] px-0 py-0 text-sm"
                  onChange={(nextValue) => {
                    setDraftValue(nextValue);
                    onChange?.(nextValue);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return false;
                    event.preventDefault();
                    onSubmit?.(draftValue);
                    return true;
                  }}
                />
              </div>
              <div className="flex items-center justify-end gap-1 border-t border-token-border/50 px-2.5 py-2">
                <button
                  type="button"
                  className="border-token-border no-drag cursor-interaction flex h-token-button-composer items-center gap-1 rounded-lg border border-transparent px-2 py-0 text-sm leading-[18px] text-token-text-tertiary select-none focus:outline-none enabled:hover:bg-token-list-hover-background enabled:hover:text-token-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={isLocalComment ? onDelete : onCancel}
                >
                  {isLocalComment ? "Delete" : "Cancel"}
                </button>
                <button
                  type="button"
                  className="border-token-border no-drag cursor-interaction flex h-token-button-composer items-center gap-1 rounded-lg border border-transparent bg-token-foreground px-2 py-0 text-sm leading-[18px] text-token-dropdown-background select-none focus:outline-none enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={trimmedValue.length === 0}
                  onClick={() => onSubmit?.(draftValue)}
                >
                  {isLocalComment ? "Save" : "Comment"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewFileDiffPlaceholder({ entry }: { entry: ReviewFileEntry }) {
  const message =
    entry.loadStatus === "loading" ? "Loading diff..." : describeReviewFileSafety(entry.safety);
  const detail =
    entry.loadStatus === "loading"
      ? "Preparing this file diff."
      : entry.safety.sizeBytes !== null
        ? `${entry.safety.sizeBytes.toLocaleString()} bytes`
        : entry.loadStatus === "diff-too-large"
          ? "Diff exceeds the review display limit."
          : "Text diff is not available for this file.";

  return (
    <div
      data-review-diff-placeholder={entry.loadStatus}
      className="px-3 py-6 text-sm text-token-description-foreground"
    >
      <div className="font-medium text-token-foreground">{message}</div>
      <div className="mt-1">{detail}</div>
    </div>
  );
}

interface ReviewFileRowProps {
  entry: ReviewFileEntry;
  diffMode: ReviewDiffMode;
  wrap: boolean;
  wordDiffsEnabled: boolean;
  ignoreWhitespace: boolean;
  loadFullFilesEnabled: boolean;
  canLoadFullContent: boolean;
  expanded: boolean;
  cwd: string | null;
  workspaceRoot: string | null;
  fullContentKey: string;
  loadFullContents: (entry: ReviewFileEntry) => Promise<ReviewFullFileContents>;
  comments: ReviewCodeComment[];
  threadId: string | null;
  sourceKey: string;
  pendingCommentAttachments: CodexReviewDiffCommentAttachment[];
  deps: ReviewDiffPanelDeps;
  onToggleExpandedKey: (key: string, canInheritExpanded: boolean) => void;
}

function areShallowArraysEqual<T>(left: T[], right: T[]): boolean {
  return (
    left === right ||
    (left.length === right.length && left.every((value, index) => value === right[index]))
  );
}

function buildStableReviewCommentAttachmentsByPath(
  attachments: CodexReviewDiffCommentAttachment[],
  previous: ReadonlyMap<string, CodexReviewDiffCommentAttachment[]>,
): ReadonlyMap<string, CodexReviewDiffCommentAttachment[]> {
  const grouped = new Map<string, CodexReviewDiffCommentAttachment[]>();
  for (const attachment of attachments) {
    const path = attachment.position.path;
    const bucket = grouped.get(path);
    if (bucket) {
      bucket.push(attachment);
      continue;
    }
    grouped.set(path, [attachment]);
  }

  let unchanged = grouped.size === previous.size;
  for (const [path, bucket] of grouped) {
    const previousBucket = previous.get(path);
    if (previousBucket && areShallowArraysEqual(bucket, previousBucket)) {
      grouped.set(path, previousBucket);
      continue;
    }
    unchanged = false;
  }

  return unchanged ? previous : grouped;
}

function areReviewFileEntriesEqual(left: ReviewFileEntry, right: ReviewFileEntry): boolean {
  return (
    left === right ||
    (left.key === right.key &&
      left.previousPath === right.previousPath &&
      left.gitStatus === right.gitStatus &&
      left.revision === right.revision &&
      left.oldOid === right.oldOid &&
      left.newOid === right.newOid &&
      left.patchText === right.patchText &&
      left.openPath === right.openPath &&
      left.openLine === right.openLine &&
      left.additions === right.additions &&
      left.deletions === right.deletions &&
      left.diffBytes === right.diffBytes &&
      left.changedBytes === right.changedBytes &&
      left.fileDiff === right.fileDiff &&
      left.loadStatus === right.loadStatus &&
      left.safety === right.safety &&
      left.generated === right.generated)
  );
}

function areReviewFileRowPropsEqual(left: ReviewFileRowProps, right: ReviewFileRowProps): boolean {
  return (
    areReviewFileEntriesEqual(left.entry, right.entry) &&
    left.diffMode === right.diffMode &&
    left.wrap === right.wrap &&
    left.wordDiffsEnabled === right.wordDiffsEnabled &&
    left.ignoreWhitespace === right.ignoreWhitespace &&
    left.loadFullFilesEnabled === right.loadFullFilesEnabled &&
    left.canLoadFullContent === right.canLoadFullContent &&
    left.expanded === right.expanded &&
    left.cwd === right.cwd &&
    left.workspaceRoot === right.workspaceRoot &&
    left.fullContentKey === right.fullContentKey &&
    left.loadFullContents === right.loadFullContents &&
    areShallowArraysEqual(left.comments, right.comments) &&
    left.threadId === right.threadId &&
    left.sourceKey === right.sourceKey &&
    areShallowArraysEqual(left.pendingCommentAttachments, right.pendingCommentAttachments) &&
    left.deps === right.deps &&
    left.onToggleExpandedKey === right.onToggleExpandedKey
  );
}

const ReviewFileRow = memo(function ReviewFileRow({
  entry,
  diffMode,
  wrap,
  wordDiffsEnabled,
  ignoreWhitespace,
  loadFullFilesEnabled,
  canLoadFullContent,
  expanded,
  cwd,
  workspaceRoot,
  fullContentKey,
  loadFullContents,
  comments,
  threadId,
  sourceKey,
  pendingCommentAttachments,
  deps,
  onToggleExpandedKey,
}: ReviewFileRowProps) {
  recordReviewRuntimeEvent({ type: "row-render", path: entry.displayPath });
  const { useTheme, FileDiff } = deps;
  const fileReferenceRouter = useFileReferenceRouter();
  const { resolved } = useTheme();
  const rowRef = useRef<HTMLElement | null>(null);
  const fullContentState = useReviewFullContentState(fullContentKey);
  const diffHostStyle = getNodexDiffHostStyle(resolved === "dark" ? "dark" : "light");
  const supportsWordDiffs = isReviewWordDiffEnabled(getReviewChangedLines(entry), true);
  const renderWordDiffs = supportsWordDiffs && wordDiffsEnabled;
  const lineDiffType = renderWordDiffs ? "word-alt" : "none";
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
  const [draftsByKey, setDraftsByKey] = useState<Record<string, ReviewDiffDraft>>({});
  const [draftStorageHydratedScope, setDraftStorageHydratedScope] = useState<string | null>(null);
  const hoveredLineRef = useRef<{
    side: ReviewDiffAnnotationSide;
    lineNumber: number;
  } | null>(null);
  const draftStorageScope = useMemo(
    () =>
      buildReviewDiffDraftStorageScope({
        threadId,
        sourceKey,
        path: entry.displayPath,
      }),
    [entry.displayPath, sourceKey, threadId],
  );
  const fileLevelComments = useMemo(() => comments.filter((comment) => !comment.start), [comments]);
  const modelLineComments = useMemo(
    () => comments.filter((comment) => typeof comment.start === "number" && comment.start > 0),
    [comments],
  );
  const pendingFileComments = pendingCommentAttachments;
  const existingAnnotationKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const comment of modelLineComments) {
      if (!comment.start) continue;
      const lineNumber = comment.end && comment.end !== comment.start ? comment.end : comment.start;
      keys.add(buildReviewDiffAnnotationKey("additions", lineNumber));
    }
    for (const attachment of pendingFileComments) {
      const side = mapReviewDiffPositionSideToAnnotationSide(attachment.position.side);
      keys.add(buildReviewDiffAnnotationKey(side, attachment.position.line));
    }
    return keys;
  }, [modelLineComments, pendingFileComments]);
  const draftKeys = useMemo(() => new Set(Object.keys(draftsByKey)), [draftsByKey]);

  useEffect(() => {
    const storedDrafts = readReviewDiffDraftStorage(draftStorageScope);
    setDraftsByKey(
      Object.fromEntries(
        Object.entries(storedDrafts).flatMap(([key, text]) => {
          const [side, rawLineNumber] = key.split(":");
          if ((side !== "additions" && side !== "deletions") || !rawLineNumber) return [];
          const lineNumber = Number(rawLineNumber);
          if (!Number.isFinite(lineNumber) || lineNumber <= 0) return [];
          const draft = createReviewDiffDraftFromLine({
            side,
            lineNumber,
            path: entry.displayPath,
            patchText: entry.patchText,
          });
          return [[key, { ...draft, text }]];
        }),
      ),
    );
    setDraftStorageHydratedScope(draftStorageScope);
  }, [draftStorageScope, entry.displayPath, entry.patchText]);

  useEffect(() => {
    if (draftStorageHydratedScope !== draftStorageScope) return;
    const persistedDrafts = Object.fromEntries(
      Object.entries(draftsByKey)
        .filter(([, draft]) => draft.text.length > 0)
        .map(([key, draft]) => [key, draft.text]),
    );
    writeReviewDiffDraftStorage(draftStorageScope, persistedDrafts);
  }, [draftStorageHydratedScope, draftStorageScope, draftsByKey]);

  const createDraft = useCallback(
    (draft: ReviewDiffDraft | null) => {
      if (!draft) return;
      if (
        shouldBlockReviewDiffDraft({
          key: draft.key,
          existingKeys: existingAnnotationKeys,
          draftKeys,
        })
      ) {
        return;
      }

      setDraftsByKey((current) => ({
        ...current,
        [draft.key]: draft,
      }));
    },
    [draftKeys, existingAnnotationKeys],
  );

  const createDraftFromRange = useCallback(
    (range: SelectedLineRange | null) => {
      if (!range) {
        setSelectedLines(null);
        return;
      }
      createDraft(
        createReviewDiffDraftFromRange({
          range,
          path: entry.displayPath,
          patchText: entry.patchText,
        }),
      );
      setSelectedLines(null);
    },
    [createDraft, entry.displayPath, entry.patchText],
  );

  const updateDraftText = useCallback((key: string, text: string) => {
    setDraftsByKey((current) => {
      const draft = current[key];
      if (!draft) return current;
      return {
        ...current,
        [key]: {
          ...draft,
          text,
        },
      };
    });
  }, []);

  const removeDraft = useCallback((key: string) => {
    setDraftsByKey((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const submitDraft = useCallback(
    (key: string, text: string) => {
      const draft = draftsByKey[key];
      const trimmedText = text.trim();
      if (!draft || trimmedText.length === 0) return;

      addReviewDiffCommentAttachment(
        threadId,
        buildReviewDiffCommentAttachment({
          id: createReviewDiffCommentId(),
          sessionKey: sourceKey,
          draft,
          text: trimmedText,
          createdAt: Date.now(),
        }),
      );
      removeDraft(key);
    },
    [draftsByKey, removeDraft, sourceKey, threadId],
  );

  const updateLocalComment = useCallback(
    (attachmentId: string, text: string) => {
      const attachment = pendingFileComments.find((candidate) => candidate.id === attachmentId);
      const trimmedText = text.trim();
      if (!attachment || trimmedText.length === 0) return;

      updateReviewDiffCommentAttachment(threadId, {
        ...attachment,
        content: [
          {
            content_type: "text",
            text: trimmedText,
          },
        ],
      });
    },
    [pendingFileComments, threadId],
  );

  const removeLocalComment = useCallback(
    (attachmentId: string) => {
      removeReviewDiffCommentAttachment(threadId, attachmentId);
    },
    [threadId],
  );

  const handleLineEnter = useCallback((props: OnDiffLineEnterLeaveProps) => {
    hoveredLineRef.current = {
      side: props.annotationSide,
      lineNumber: props.lineNumber,
    };
  }, []);

  const handleLineLeave = useCallback(() => {
    hoveredLineRef.current = null;
  }, []);

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const hoveredLine = hoveredLineRef.current;
      if (!hoveredLine) return;
      event.preventDefault();
      event.stopPropagation();

      const key = buildReviewDiffAnnotationKey(hoveredLine.side, hoveredLine.lineNumber);
      const enabled = !shouldBlockReviewDiffDraft({
        key,
        existingKeys: existingAnnotationKeys,
        draftKeys,
      });

      void showNativeContextMenu(
        [
          {
            id: "request-changes",
            label: "Request changes",
            enabled,
          },
        ],
        {
          x: event.clientX,
          y: event.clientY,
        },
      )
        .then((selectedId) => {
          if (selectedId !== "request-changes") return;
          createDraft(
            createReviewDiffDraftFromLine({
              side: hoveredLine.side,
              lineNumber: hoveredLine.lineNumber,
              path: entry.displayPath,
              patchText: entry.patchText,
            }),
          );
        })
        .catch(() => {});
    },
    [createDraft, draftKeys, entry.displayPath, entry.patchText, existingAnnotationKeys],
  );

  const lineAnnotations = useMemo<Array<DiffLineAnnotation<ReviewDiffAnnotationMetadata>>>(
    () => [
      ...modelLineComments.flatMap(
        (comment): Array<DiffLineAnnotation<ReviewDiffAnnotationMetadata>> => {
          if (!comment.start) return [];
          const lineNumber =
            comment.end && comment.end !== comment.start ? comment.end : comment.start;
          return [
            {
              side: "additions",
              lineNumber,
              metadata: {
                kind: "model-comment",
                key: buildReviewDiffAnnotationKey("additions", lineNumber),
                path: entry.displayPath,
                side: "additions",
                lineNumber,
                ...(comment.end && comment.end !== comment.start
                  ? { startLine: comment.start }
                  : {}),
                title: comment.title,
                body: comment.body,
                readonly: true,
              },
            },
          ];
        },
      ),
      ...pendingFileComments.map((attachment): DiffLineAnnotation<ReviewDiffAnnotationMetadata> => {
        const side = mapReviewDiffPositionSideToAnnotationSide(attachment.position.side);
        const startSide = attachment.position.start_side
          ? mapReviewDiffPositionSideToAnnotationSide(attachment.position.start_side)
          : undefined;
        return {
          side,
          lineNumber: attachment.position.line,
          metadata: {
            kind: "local-comment",
            key: buildReviewDiffAnnotationKey(side, attachment.position.line),
            path: entry.displayPath,
            side,
            lineNumber: attachment.position.line,
            ...(startSide ? { startSide } : {}),
            ...(attachment.position.start_line
              ? { startLine: attachment.position.start_line }
              : {}),
            attachmentId: attachment.id,
          },
        };
      }),
      ...Object.values(draftsByKey).map(buildReviewDiffDraftAnnotation),
    ],
    [draftsByKey, entry.displayPath, modelLineComments, pendingFileComments],
  );

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<ReviewDiffAnnotationMetadata>) => {
      const metadata = annotation.metadata;
      if (!metadata) return null;

      if (metadata.kind === "draft") {
        const draft = draftsByKey[metadata.key];
        return (
          <ReviewDiffCommentAnnotationCard
            metadata={metadata}
            value={draft?.text ?? ""}
            onChange={(nextValue) => updateDraftText(metadata.key, nextValue)}
            onCancel={() => removeDraft(metadata.key)}
            onSubmit={(nextValue) => submitDraft(metadata.key, nextValue)}
          />
        );
      }

      if (metadata.kind === "local-comment" && metadata.attachmentId) {
        const attachment = pendingFileComments.find(
          (candidate) => candidate.id === metadata.attachmentId,
        );
        return (
          <ReviewDiffCommentAnnotationCard
            metadata={metadata}
            value={attachment ? getReviewDiffCommentText(attachment) : ""}
            onSubmit={(nextValue) => updateLocalComment(metadata.attachmentId ?? "", nextValue)}
            onDelete={() => removeLocalComment(metadata.attachmentId ?? "")}
          />
        );
      }

      return (
        <ReviewDiffCommentAnnotationCard metadata={metadata} value={metadata.body ?? ""} readonly />
      );
    },
    [
      draftsByKey,
      pendingFileComments,
      removeDraft,
      removeLocalComment,
      submitDraft,
      updateDraftText,
      updateLocalComment,
    ],
  );

  const diffOptions = {
    ...getNodexReviewDiffOptions(resolved === "dark" ? "dark" : "light", true, {
      diffStyle: diffMode,
      wrap,
      lineDiffType,
      collapsed: !expanded,
    }),
    enableLineSelection: true,
    enableGutterUtility: true,
    lineHoverHighlight: "both" as const,
    onGutterUtilityClick: createDraftFromRange,
    onLineEnter: handleLineEnter,
    onLineLeave: handleLineLeave,
    onLineSelected: createDraftFromRange,
    onLineSelectionChange: setSelectedLines,
  } as NonNullable<FileDiffProps<ReviewDiffAnnotationMetadata>["options"]>;
  const shouldRequestFullContents =
    loadFullFilesEnabled &&
    canLoadFullContent &&
    expanded &&
    isTextualFullDiffCandidate(entry) &&
    fullContentState.fullDiffMetadata === null &&
    !fullContentState.fullContentLoadFailed &&
    !fullContentState.fullContentUnavailable &&
    !fullContentState.isLoadingFullContent;

  useEffect(() => {
    if (!shouldRequestFullContents) return;
    const row = rowRef.current;
    if (!row) return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((candidate) => candidate.isIntersecting)) return;
      observer.disconnect();
      void loadReviewFullContent({
        key: fullContentKey,
        identity: fullContentKey,
        load: () => loadFullContents(entry),
        expand: (contents) =>
          entry.fileDiff
            ? (() => {
                const metadata = expandPartialDiffMetadata(
                  entry.fileDiff,
                  splitReviewFileContents(contents.oldText ?? ""),
                  splitReviewFileContents(contents.newText ?? ""),
                  { ignoreWhitespace },
                );
                recordReviewRuntimeEvent({
                  type: "full-expansion",
                  path: entry.displayPath,
                  success: metadata !== null,
                });
                return metadata;
              })()
            : null,
      });
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [entry, fullContentKey, ignoreWhitespace, loadFullContents, shouldRequestFullContents]);

  const pendingFileDiff = useMemo(() => {
    if (!entry.fileDiff || !fullContentState.isLoadingFullContent) return null;
    return {
      ...entry.fileDiff,
      cacheKey: `${entry.fileDiff.cacheKey ?? entry.key}:pending-full`,
      lang: "text",
    } satisfies FileDiffMetadata;
  }, [entry.fileDiff, entry.key, fullContentState.isLoadingFullContent]);
  const renderedFileDiff = fullContentState.fullDiffMetadata ?? pendingFileDiff ?? entry.fileDiff;
  const presentationFileDiff = useMemo(() => {
    if (!renderedFileDiff || supportsWordDiffs) return renderedFileDiff;
    return {
      ...renderedFileDiff,
      cacheKey: `${renderedFileDiff.cacheKey ?? entry.key}:plain-text`,
      lang: "text",
    } satisfies FileDiffMetadata;
  }, [entry.key, renderedFileDiff, supportsWordDiffs]);
  const fullContentPhase = fullContentState.isLoadingFullContent
    ? "loading"
    : fullContentState.fullDiffMetadata
      ? "success"
      : fullContentState.fullContentLoadFailed
        ? "failed"
        : fullContentState.fullContentUnavailable
          ? "unavailable"
          : "partial";

  const openFile = (intent: "primary" | "durable" | "external" = "primary") => {
    if (!entry.openPath) return;
    const target = {
      path: entry.openPath,
      ...(entry.openLine ? { line: entry.openLine } : {}),
    };
    void fileReferenceRouter.open(target, {
      cwd,
      workspaceRoot,
      title: entry.displayPath,
      mode: intent === "durable" ? "durable" : "preview",
      ...(intent === "external" ? { external: true } : {}),
    });
  };

  return (
    <section
      ref={rowRef}
      data-review-path={entry.displayPath}
      data-review-full-content-state={fullContentPhase}
      className={cn(
        "group/file-diff flex flex-col overflow-clip codex-review-diff-card extension:rounded-lg",
        expanded && "pb-0.5",
      )}
      style={REVIEW_FILE_ROW_SURFACE_STYLE}
    >
      <div
        className="cursor-interaction select-none focus-visible:outline-none z-10 sticky top-0 backdrop-blur-sm"
        style={REVIEW_FILE_ROW_HEADER_STYLE}
        onClick={() => onToggleExpandedKey(entry.key, entry.gitStatus !== "deleted")}
      >
        <div>
          <div className="group/diff-header text-size-chat @container/diff-header relative flex items-center gap-2 py-0.5 ps-3 pe-2 hover:bg-token-list-hover-background bg-[color-mix(in_srgb,var(--color-token-main-surface-primary)_88%,transparent)] [.dark_&]:bg-[color-mix(in_srgb,var(--color-token-list-active-selection-background)_88%,transparent)] [.electron-dark_&]:bg-[color-mix(in_srgb,var(--color-token-list-active-selection-background)_88%,transparent)] mb-0.5">
            <div className="text-size-chat flex min-w-0 flex-1 items-center text-token-text-primary gap-0.5">
              <div className="flex min-w-0 items-center gap-2 pl-1">
                <FileTypeIcon path={entry.displayPath} />
                <span className="min-w-0" onClick={(event) => event.stopPropagation()}>
                  <FilenameButton
                    displayPath={entry.displayPath}
                    onOpen={entry.openPath ? openFile : null}
                    className="min-w-0 cursor-interaction truncate text-start text-token-text-primary select-text [direction:rtl]"
                  />
                </span>
              </div>
              <span className="shrink-0 opacity-0 group-focus-within/diff-header:opacity-100 group-hover/diff-header:opacity-100">
                <button
                  type="button"
                  data-app-action-review-file-expanded={String(expanded)}
                  data-app-action-review-file-toggle=""
                  className="border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg text-token-muted-foreground enabled:hover:bg-transparent data-[state=open]:bg-transparent hover:text-token-foreground border-transparent h-token-button-composer px-2 py-0 text-base leading-[18px] aspect-square items-center justify-center !px-0 bg-transparent text-token-foreground"
                  aria-label="Toggle file diff"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleExpandedKey(entry.key, entry.gitStatus !== "deleted");
                  }}
                >
                  <ReviewFileToggleChevronIcon
                    className={cn(
                      "icon-2xs transition-transform duration-150 motion-reduce:transition-none",
                      expanded ? "rotate-90" : "rotate-0",
                    )}
                  />
                </button>
              </span>
            </div>
            <div className="ms-auto flex items-center gap-0">
              <span className="flex shrink-0 items-center me-1">
                <DiffStats additions={entry.additions ?? 0} deletions={entry.deletions ?? 0} />
              </span>
              {entry.openPath ? (
                <button
                  type="button"
                  className="border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg text-token-muted-foreground enabled:hover:bg-transparent data-[state=open]:bg-transparent hover:text-token-foreground border-transparent h-token-button-composer px-2 py-0 text-base leading-[18px] aspect-square items-center justify-center !px-0 text-token-text-tertiary hover:text-token-text-primary"
                  aria-label="Open in"
                  onClick={(event) => {
                    event.stopPropagation();
                    openFile("external");
                  }}
                >
                  <ReviewOpenInIcon className="icon-2xs" />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <div
        className="bg-token-main-surface-primary"
        data-code="true"
        data-unified={diffMode === "unified" ? "true" : "false"}
        data-container-size="regular"
        onContextMenu={handleContextMenu}
      >
        {expanded && fileLevelComments.length > 0 ? (
          <div
            className="border-b border-token-border bg-token-list-hover-background/40 px-3 py-2"
            data-review-code-comments="true"
          >
            <div className="flex flex-col gap-2">
              {fileLevelComments.map((comment) => (
                <div
                  key={`${comment.file}:${comment.start ?? "file"}:${comment.title}:${comment.body}`}
                  className="grid grid-cols-[auto_1fr] gap-2 rounded-md border border-token-border/70 bg-token-main-surface-primary px-2.5 py-2 text-xs"
                >
                  <div className="text-token-description-foreground">
                    {comment.start
                      ? `L${comment.start}${comment.end && comment.end !== comment.start ? `-L${comment.end}` : ""}`
                      : "File"}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-medium text-token-foreground">
                      {comment.title}
                    </div>
                    <div className="text-token-description-foreground">{comment.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {presentationFileDiff ? (
          <FileDiff<ReviewDiffAnnotationMetadata>
            fileDiff={presentationFileDiff}
            className={NODEX_DIFF_HOST_CLASS}
            style={diffHostStyle}
            options={diffOptions}
            lineAnnotations={lineAnnotations}
            selectedLines={selectedLines}
            renderAnnotation={renderAnnotation}
          />
        ) : expanded ? (
          <ReviewFileDiffPlaceholder entry={entry} />
        ) : null}
      </div>
    </section>
  );
}, areReviewFileRowPropsEqual);

interface ReviewFileTreePaneProps {
  rows: ReviewFileTreeRow<ReviewFileEntry>[];
  fileFilter: string;
  onFileFilterChange: (value: string) => void;
  selectedTreeItemId: string | null;
  focusedTreeItemId: string | null;
  onSelectTreeItemId: (itemId: string) => void;
  onFocusTreeItemId: (itemId: string) => void;
  onSelectPath: (path: string) => void;
  onToggleDirectory: (path: string) => void;
}

function ReviewFileTreeFlattenedLabel({ row }: { row: ReviewFileTreeRow<ReviewFileEntry> }) {
  if (row.flattenedParts.length === 0) {
    return row.label;
  }

  return (
    <span data-item-flattened-subitems="true">
      {row.hasLeadingSlash ? (
        <>
          <span data-item-flattened-subitem={row.flattenedParts[0]?.id ?? "root"} />
          {" / "}
        </>
      ) : null}
      {row.flattenedParts.map((part, index) => (
        <span key={part.id}>
          <span data-item-flattened-subitem={part.id}>{part.label}</span>
          {index === row.flattenedParts.length - 1 ? null : " / "}
        </span>
      ))}
    </span>
  );
}

function ReviewFileTreePane({
  rows,
  fileFilter,
  onFileFilterChange,
  selectedTreeItemId,
  focusedTreeItemId,
  onSelectTreeItemId,
  onFocusTreeItemId,
  onSelectPath,
  onToggleDirectory,
}: ReviewFileTreePaneProps) {
  const treeDomId = "review-file-tree";
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [range, setRange] = useState<ReviewFileTreeVirtualRange>({
    start: 0,
    end: -1,
  });
  const [itemHeight, setItemHeight] = useState(REVIEW_FILE_TREE_FALLBACK_ITEM_HEIGHT_PX);
  const [viewportHeight, setViewportHeight] = useState(0);
  const isVirtualized = isReviewFileTreeVirtualizationEnabled(
    rows.length,
    REVIEW_FILE_TREE_VIRTUALIZE_THRESHOLD,
  );
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  const selectedIndex = useMemo(
    () => resolveReviewFileTreeSelectedVisibleIndex(rows, focusedTreeItemId ?? selectedTreeItemId),
    [focusedTreeItemId, rows, selectedTreeItemId],
  );
  const layout = useMemo(
    () =>
      getReviewFileTreeVirtualLayout({
        range,
        itemCount: rows.length,
        itemHeight,
        viewportHeight,
      }),
    [itemHeight, range, rows.length, viewportHeight],
  );
  const visibleRows = useMemo(() => {
    if (!isVirtualized) return rows.map((row, index) => ({ row, index }));
    if (range.end < range.start) return [];
    return rows.slice(range.start, range.end + 1).map((row, offset) => ({
      row,
      index: range.start + offset,
    }));
  }, [isVirtualized, range.end, range.start, rows]);

  useEffect(() => {
    if (!isVirtualized) return;

    const scrollNode = scrollRef.current;
    const listNode = listRef.current;
    if (!scrollNode || !listNode) return;

    const syncMeasurements = () => {
      const nextItemHeight = resolveReviewFileTreeItemHeight(listNode);
      const nextViewportHeight = scrollNode.clientHeight;
      const nextOffset = getReviewFileTreeOffset(listNode, scrollNode);

      setItemHeight((current) => (current === nextItemHeight ? current : nextItemHeight));
      setViewportHeight((current) =>
        current === nextViewportHeight ? current : nextViewportHeight,
      );
      setRange((current) => {
        const nextRange = getReviewFileTreeVirtualRange(
          {
            scrollTop: scrollNode.scrollTop,
            viewportHeight: nextViewportHeight,
            offset: nextOffset,
            itemCount: rows.length,
            itemHeight: nextItemHeight,
            overscan: REVIEW_FILE_TREE_VIRTUAL_OVERSCAN,
          },
          current,
        );
        return areReviewFileTreeRangesEqual(current, nextRange) ? current : nextRange;
      });
    };

    const handleScroll = () => {
      syncMeasurements();
      if (!("isScrolling" in listNode.dataset)) {
        listNode.dataset.isScrolling = "";
      }
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
      }
      scrollTimerRef.current = setTimeout(() => {
        delete listNode.dataset.isScrolling;
        scrollTimerRef.current = null;
      }, 50);
    };

    syncMeasurements();
    scrollNode.addEventListener("scroll", handleScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncMeasurements);
    observer?.observe(scrollNode);

    return () => {
      scrollNode.removeEventListener("scroll", handleScroll);
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
      delete listNode.dataset.isScrolling;
      observer?.disconnect();
    };
  }, [isVirtualized, rows.length]);

  useEffect(() => {
    if (!isVirtualized) return;
    if (selectedIndex < 0) return;

    const scrollNode = scrollRef.current;
    const listNode = listRef.current;
    if (!scrollNode || !listNode) return;

    const offset = getReviewFileTreeOffset(listNode, scrollNode);

    const nextScrollTop = getReviewFileTreeScrollTopForIndex({
      scrollTop: scrollNode.scrollTop,
      viewportHeight: scrollNode.clientHeight,
      offset,
      itemHeight,
      index: selectedIndex,
    });
    if (nextScrollTop === scrollNode.scrollTop) return;

    scrollNode.scrollTop = nextScrollTop;
    setRange((current) =>
      getReviewFileTreeVirtualRange(
        {
          scrollTop: nextScrollTop,
          viewportHeight: scrollNode.clientHeight,
          offset,
          itemCount: rows.length,
          itemHeight,
          overscan: REVIEW_FILE_TREE_VIRTUAL_OVERSCAN,
        },
        current,
      ),
    );
  }, [isVirtualized, itemHeight, rows.length, selectedIndex]);

  const highlightedAncestorIds = useMemo(() => {
    const activeRow = rowById.get(focusedTreeItemId ?? selectedTreeItemId ?? "");
    return new Set(activeRow?.ancestorIds ?? []);
  }, [focusedTreeItemId, rowById, selectedTreeItemId]);

  const focusOrSelectTreeRow = (row: ReviewFileTreeRow<ReviewFileEntry>) => {
    onFocusTreeItemId(row.id);
    onSelectTreeItemId(row.id);
    if (row.type === "file") {
      onSelectPath(row.path);
      return;
    }
    onToggleDirectory(row.path);
  };

  const moveTreeSelection = (direction: -1 | 1) => {
    const currentIndex = rows.findIndex(
      (row) => row.id === (focusedTreeItemId ?? selectedTreeItemId),
    );
    const fallbackIndex = direction > 0 ? 0 : rows.length - 1;
    const nextIndex =
      currentIndex === -1
        ? fallbackIndex
        : Math.min(Math.max(currentIndex + direction, 0), rows.length - 1);
    const nextRow = rows[nextIndex];
    if (!nextRow) return;
    onFocusTreeItemId(nextRow.id);
    onSelectTreeItemId(nextRow.id);
    if (nextRow.type === "file") {
      onSelectPath(nextRow.path);
    }
  };

  const handleTreeRowKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    row: ReviewFileTreeRow<ReviewFileEntry>,
  ) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveTreeSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveTreeSelection(-1);
      return;
    }
    if (event.key === "ArrowRight" && row.type === "folder" && !row.isExpanded) {
      event.preventDefault();
      onFocusTreeItemId(row.id);
      onSelectTreeItemId(row.id);
      onToggleDirectory(row.path);
      return;
    }
    if (event.key === "ArrowLeft" && row.type === "folder" && row.isExpanded) {
      event.preventDefault();
      onFocusTreeItemId(row.id);
      onSelectTreeItemId(row.id);
      onToggleDirectory(row.path);
      return;
    }
    if (event.key === "ArrowLeft") {
      const parentId = row.ancestorIds.at(-1);
      if (!parentId) return;
      event.preventDefault();
      onFocusTreeItemId(parentId);
      onSelectTreeItemId(parentId);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      const nextRow = rows[0];
      if (!nextRow) return;
      onFocusTreeItemId(nextRow.id);
      onSelectTreeItemId(nextRow.id);
      if (nextRow.type === "file") {
        onSelectPath(nextRow.path);
      }
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const nextRow = rows.at(-1);
      if (!nextRow) return;
      onFocusTreeItemId(nextRow.id);
      onSelectTreeItemId(nextRow.id);
      if (nextRow.type === "file") {
        onSelectPath(nextRow.path);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      focusOrSelectTreeRow(row);
    }
  };

  const getTreeStatusSlot = (row: ReviewFileTreeRow<ReviewFileEntry>) => {
    if (row.gitStatus === "added") return "A";
    if (row.gitStatus === "deleted") return "D";
    return null;
  };

  const treeRows = visibleRows.map(({ row }) => {
    const indentationDepth = Math.max(0, row.level - 1);
    const statusSlot = getTreeStatusSlot(row);
    const buttonDomId = `${treeDomId}-${row.id}`;
    return (
      <button
        key={row.id}
        type="button"
        role="treeitem"
        aria-setsize={row.siblingCount}
        aria-posinset={row.siblingIndex}
        aria-selected={row.isSelected ? "true" : "false"}
        aria-label={row.path}
        aria-level={row.level}
        aria-expanded={row.type === "folder" ? row.isExpanded : undefined}
        tabIndex={row.isFocused ? 0 : -1}
        data-type="item"
        data-item-type={row.type}
        data-item-id={row.id}
        id={buttonDomId}
        data-review-tree-item="true"
        data-review-tree-path={row.path}
        data-item-selected={row.isSelected ? "true" : undefined}
        data-item-focused={row.isFocused ? "true" : undefined}
        data-item-search-match={row.isSearchMatch ? "true" : undefined}
        data-item-git-status={row.gitStatus ?? undefined}
        data-item-contains-git-change={row.containsGitChange ? "true" : undefined}
        data-item-locked={row.isLocked ? "true" : undefined}
        className={cn(
          "border-none relative mx-[var(--trees-item-margin-x)] flex w-full items-center gap-[var(--trees-item-row-gap)] rounded-[var(--trees-border-radius)] bg-token-main-surface-primary text-left outline-none",
          row.type === "file" && !row.isSelected
            ? "text-[var(--trees-file-fg)]"
            : "text-[var(--trees-fg)]",
          row.isSelected
            ? "bg-token-list-active-selection-background text-[var(--trees-selected-fg)] z-[3]"
            : "hover:bg-token-list-hover-background",
          row.isFocused
            ? "outline outline-1 -outline-offset-1 outline-token-list-focus-outline z-[2]"
            : undefined,
          row.isFocused && row.isSelected ? "outline-token-list-focus-outline" : undefined,
        )}
        style={{
          height: "var(--trees-row-height)",
          lineHeight: "var(--trees-row-height)",
          fontSize: "var(--trees-font-size)",
          paddingInline: "var(--trees-item-padding-x)",
        }}
        onFocus={() => onFocusTreeItemId(row.id)}
        onClick={() => focusOrSelectTreeRow(row)}
        onKeyDown={(event) => handleTreeRowKeyDown(event, row)}
      >
        {indentationDepth > 0 ? (
          <div
            data-item-section="spacing"
            className="flex items-center justify-center empty:pl-0"
            style={{
              height: "var(--trees-row-height)",
              paddingLeft: "calc(calc(var(--trees-icon-width) / 2) - 0.5px)",
            }}
          >
            {Array.from({ length: indentationDepth }).map((_, spacingIndex) => (
              <div
                key={`${row.id}:spacing:${spacingIndex + 1}`}
                data-item-section="spacing-item"
                data-ancestor-id={
                  row.ancestorIds[spacingIndex] ?? `${row.id}:ancestor:${spacingIndex + 1}`
                }
                data-ancestor-active={
                  highlightedAncestorIds.has(row.ancestorIds[spacingIndex] ?? "")
                    ? "true"
                    : undefined
                }
                className={cn(
                  "inline-block h-full shrink-0 translate-x-[-0.25px] border-l opacity-0 transition-opacity duration-150 ease-in group-hover/review-file-tree:opacity-75",
                  highlightedAncestorIds.has(row.ancestorIds[spacingIndex] ?? "")
                    ? "opacity-100"
                    : undefined,
                )}
                style={{
                  borderLeftColor: "var(--trees-indent-guide-bg)",
                  width: "0px",
                  marginRight: "calc(var(--trees-level-gap) - 1px)",
                  marginLeft:
                    spacingIndex === 0
                      ? undefined
                      : "calc(var(--trees-item-row-gap) + calc(var(--trees-icon-width) / 2) - 0.5px)",
                }}
              />
            ))}
          </div>
        ) : null}
        <div
          data-item-section="icon"
          className={cn(
            "flex shrink-0 items-center justify-center text-[var(--trees-fg-muted)]",
            row.isSelected ? "text-[var(--trees-selected-fg)]" : undefined,
          )}
          style={{ width: "var(--trees-icon-width)" }}
        >
          {row.type === "folder" ? (
            <FileTreeChevronIcon
              className={cn(
                "size-4 transition-transform",
                row.isExpanded ? undefined : "-rotate-90",
              )}
            />
          ) : (
            <FileTypeIcon path={row.path} />
          )}
        </div>
        <div
          data-item-section="content"
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            row.type === "folder"
              ? "text-[var(--trees-fg)]"
              : row.isSelected
                ? "text-[var(--trees-selected-fg)]"
                : "text-[var(--trees-file-fg)]",
          )}
        >
          {row.type === "folder" ? <ReviewFileTreeFlattenedLabel row={row} /> : row.label}
        </div>
        {statusSlot ? (
          <div
            data-item-section="git"
            className={cn(
              "flex w-3 shrink-0 items-center justify-center text-center",
              row.gitStatus === "added" ? "text-token-charts-green" : undefined,
              row.gitStatus === "deleted" ? "text-token-charts-red" : undefined,
              row.gitStatus ? "text-[11px] font-semibold leading-none" : undefined,
            )}
          >
            {statusSlot}
          </div>
        ) : null}
        {row.isLocked ? (
          <div
            data-item-section="lock"
            className="ml-auto flex shrink-0 items-center text-token-description-foreground"
          >
            <FileTreeLockIcon />
          </div>
        ) : null}
      </button>
    );
  });

  return (
    <div
      className="group/review-file-tree flex h-full min-h-0 flex-col bg-token-main-surface-primary"
      data-file-tree-virtualized-wrapper={isVirtualized ? "true" : undefined}
      style={{
        ...(REVIEW_FILE_TREE_HOST_STYLE as CSSProperties),
        ...RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE,
      }}
    >
      <div data-file-tree-search-container="true" className="shrink-0 px-2 pt-2 pb-px">
        <label className="sr-only" htmlFor={REVIEW_FILE_TREE_SEARCH_INPUT_ID}>
          Filter files
        </label>
        <div className="relative flex h-token-button-composer w-full items-center gap-1.5 rounded-lg border border-token-border bg-token-bg-fog text-base leading-[18px]">
          <SearchIcon className="icon-xs ms-2 shrink-0 text-token-input-placeholder-foreground" />
          <input
            id={REVIEW_FILE_TREE_SEARCH_INPUT_ID}
            value={fileFilter}
            onChange={(event) => onFileFilterChange(event.target.value)}
            placeholder="Filter files…"
            data-file-tree-search-input="true"
            aria-controls={treeDomId}
            aria-activedescendant={
              focusedTreeItemId ? `${treeDomId}-${focusedTreeItemId}` : undefined
            }
            className="w-full appearance-none border-none bg-transparent py-0 ps-0 pe-1.5 text-token-foreground ring-0 outline-none select-text placeholder:text-token-input-placeholder-foreground focus:border-none focus:ring-0 focus:outline-none [&::placeholder]:select-none"
          />
          {fileFilter.length > 0 ? (
            <button
              type="button"
              aria-label="Clear file filter"
              className="flex size-7 shrink-0 cursor-interaction items-center justify-center rounded-md text-token-input-placeholder-foreground hover:text-token-foreground"
              onClick={() => onFileFilterChange("")}
            >
              <CloseIcon className="icon-2xs" />
            </button>
          ) : null}
        </div>
      </div>
      <div
        className={cn(
          "bg-token-main-surface-primary min-h-0 flex-1 overflow-x-hidden overflow-y-auto",
          isVirtualized ? "flex flex-col overflow-hidden" : undefined,
        )}
        data-file-tree-virtualized-root={isVirtualized ? "true" : undefined}
      >
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-token-main-surface-primary px-2"
          data-file-tree-virtualized-scroll={isVirtualized ? "true" : undefined}
          style={RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE}
        >
          {rows.length === 0 ? (
            <div className="py-2 text-sm text-token-description-foreground">No matching files</div>
          ) : isVirtualized ? (
            <div
              ref={listRef}
              role="tree"
              id={treeDomId}
              className="relative min-h-full w-full [overflow-anchor:none]"
              data-file-tree-virtualized-list="true"
            >
              <div
                data-file-tree-virtualized-sticky-offset="true"
                aria-hidden="true"
                style={{ height: layout.offsetHeight }}
              />
              <div
                className="sticky flex flex-col"
                data-file-tree-virtualized-sticky="true"
                style={{
                  height: layout.windowHeight,
                  top: layout.stickyInset,
                  bottom: layout.stickyInset,
                }}
              >
                {treeRows}
              </div>
            </div>
          ) : (
            <div role="tree" id={treeDomId} className="flex flex-col">
              {treeRows}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ReviewDiffPanel({
  conversationProjection,
  onStartThreadPrompt,
  threadId,
  projectWorkspacePath,
  selectedTurnDiff = null,
  initialSource = "last-turn",
  initialCommitSha = null,
  initialFileTreeOpen = false,
  deps,
}: ReviewDiffPanelProps) {
  const resolvedDeps = useMemo(
    () => ({
      ...DEFAULT_REVIEW_DIFF_PANEL_DEPS,
      ...deps,
    }),
    [deps],
  );
  const { invoke, parsePatchFiles } = resolvedDeps;
  const gitWorkerClient = resolvedDeps.gitWorkerClient ?? getGitWorkerClient();
  const reviewConversation = conversationProjection;
  const reviewContentRootRef = useRef<HTMLDivElement | null>(null);
  const reviewSplitRootRef = useRef<HTMLDivElement | null>(null);
  const [preferences, setPreferences] = useScopedAtom(reviewDiffPreferencesAtom);
  const [routeState, setRouteState] = useScopedAtom(reviewRouteStateAtom);
  const initializeRouteState = useSetScopedAtom(initializeReviewRouteStateAtom);
  const acknowledgeReveal = useSetScopedAtom(acknowledgeReviewRevealAtom);
  const {
    diffMode,
    hideWhitespace,
    wrap,
    wordDiffsEnabled,
    richPreviewEnabled,
    loadFullFilesEnabled,
  } = preferences;
  const { source, commitSha, fileTreeOpen, fileTreeWidth, fileFilter, selectedPath } = routeState;
  const updatePreference = useCallback(
    <Key extends keyof typeof preferences>(
      key: Key,
      update: SetStateAction<(typeof preferences)[Key]>,
    ) => {
      setPreferences((current) => ({
        ...current,
        [key]: resolveStateUpdate(current[key], update),
      }));
    },
    [setPreferences],
  );
  const updateRouteState = useCallback(
    <Key extends keyof ReviewRouteState>(
      key: Key,
      update: SetStateAction<ReviewRouteState[Key]>,
    ) => {
      setRouteState((current) => ({
        ...current,
        [key]: resolveStateUpdate(current[key], update),
      }));
    },
    [setRouteState],
  );
  const setDiffMode = useCallback(
    (update: SetStateAction<ReviewDiffMode>) => updatePreference("diffMode", update),
    [updatePreference],
  );
  const setHideWhitespace = useCallback(
    (update: SetStateAction<boolean>) => updatePreference("hideWhitespace", update),
    [updatePreference],
  );
  const setWrap = useCallback(
    (update: SetStateAction<boolean>) => updatePreference("wrap", update),
    [updatePreference],
  );
  const setWordDiffsEnabled = useCallback(
    (update: SetStateAction<boolean>) => updatePreference("wordDiffsEnabled", update),
    [updatePreference],
  );
  const setRichPreviewEnabled = useCallback(
    (update: SetStateAction<boolean>) => updatePreference("richPreviewEnabled", update),
    [updatePreference],
  );
  const setLoadFullFilesEnabled = useCallback(
    (update: SetStateAction<boolean>) => updatePreference("loadFullFilesEnabled", update),
    [updatePreference],
  );
  const setSource = useCallback(
    (update: SetStateAction<ReviewSource>) => updateRouteState("source", update),
    [updateRouteState],
  );
  const setFileTreeOpen = useCallback(
    (update: SetStateAction<boolean>) => updateRouteState("fileTreeOpen", update),
    [updateRouteState],
  );
  const setFileTreeWidth = useCallback(
    (update: SetStateAction<number>) => updateRouteState("fileTreeWidth", update),
    [updateRouteState],
  );
  const setFileFilter = useCallback(
    (update: SetStateAction<string>) => updateRouteState("fileFilter", update),
    [updateRouteState],
  );
  const setSelectedPath = useCallback(
    (update: SetStateAction<CanonicalReviewPath | null>) =>
      updateRouteState("selectedPath", update),
    [updateRouteState],
  );
  const [jumpToFileQuery, setJumpToFileQuery] = useState("");
  const deferredFileFilter = useDeferredValue(fileFilter);
  const deferredJumpToFileQuery = useDeferredValue(jumpToFileQuery);
  const expandedDirectoryPaths = useMemo(
    () => new Set(routeState.expandedDirectoryPaths),
    [routeState.expandedDirectoryPaths],
  );
  const setExpandedDirectoryPaths = useCallback(
    (update: SetStateAction<Set<string>>) => {
      setRouteState((current) => ({
        ...current,
        expandedDirectoryPaths: [
          ...resolveStateUpdate(new Set(current.expandedDirectoryPaths), update),
        ],
      }));
    },
    [setRouteState],
  );
  const [selectedTreeItemId, setSelectedTreeItemId] = useState<string | null>(null);
  const [focusedTreeItemId, setFocusedTreeItemId] = useState<string | null>(null);
  const [branchCommitsRequested, setBranchCommitsRequested] = useState(false);
  const diffExpansionOverrides = useMemo(
    () =>
      new Map(
        routeState.diffExpansionOverrides.map((override) => [override.key, override.expanded]),
      ),
    [routeState.diffExpansionOverrides],
  );
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const navigationRevealControllerRef = useRef<AbortController | null>(null);
  const reviewCommentsByPathCacheRef = useRef<{
    comments: ReviewCodeComment[];
    pathsIdentity: string;
    value: Map<string, ReviewCodeComment[]>;
  } | null>(null);
  const pendingReviewCommentsByPathRef = useRef<
    ReadonlyMap<string, CodexReviewDiffCommentAttachment[]>
  >(new Map());
  const queryClient = useQueryClient();
  const gitLiveQueryCoordinator = useMemo(
    () => getGitLiveQueryCoordinator(queryClient, gitWorkerClient),
    [gitWorkerClient, queryClient],
  );
  const reviewThreadId = reviewConversation.threadId ?? threadId ?? null;
  const pendingReviewCommentAttachments = useReviewDiffCommentAttachments(reviewThreadId);

  const reviewCwd = isTranscriptReviewSource(source)
    ? source === "selected-turn"
      ? (selectedTurnDiff?.cwd ?? reviewConversation.cwd ?? projectWorkspacePath ?? null)
      : (reviewConversation.cwd ?? projectWorkspacePath ?? null)
    : (projectWorkspacePath ?? reviewConversation.cwd ?? null);

  useEffect(() => {
    clearContentSearchMarks(reviewContentRootRef.current, {
      includeShadowRoots: true,
    });
  }, [reviewConversation.threadId]);

  useEffect(() => {
    initializeRouteState({
      source: initialSource,
      commitSha: initialCommitSha,
      fileTreeOpen: initialFileTreeOpen,
    });
  }, [initialCommitSha, initialFileTreeOpen, initialSource, initializeRouteState]);

  useEffect(() => {
    if (source !== "commit" || commitSha) return;
    setSource("branch");
  }, [commitSha, setSource, source]);

  const selectReviewSource = (nextSource: ReviewSource) => {
    startTransition(() => {
      setRouteState((current) => ({
        ...current,
        source: nextSource,
        selectedTurn: nextSource === "selected-turn" ? current.selectedTurn : null,
        transcriptThreadId: nextSource === "selected-turn" ? current.transcriptThreadId : null,
        commitSha: nextSource === "commit" ? current.commitSha : null,
        branchBaseRef: nextSource === "branch" ? current.branchBaseRef : null,
        selectedPath: null,
        pendingReveal: null,
      }));
      setSelectedTreeItemId(null);
      setFocusedTreeItemId(null);
    });
  };

  const selectReviewCommit = (commit: GitReviewBranchCommit) => {
    startTransition(() => {
      setRouteState((current) => ({
        ...current,
        source: "commit",
        selectedTurn: null,
        transcriptThreadId: null,
        commitSha: commit.sha,
        branchBaseRef: null,
        selectedPath: null,
        pendingReveal: null,
      }));
      setSelectedTreeItemId(null);
      setFocusedTreeItemId(null);
    });
  };

  const normalizedGitCwd = reviewCwd?.trim() ?? "";
  const metadataQueryEnabled = normalizedGitCwd.length > 0;
  const gitQueryEnabled = isGitReviewSource(source) && normalizedGitCwd.length > 0;
  const gitReviewSource: GitReviewSource = isGitReviewSource(source) ? source : "unstaged";
  const gitRepositoryMetadataInput = useMemo(
    () => ({
      method: "stable-metadata" as const,
      params: { cwd: normalizedGitCwd },
    }),
    [normalizedGitCwd],
  );
  const gitRepositoryMetadataOptions = useMemo(
    () => createGitLiveWorkerQuery(gitRepositoryMetadataInput, gitWorkerClient),
    [gitRepositoryMetadataInput, gitWorkerClient],
  );
  const gitRepositoryMetadataQueryKey = gitRepositoryMetadataOptions.queryKey;
  const gitRepositoryMetadataQuery = useQuery({
    ...gitRepositoryMetadataOptions,
    enabled: metadataQueryEnabled,
  });
  const transcriptSnapshot = useMemo(() => {
    if (source === "last-turn") {
      return buildLastTurnSnapshot(
        reviewConversation,
        projectWorkspacePath,
        parsePatchFiles,
        gitRepositoryMetadataQuery.data?.isGitRepository === true,
      );
    }
    if (source === "selected-turn") {
      return buildSelectedTurnSnapshot(
        selectedTurnDiff,
        reviewConversation,
        projectWorkspacePath,
        parsePatchFiles,
        gitRepositoryMetadataQuery.data?.isGitRepository === true,
      );
    }
    return null;
  }, [
    gitRepositoryMetadataQuery.data?.isGitRepository,
    parsePatchFiles,
    projectWorkspacePath,
    reviewConversation,
    selectedTurnDiff,
    source,
  ]);
  const gitRepositoryIdentity = useMemo<GitQueryRepositoryIdentity | null>(() => {
    const metadata = gitRepositoryMetadataQuery.data;
    if (!metadata?.isGitRepository || !metadata.commonDir || !metadata.root) {
      return null;
    }
    return {
      hostId: "local",
      commonDir: metadata.commonDir,
      root: metadata.root,
    };
  }, [gitRepositoryMetadataQuery.data]);
  const gitRequestCwd = gitRepositoryMetadataQuery.data?.root ?? normalizedGitCwd;
  const gitBaseBranchInput = useMemo(
    () => ({
      method: "base-branch" as const,
      params: { cwd: gitRequestCwd },
      repository: gitRepositoryIdentity,
    }),
    [gitRepositoryIdentity, gitRequestCwd],
  );
  const gitBaseBranchOptions = useMemo(
    () => createGitLiveWorkerQuery(gitBaseBranchInput, gitWorkerClient),
    [gitBaseBranchInput, gitWorkerClient],
  );
  const gitBaseBranchQuery = useQuery({
    ...gitBaseBranchOptions,
    enabled: gitQueryEnabled && gitRepositoryIdentity !== null,
  });
  const resolvedBaseBranch =
    routeState.branchBaseRef ??
    gitBaseBranchQuery.data?.remote ??
    gitBaseBranchQuery.data?.local ??
    gitRepositoryMetadataQuery.data?.defaultBranch ??
    null;
  const gitSummaryBaseBranch = source === "branch" ? resolvedBaseBranch : null;
  const gitSummaryInput = useMemo(
    () => ({
      method: "review-summary" as const,
      params: {
        cwd: gitRequestCwd,
        source: gitReviewSource,
        baseBranch: gitSummaryBaseBranch,
        commitSha: gitReviewSource === "commit" ? commitSha : null,
        hideWhitespace,
        includeUntrackedFiles: true,
      },
      repository: gitRepositoryIdentity,
    }),
    [
      commitSha,
      gitRepositoryIdentity,
      gitRequestCwd,
      gitReviewSource,
      gitSummaryBaseBranch,
      hideWhitespace,
    ],
  );
  const gitSummaryOptions = useMemo(
    () => createGitLiveWorkerQuery(gitSummaryInput, gitWorkerClient),
    [gitSummaryInput, gitWorkerClient],
  );
  const gitSummaryQueryKey = gitSummaryOptions.queryKey;
  const gitSummaryQuery = useQuery({
    ...gitSummaryOptions,
    enabled:
      gitQueryEnabled &&
      gitRepositoryIdentity !== null &&
      (source !== "branch" || gitBaseBranchQuery.data !== undefined),
  });
  const gitSummarySnapshot = useMemo(() => {
    if (!gitQueryEnabled || !gitSummaryQuery.data) return null;
    const metadata = gitRepositoryMetadataQuery.data;
    if (!metadata) return null;
    if (gitSummaryQuery.data.type !== "success") {
      return {
        cwd: metadata.root ?? metadata.cwd,
        source: gitReviewSource,
        patch: "",
        files: [],
        isGitRepository: metadata.isGitRepository,
        baseRef: source === "branch" ? resolvedBaseBranch : null,
        currentBranch: metadata.currentBranch,
        defaultBranch: metadata.defaultBranch,
        errorMessage:
          gitSummaryQuery.data.type === "error"
            ? gitSummaryQuery.data.errorMessage
            : "The repository changed while loading this review.",
        snapshotGeneration: 0,
      } satisfies GitReviewSnapshot;
    }
    return {
      cwd: metadata.root ?? metadata.cwd,
      source: gitReviewSource,
      patch: "",
      files: gitSummaryQuery.data.files,
      isGitRepository: metadata.isGitRepository,
      baseRef: source === "branch" ? resolvedBaseBranch : null,
      currentBranch: metadata.currentBranch,
      defaultBranch: metadata.defaultBranch,
      errorMessage: metadata.errorMessage,
      snapshotGeneration: gitSummaryQuery.data.snapshotGeneration,
    } satisfies GitReviewSnapshot;
  }, [
    gitQueryEnabled,
    gitRepositoryMetadataQuery.data,
    gitSummaryQuery.data,
    gitReviewSource,
    resolvedBaseBranch,
    source,
  ]);
  const branchCommitsBaseBranch = gitSummarySnapshot?.baseRef ?? resolvedBaseBranch ?? null;
  const branchCommitsInput = useMemo(
    () => ({
      method: "branch-commits" as const,
      params: {
        cwd: gitRequestCwd,
        baseBranch: branchCommitsBaseBranch,
        operationSource: "review_model" as const,
      },
      repository: gitRepositoryIdentity,
    }),
    [branchCommitsBaseBranch, gitRepositoryIdentity, gitRequestCwd],
  );
  const branchCommitsOptions = useMemo(
    () => createGitLiveWorkerQuery(branchCommitsInput, gitWorkerClient),
    [branchCommitsInput, gitWorkerClient],
  );
  const branchCommitsQueryKey = branchCommitsOptions.queryKey;
  const branchCommitsQuery = useQuery({
    ...branchCommitsOptions,
    enabled: gitQueryEnabled && branchCommitsRequested && gitRepositoryIdentity !== null,
  });
  const branchCommits = branchCommitsQuery.data?.commits ?? EMPTY_REVIEW_BRANCH_COMMITS;
  const branchCommitsLoadStatus = !branchCommitsRequested
    ? "idle"
    : branchCommitsQuery.isError || branchCommitsQuery.data?.errorMessage
      ? "error"
      : branchCommitsQuery.data
        ? "loaded"
        : "loading";
  const gitLoadStatus: GitReviewLoadStatus = !gitQueryEnabled
    ? "idle"
    : gitSummaryQuery.isPending || gitRepositoryMetadataQuery.isPending
      ? "loading"
      : gitSummaryQuery.isError ||
          gitRepositoryMetadataQuery.isError ||
          (gitSummaryQuery.data && gitSummaryQuery.data.type !== "success")
        ? "load-failed"
        : "loaded";
  const gitLoading = gitLoadStatus === "loading";
  const refreshStaleReviewSnapshot = useCallback(() => {
    void gitLiveQueryCoordinator.refresh(gitSummaryQueryKey);
  }, [gitLiveQueryCoordinator, gitSummaryQueryKey]);
  const reviewPathDiffs = useReviewPathDiffs({
    commitSha,
    commonDir: gitRepositoryMetadataQuery.data?.commonDir ?? null,
    enabled: gitLoadStatus === "loaded" && isGitReviewSource(source),
    hideWhitespace,
    client: gitWorkerClient,
    onStaleSnapshot: refreshStaleReviewSnapshot,
    root: gitRepositoryMetadataQuery.data?.root ?? null,
    snapshot: gitSummarySnapshot,
  });
  const gitSnapshot = useMemo(
    () => mergeGitSnapshotWithPathDiffs(gitSummarySnapshot, reviewPathDiffs),
    [gitSummarySnapshot, reviewPathDiffs],
  );

  const loadReviewFileContents = useCallback(
    async (entry: ReviewFileEntry): Promise<ReviewFullFileContents> => {
      if (!entry.safety.renderable || !entry.fileDiff) {
        return buildUnavailableReviewFullContents(entry);
      }

      if (isTranscriptReviewSource(source)) {
        if (isReviewNewFile(entry.fileDiff)) {
          return buildTranscriptNewFileContentsFromPatch(entry);
        }

        if (isReviewDeletedFile(entry.fileDiff)) {
          return buildTranscriptDeletedFileContents(entry);
        }

        if (!entry.openPath || !hasPatchLineArrays(entry.fileDiff)) {
          return buildUnavailableReviewFullContents(entry);
        }

        try {
          const contents = await readExactWorkspaceTextFile(
            {
              path: entry.openPath,
              maxBytes: REVIEW_FULL_FILE_MAX_BYTES,
              contentSampleByteLimit: 8_192,
            },
            {
              readMetadata: (input) => invoke("read-file-metadata", input),
              readText: (input) => invoke("read-file", input),
            },
          );
          if (contents === null) {
            return isReviewNewFile(entry.fileDiff)
              ? buildTranscriptNewFileContentsFromPatch(entry)
              : buildUnavailableReviewFullContents(entry);
          }
          return buildTranscriptFullContentsFromPatch(entry, contents);
        } catch {
          return isReviewNewFile(entry.fileDiff)
            ? buildTranscriptNewFileContentsFromPatch(entry)
            : buildUnavailableReviewFullContents(entry);
        }
      }

      const normalizedCwd = gitSnapshot?.cwd?.trim() ?? reviewCwd?.trim() ?? "";
      if (!normalizedCwd) {
        throw new Error("Working directory is required to load full review files.");
      }

      const snapshotGeneration = gitSnapshot?.snapshotGeneration ?? 0;
      if (snapshotGeneration <= 0) {
        return buildUnavailableReviewFullContents(entry);
      }
      const oldObjectSpec = normalizeReviewObjectId(entry.oldOid ?? entry.fileDiff.prevObjectId);
      if (!oldObjectSpec) return buildUnavailableReviewFullContents(entry);
      const newObjectSpec = normalizeReviewObjectId(entry.newOid ?? entry.fileDiff.newObjectId);
      const results = await requestReviewCatFile({
        bucketKey: `${source}:${gitSnapshot?.baseRef ?? ""}:${commitSha ?? ""}`,
        cwd: normalizedCwd,
        snapshotGeneration,
        requests: [
          {
            oid: oldObjectSpec,
            path: entry.previousPath ?? entry.displayPath,
          },
          {
            oid: newObjectSpec,
            path: entry.displayPath,
            fallbackToDisk: source === "unstaged",
          },
        ],
        client: gitWorkerClient,
      });
      const oldRead = buildReviewCatFileTextRead(results[0]);
      const newRead = buildReviewCatFileTextRead(results[1]);
      return {
        path: entry.displayPath,
        previousPath: entry.previousPath,
        oldText: oldRead.text,
        newText: newRead.text,
        oldExists: oldRead.exists,
        newExists: newRead.exists,
        oldStatus: oldRead.status,
        newStatus: newRead.status,
        safety: mergeReviewCatFileSafety(oldRead, newRead),
        errorMessage:
          oldRead.status === "load-failed" || newRead.status === "load-failed"
            ? "Could not load full review file."
            : null,
      };
    },
    [
      commitSha,
      gitSnapshot?.baseRef,
      gitSnapshot?.cwd,
      gitSnapshot?.snapshotGeneration,
      gitWorkerClient,
      invoke,
      reviewCwd,
      source,
    ],
  );

  const snapshot = useMemo(() => {
    if (transcriptSnapshot) return transcriptSnapshot;
    return buildGitSnapshot(gitSnapshot, parsePatchFiles);
  }, [gitSnapshot, parsePatchFiles, transcriptSnapshot]);
  const reviewFullContentKeysByPath = useMemo(
    () =>
      new Map(
        snapshot.files.map((entry) => [
          entry.displayPath,
          buildReviewFullContentKey({
            entry,
            cwd: reviewCwd,
            hostConfigKey: "local",
            nextFallbackToDisk: source === "unstaged" || isTranscriptReviewSource(source),
            ignoreWhitespace: hideWhitespace,
            loadFullFilesEnabled,
            snapshotGeneration:
              snapshot.snapshotGeneration > 0 ? snapshot.snapshotGeneration : null,
          }),
        ]),
      ),
    [
      hideWhitespace,
      loadFullFilesEnabled,
      reviewCwd,
      snapshot.files,
      snapshot.snapshotGeneration,
      source,
    ],
  );
  const reviewDiffCommentSourceKey = useMemo(() => {
    const sourceParts = [
      source,
      source === "last-turn" ? (reviewConversation.lastTurnId ?? "") : "",
      source === "last-turn" ? (reviewConversation.lastTurnEntryId ?? "") : "",
      commitSha ?? "",
      selectedTurnDiff?.turnId ?? "",
      selectedTurnDiff?.entryId ?? "",
      snapshot.baseRef ?? "",
      snapshot.currentBranch ?? "",
    ];
    return sourceParts.join(":");
  }, [
    commitSha,
    reviewConversation.lastTurnEntryId,
    reviewConversation.lastTurnId,
    selectedTurnDiff?.entryId,
    selectedTurnDiff?.turnId,
    snapshot.baseRef,
    snapshot.currentBranch,
    source,
  ]);
  const reviewContentSearchIdentity = useMemo(
    () =>
      snapshot.files
        .map(
          (entry) =>
            `${entry.displayPath}:${
              entry.revision ?? hashReviewDiffSourceKey(entry.patchText)
            }:${entry.loadStatus}`,
        )
        .join("\0"),
    [snapshot.files],
  );
  const selectedCommitSubject = useMemo(
    () => branchCommits.find((commit) => commit.sha === commitSha)?.subject ?? null,
    [branchCommits, commitSha],
  );
  const loadBranchCommits = () => {
    const normalizedCwd = reviewCwd?.trim() ?? "";
    if (!normalizedCwd) return;
    if (!branchCommitsRequested) {
      setBranchCommitsRequested(true);
      return;
    }
    void queryClient.removeQueries({
      queryKey: branchCommitsQueryKey,
      exact: true,
    });
    void gitLiveQueryCoordinator.refresh(branchCommitsQueryKey);
  };
  const reviewCodeComments = reviewConversation.codeComments;
  const totalChangedLines = useMemo(
    () => getReviewTotalChangedLines(snapshot.files),
    [snapshot.files],
  );
  const totalChangedBytes = useMemo(
    () => getReviewTotalChangedBytes(snapshot.files),
    [snapshot.files],
  );
  const isCappedMode = useMemo(
    () =>
      isReviewLargeDiff({
        fileCount: snapshot.files.length,
        largestFileChangedLines: snapshot.files.reduce(
          (largest, file) => Math.max(largest, getReviewChangedLines(file)),
          0,
        ),
        totalChangedBytes,
        totalChangedLines,
      }),
    [snapshot.files, totalChangedBytes, totalChangedLines],
  );

  useEffect(() => {
    clearContentSearchMarks(reviewContentRootRef.current, {
      includeShadowRoots: true,
    });
  }, [reviewContentSearchIdentity, source]);

  const filteredFiles = useMemo(
    () => filterReviewFiles(snapshot.files, deferredFileFilter),
    [deferredFileFilter, snapshot.files],
  );
  const reviewPathRoots = useMemo(
    () => [reviewCwd, snapshot.cwd, projectWorkspacePath] as const,
    [projectWorkspacePath, reviewCwd, snapshot.cwd],
  );
  const canonicalPathByEntryKey = useMemo(
    () =>
      new Map(
        snapshot.files.map((entry) => [
          entry.key,
          getReviewPathAliases(
            {
              displayPath: entry.displayPath,
              previousPath: entry.previousPath,
              gitPath: entry.fileDiff?.name ?? null,
            },
            reviewPathRoots,
          )[0] ?? canonicalizeReviewPath(entry.displayPath, reviewPathRoots),
        ]),
      ),
    [reviewPathRoots, snapshot.files],
  );
  const selectedEntry = useMemo(
    () =>
      selectedPath
        ? resolveReviewPathCandidate(snapshot.files, selectedPath, reviewPathRoots)
        : null,
    [reviewPathRoots, selectedPath, snapshot.files],
  );
  const selectedDisplayPath = selectedEntry?.displayPath ?? null;
  const reviewSourceBucketKey = useMemo(
    () =>
      [
        source,
        routeState.transcriptThreadId ?? "",
        routeState.selectedTurn?.threadId ?? "",
        routeState.selectedTurn?.turnId ?? "",
        routeState.selectedTurn?.entryId ?? "",
        routeState.branchBaseRef ?? "",
        commitSha ?? "",
        snapshot.baseRef ?? "",
      ].join(":"),
    [
      commitSha,
      routeState.branchBaseRef,
      routeState.selectedTurn,
      routeState.transcriptThreadId,
      snapshot.baseRef,
      source,
    ],
  );

  const fullFileTreeModel = useMemo(
    () => buildReviewFileTreeModel(snapshot.files),
    [snapshot.files],
  );
  const fileTreeGitStatusByPath = useMemo(() => {
    return new Map(snapshot.files.map((file) => [file.displayPath, file.gitStatus]));
  }, [snapshot.files]);
  const lockedTreePaths = useMemo(() => {
    return new Set(
      snapshot.files.filter((file) => file.openPath === null).map((file) => file.displayPath),
    );
  }, [snapshot.files]);
  const fileTreeState = useMemo(
    () =>
      buildReviewFileTreeVisibleState(snapshot.files, {
        fileFilterQuery: deferredFileFilter,
        expandedPaths: expandedDirectoryPaths,
        selectedTreeItemId,
        focusedTreeItemId,
        gitStatusByPath: fileTreeGitStatusByPath,
        lockedPaths: lockedTreePaths,
      }),
    [
      deferredFileFilter,
      expandedDirectoryPaths,
      fileTreeGitStatusByPath,
      focusedTreeItemId,
      lockedTreePaths,
      selectedTreeItemId,
      snapshot.files,
    ],
  );

  useEffect(() => {
    const nextFileKeys = new Set(snapshot.files.map((file) => file.key));
    setRouteState((current) =>
      reconcileReviewDiffExpansionSource(current, reviewSourceBucketKey, nextFileKeys),
    );
  }, [reviewSourceBucketKey, setRouteState, snapshot.files]);

  useEffect(() => {
    if (routeState.pendingReveal) return;
    const nextSelectedPath = resolveReviewSelectedPath(
      filteredFiles,
      selectedDisplayPath,
      isCappedMode,
    );
    const nextEntry = nextSelectedPath
      ? (snapshot.files.find((entry) => entry.displayPath === nextSelectedPath) ?? null)
      : null;
    const nextCanonicalPath = nextEntry
      ? (canonicalPathByEntryKey.get(nextEntry.key) ?? null)
      : null;
    if (nextCanonicalPath === selectedPath) return;
    setSelectedPath(nextCanonicalPath);
  }, [
    canonicalPathByEntryKey,
    filteredFiles,
    isCappedMode,
    routeState.pendingReveal,
    selectedDisplayPath,
    selectedPath,
    setSelectedPath,
    snapshot.files,
  ]);

  useEffect(() => {
    if (snapshot.files.length === 0) return;
    setRouteState((current) => {
      if (current.treeExpansionSourceKey === reviewSourceBucketKey) return current;
      return {
        ...current,
        treeExpansionSourceKey: reviewSourceBucketKey,
        expandedDirectoryPaths: buildReviewFileTreeDefaultExpandedPaths(snapshot.files),
      };
    });
  }, [reviewSourceBucketKey, setRouteState, snapshot.files]);

  const selectedAncestorPaths = useMemo(
    () => buildReviewFileTreeExpandedPathsForSelection(fullFileTreeModel, selectedDisplayPath),
    [fullFileTreeModel, selectedDisplayPath],
  );

  useEffect(() => {
    if (selectedAncestorPaths.length === 0) return;
    setExpandedDirectoryPaths((current) => {
      let changed = false;
      const next = new Set(current);
      for (const ancestorPath of selectedAncestorPaths) {
        if (next.has(ancestorPath)) continue;
        next.add(ancestorPath);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [selectedAncestorPaths, setExpandedDirectoryPaths]);

  useEffect(() => {
    const currentSelectedNode = selectedTreeItemId
      ? (fullFileTreeModel.nodesById.get(selectedTreeItemId) ?? null)
      : null;
    if (currentSelectedNode?.type === "folder") {
      return;
    }

    const nextSelectedTreeItemId = resolveReviewFileTreeItemIdForPath(
      fullFileTreeModel,
      selectedDisplayPath,
    );
    if (!nextSelectedTreeItemId) return;

    if (nextSelectedTreeItemId !== selectedTreeItemId) {
      setSelectedTreeItemId(nextSelectedTreeItemId);
    }
    if (nextSelectedTreeItemId !== focusedTreeItemId) {
      setFocusedTreeItemId(nextSelectedTreeItemId);
    }
  }, [focusedTreeItemId, fullFileTreeModel, selectedDisplayPath, selectedTreeItemId]);

  useEffect(() => {
    const visibleRowIds = new Set(fileTreeState.rows.map((row) => row.id));
    if (visibleRowIds.size === 0) {
      if (selectedTreeItemId !== null) setSelectedTreeItemId(null);
      if (focusedTreeItemId !== null) setFocusedTreeItemId(null);
      return;
    }

    const fallbackTreeItemId =
      resolveReviewFileTreeItemIdForPath(fileTreeState.model, selectedDisplayPath) ??
      fileTreeState.rows[0]?.id ??
      null;

    if (!selectedTreeItemId || !visibleRowIds.has(selectedTreeItemId)) {
      if (fallbackTreeItemId !== selectedTreeItemId) {
        setSelectedTreeItemId(fallbackTreeItemId);
      }
    }

    if (!focusedTreeItemId || !visibleRowIds.has(focusedTreeItemId)) {
      if (fallbackTreeItemId !== focusedTreeItemId) {
        setFocusedTreeItemId(fallbackTreeItemId);
      }
    }
  }, [
    fileTreeState.model,
    fileTreeState.rows,
    focusedTreeItemId,
    selectedDisplayPath,
    selectedTreeItemId,
  ]);

  const visibleFiles = useMemo(() => {
    return buildReviewVisibleFiles(
      filteredFiles,
      selectedDisplayPath,
      isCappedMode,
      false,
      REVIEW_CAPPED_MATCH_PAGE_SIZE,
    );
  }, [filteredFiles, isCappedMode, selectedDisplayPath]);

  const findReviewRow = useCallback((path: CanonicalReviewPath) => {
    const registered = rowRefs.current.get(path);
    if (registered) return registered;
    const root = reviewContentRootRef.current;
    if (!root) return null;
    return (
      Array.from(root.querySelectorAll<HTMLElement>("[data-review-path]")).find(
        (candidate) => candidate.dataset.reviewPath === path,
      ) ?? null
    );
  }, []);

  const revealReviewEntry = useCallback(
    async (
      entry: ReviewFileEntry,
      options: {
        readonly signal: AbortSignal;
        readonly block: ScrollLogicalPosition;
        readonly clearFilter?: boolean;
      },
    ): Promise<boolean> => {
      const canonicalPath = canonicalPathByEntryKey.get(entry.key);
      if (!canonicalPath) return false;
      if (options.clearFilter && fileFilter.length > 0) setFileFilter("");
      setSelectedPath(canonicalPath);
      setRouteState((current) =>
        setReviewDiffExpanded(
          current,
          entry.key,
          true,
          current.allDiffsExpanded && entry.gitStatus !== "deleted",
        ),
      );

      await nextReviewAnimationFrame(options.signal);
      await nextReviewAnimationFrame(options.signal);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const row = findReviewRow(canonicalPath);
        if (row) {
          row.scrollIntoView({ block: options.block, inline: "nearest" });
          return true;
        }
        await waitForReviewRevealRetry(options.signal);
      }
      return false;
    },
    [
      canonicalPathByEntryKey,
      fileFilter.length,
      findReviewRow,
      setRouteState,
      setFileFilter,
      setSelectedPath,
    ],
  );

  const revealFromReviewNavigation = useCallback(
    (entry: ReviewFileEntry, block: ScrollLogicalPosition = "start") => {
      navigationRevealControllerRef.current?.abort();
      const controller = new AbortController();
      navigationRevealControllerRef.current = controller;

      void revealReviewEntry(entry, {
        signal: controller.signal,
        block,
        clearFilter: true,
      })
        .then((revealed) => {
          if (!revealed && !controller.signal.aborted) {
            toast.danger(`Could not reveal ${entry.displayPath} in Review.`);
          }
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          toast.danger(
            error instanceof Error ? error.message : "Could not reveal the Review file.",
          );
        })
        .finally(() => {
          if (navigationRevealControllerRef.current === controller) {
            navigationRevealControllerRef.current = null;
          }
        });
    },
    [revealReviewEntry],
  );

  useEffect(() => {
    return () => navigationRevealControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    const pendingReveal = routeState.pendingReveal;
    if (!pendingReveal) return;
    if (isGitReviewSource(source) && gitLoadStatus === "loading") return;
    const controller = new AbortController();
    const entry = resolveReviewPathCandidate(
      snapshot.files,
      pendingReveal.targetPath,
      reviewPathRoots,
    );

    void (async () => {
      try {
        if (!entry) {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            await waitForReviewRevealRetry(controller.signal);
          }
          toast.danger(`Could not find ${pendingReveal.targetPath} in Review.`);
          acknowledgeReveal(pendingReveal.requestId);
          return;
        }
        const revealed = await revealReviewEntry(entry, {
          signal: controller.signal,
          block: "start",
          clearFilter: true,
        });
        if (!revealed) {
          toast.danger(`Could not reveal ${entry.displayPath} in Review.`);
        }
        acknowledgeReveal(pendingReveal.requestId);
      } catch (error) {
        if (controller.signal.aborted) return;
        toast.danger(error instanceof Error ? error.message : "Could not reveal the Review file.");
      }
    })();

    return () => controller.abort();
  }, [
    acknowledgeReveal,
    gitLoadStatus,
    revealReviewEntry,
    reviewPathRoots,
    routeState.pendingReveal,
    snapshot.files,
    source,
  ]);

  const contentSearchSource = useMemo<ContentSearchLocalSource>(
    () => ({
      domain: "diff",
      contextId: `diff:${reviewCwd ?? "workspace"}:${source}`,
      async search(query, limit, options) {
        const normalizedQuery = query.trim();
        if (!normalizedQuery) {
          return {
            query: normalizedQuery,
            matches: [],
            totalMatches: 0,
            capped: false,
          };
        }

        const searchCwd = snapshot.cwd ?? reviewCwd;
        const contextId = `diff:${searchCwd ?? "workspace"}:${source}`;
        const requiresServerSearch =
          isGitReviewSource(source) &&
          (isCappedMode ||
            snapshot.files.length === 0 ||
            snapshot.files.some((entry) => typeof entry.generated !== "boolean") ||
            snapshot.files.some((entry) => entry.loadStatus !== "loaded"));
        if (requiresServerSearch && searchCwd) {
          if (options?.signal.aborted) {
            throw new DOMException("Review search aborted", "AbortError");
          }
          const result = await gitWorkerClient.request({
            method: "review-search",
            params: {
              cwd: searchCwd,
              source,
              query: normalizedQuery,
              baseBranch: source === "branch" ? snapshot.baseRef : null,
              commitSha: source === "commit" ? commitSha : null,
            },
            signal: options?.signal,
          });
          if (result.type !== "success") {
            return {
              query: normalizedQuery,
              matches: [],
              totalMatches: 0,
              capped: false,
            };
          }

          const displayPathByGitPath = new Map(
            snapshot.files.map((entry) => [
              stripPatchPrefix(entry.fileDiff?.name ?? entry.displayPath),
              entry.displayPath,
            ]),
          );
          const locations: ReviewSearchLocation[] = result.matches.map((location) => ({
            ...location,
            path:
              displayPathByGitPath.get(stripPatchPrefix(location.path)) ??
              stripPatchPrefix(location.path),
          }));
          return {
            query: result.query,
            matches: buildReviewContentSearchMatches({
              contextId,
              locations,
            }),
            totalMatches: result.totalMatches,
            capped: result.isCapped,
          };
        }

        const generatedPaths = new Set(
          snapshot.files.flatMap((entry) => (entry.generated === true ? [entry.displayPath] : [])),
        );
        const files = buildReviewSearchFiles(
          snapshot.files.map((entry) => ({
            path: entry.displayPath,
            gitPath: entry.displayPath,
            previousGitPath: entry.previousPath,
            diff: entry.fileDiff,
          })),
          generatedPaths,
        );
        const localResult = searchReviewFiles(
          files,
          normalizedQuery,
          Math.min(limit, REVIEW_SEARCH_MATCH_LIMIT),
        );
        return {
          query: normalizedQuery,
          matches: buildReviewContentSearchMatches({
            contextId,
            locations: localResult.matches,
          }),
          totalMatches: localResult.totalMatches,
          capped: localResult.isCapped,
        };
      },
      async ensureVisible(match, options) {
        if (!isReviewSearchMatchMeta(match.meta)) return;
        const location = match.meta.location;
        const entry = snapshot.files.find((file) => file.displayPath === location.path);
        if (!entry) return;

        await revealReviewEntry(entry, {
          signal: options.signal,
          block: "center",
        });
        await nextReviewAnimationFrame(options.signal);
      },
      async activate(match, query, options) {
        if (!isReviewSearchMatchMeta(match.meta)) return;
        const meta = match.meta;
        const entry = snapshot.files.find((file) => file.displayPath === meta.location.path);
        if (!entry) return;

        const root = reviewContentRootRef.current;
        const canonicalPath = canonicalPathByEntryKey.get(entry.key);
        const row = canonicalPath ? findReviewRow(canonicalPath) : null;
        if (!root || !row) return;
        clearContentSearchMarks(root, { includeShadowRoots: true });

        const startedAt = performance.now();
        while (!options?.signal.aborted && performance.now() - startedAt < 1_500) {
          applyContentSearchDiffDomMarks({
            root: row,
            query,
            activeMatchId: match.id,
            sourceMatches: meta.pathMatches.map((pathMatch) => ({
              id: pathMatch.id,
              hunkId: pathMatch.location.hunkId,
              lineStart: pathMatch.location.lineStart,
              lineEnd: pathMatch.location.lineEnd,
              ...(pathMatch.location.side ? { side: pathMatch.location.side } : {}),
            })),
          });
          const activeElement = findContentSearchDomMatch({
            root: row,
            matchId: match.id,
            includeShadowRoots: true,
          });
          if (activeElement) {
            activeElement.classList.add(CONTENT_SEARCH_ACTIVE_MARK_CLASS);
            activeElement.scrollIntoView({
              block: "center",
              inline: "nearest",
            });
            return;
          }
          await nextReviewAnimationFrame(options?.signal);
        }
      },
      clear() {
        clearContentSearchMarks(reviewContentRootRef.current, {
          includeShadowRoots: true,
        });
      },
    }),
    [
      commitSha,
      canonicalPathByEntryKey,
      findReviewRow,
      gitWorkerClient,
      isCappedMode,
      revealReviewEntry,
      reviewCwd,
      snapshot.baseRef,
      snapshot.cwd,
      snapshot.files,
      source,
    ],
  );
  useRegisterContentSearchSource(contentSearchSource);
  const allDiffsExpanded = routeState.allDiffsExpanded;
  const jumpToFileMatches = useMemo(() => {
    return selectReviewJumpToFileMatches(snapshot.files, deferredJumpToFileQuery);
  }, [deferredJumpToFileQuery, snapshot.files]);
  const handleJumpToFileSelect = useCallback(
    (file: ReviewFileEntry) => {
      const freshMatches = selectReviewJumpToFileMatches(snapshot.files, jumpToFileQuery);
      if (!freshMatches.some((candidate) => candidate.displayPath === file.displayPath)) return;
      setJumpToFileQuery("");
      revealFromReviewNavigation(file);
    },
    [jumpToFileQuery, revealFromReviewNavigation, snapshot.files],
  );

  const handleReviewTreePathSelect = useCallback(
    (path: string) => {
      const entry = resolveReviewPathCandidate(
        snapshot.files,
        canonicalizeReviewPath(path, reviewPathRoots),
        reviewPathRoots,
      );
      if (!entry) return;
      revealFromReviewNavigation(entry);
    },
    [revealFromReviewNavigation, reviewPathRoots, snapshot.files],
  );

  const toggleReviewRow = useCallback(
    (entryKey: string, canInheritExpanded: boolean) => {
      setRouteState((current) =>
        toggleReviewDiffExpanded(current, entryKey, current.allDiffsExpanded && canInheritExpanded),
      );
    },
    [setRouteState],
  );

  const reviewFilePathsIdentity = useMemo(
    () => snapshot.files.map((entry) => entry.displayPath).join("\0"),
    [snapshot.files],
  );
  const reviewCommentsCache = reviewCommentsByPathCacheRef.current;
  const reviewCommentsByPath =
    reviewCommentsCache?.comments === reviewCodeComments &&
    reviewCommentsCache.pathsIdentity === reviewFilePathsIdentity
      ? reviewCommentsCache.value
      : new Map(
          snapshot.files.map((entry) => {
            const comments = filterReviewCodeCommentsForPath(reviewCodeComments, entry.displayPath);
            return [
              entry.displayPath,
              comments.length > 0 ? comments : EMPTY_REVIEW_CODE_COMMENTS,
            ] as const;
          }),
        );
  if (reviewCommentsByPath !== reviewCommentsCache?.value) {
    reviewCommentsByPathCacheRef.current = {
      comments: reviewCodeComments,
      pathsIdentity: reviewFilePathsIdentity,
      value: reviewCommentsByPath,
    };
  }
  const pendingReviewCommentsByPath = buildStableReviewCommentAttachmentsByPath(
    pendingReviewCommentAttachments,
    pendingReviewCommentsByPathRef.current,
  );
  pendingReviewCommentsByPathRef.current = pendingReviewCommentsByPath;

  const renderReviewRow = (entry: ReviewFileEntry, keyPrefix = "") => (
    <div
      key={`${keyPrefix}${entry.key}`}
      data-review-path={canonicalPathByEntryKey.get(entry.key)}
      ref={(node) => {
        const canonicalPath = canonicalPathByEntryKey.get(entry.key);
        if (!canonicalPath) return;
        if (!node) {
          rowRefs.current.delete(canonicalPath);
          return;
        }
        rowRefs.current.set(canonicalPath, node);
      }}
    >
      <ReviewFileRow
        entry={entry}
        diffMode={diffMode}
        wrap={wrap && !isCappedMode}
        wordDiffsEnabled={wordDiffsEnabled}
        ignoreWhitespace={hideWhitespace}
        loadFullFilesEnabled={loadFullFilesEnabled}
        canLoadFullContent={
          Boolean(reviewCwd?.trim()) &&
          (!isGitReviewSource(source) || snapshot.snapshotGeneration > 0)
        }
        expanded={
          diffExpansionOverrides.get(entry.key) ??
          (routeState.allDiffsExpanded && entry.gitStatus !== "deleted")
        }
        cwd={reviewCwd}
        workspaceRoot={projectWorkspacePath ?? reviewCwd}
        fullContentKey={reviewFullContentKeysByPath.get(entry.displayPath) ?? entry.key}
        loadFullContents={loadReviewFileContents}
        comments={reviewCommentsByPath.get(entry.displayPath) ?? EMPTY_REVIEW_CODE_COMMENTS}
        threadId={reviewThreadId}
        sourceKey={`${reviewDiffCommentSourceKey}:${
          entry.revision ?? hashReviewDiffSourceKey(entry.patchText)
        }`}
        pendingCommentAttachments={
          pendingReviewCommentsByPath.get(entry.displayPath) ?? EMPTY_REVIEW_COMMENT_ATTACHMENTS
        }
        deps={resolvedDeps}
        onToggleExpandedKey={toggleReviewRow}
      />
    </div>
  );
  const reviewRows = visibleFiles.map((entry) => renderReviewRow(entry));

  const refreshGitSnapshot = async (): Promise<void> => {
    if (!isGitReviewSource(source)) return;

    const normalizedCwd = reviewCwd?.trim() ?? "";
    if (!normalizedCwd) return;

    try {
      await gitLiveQueryCoordinator.refresh(gitSummaryQueryKey);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Could not refresh review.", {
        id: "review-diff-notice",
      });
    }
  };

  const handleCreateGitRepository = async () => {
    const normalizedCwd = reviewCwd?.trim() ?? "";
    if (!normalizedCwd) return;

    try {
      await gitWorkerClient.request({
        method: "git-init-repo",
        params: { cwd: normalizedCwd },
      });
      toast.success("Created a Git repository for this workspace.", {
        id: "review-diff-notice",
      });
    } finally {
      void queryClient.invalidateQueries({
        queryKey: gitRepositoryMetadataQueryKey,
        exact: true,
      });
    }
  };

  const startThreadPrompt = async (prompt: string) => {
    const threadId = reviewConversation.threadId;
    if (!threadId) return;

    try {
      await onStartThreadPrompt(threadId, prompt);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Could not start a Nodex turn.", {
        id: "review-diff-notice",
      });
    }
  };

  const canUseThreadGitActions = Boolean(
    reviewConversation.threadId && snapshot.isGitRepository && reviewCwd,
  );
  const reviewOptionsWordWrapLabel = wrap ? "Disable word wrap" : "Enable word wrap";
  const reviewOptionsExpandLabel = allDiffsExpanded ? "Collapse all diffs" : "Expand all diffs";
  const reviewOptionsFullFilesLabel = loadFullFilesEnabled
    ? "Don't load full files"
    : "Load full files";
  const reviewOptionsRichPreviewLabel = richPreviewEnabled
    ? "Disable rich preview"
    : "Enable rich preview";
  const reviewOptionsWordDiffsLabel = wordDiffsEnabled ? "Disable word diffs" : "Enable word diffs";
  const reviewOptionsWhitespaceLabel = hideWhitespace ? "Show white space" : "Hide white space";
  const canCopyGitApplyCommand =
    isGitReviewSource(source) && snapshot.isGitRepository && Boolean(reviewCwd);

  const handleCopyGitApplyCommand = async () => {
    if (!canCopyGitApplyCommand || !reviewCwd || !isGitReviewSource(source)) return;

    try {
      const result = await gitWorkerClient.request({
        method: "review-patch",
        params: {
          cwd: reviewCwd,
          source,
          baseRef: snapshot.baseRef,
          commitSha,
          operationSource: "review_model",
        },
      });
      if ("type" in result) {
        toast.danger("The repository changed. Refresh Review and try again.", {
          id: "review-diff-notice",
        });
        return;
      }
      const patchResult: GitReviewPatchResult = result;
      if (patchResult.diff.type !== "success" || patchResult.diff.unifiedDiff.trim().length === 0) {
        toast.danger("Could not copy git apply command.", {
          id: "review-diff-notice",
        });
        return;
      }

      const copied = await writeTextToClipboard(
        buildReviewGitApplyCommand(patchResult.diff.unifiedDiff),
      );
      if (copied) {
        toast.success("Copied git apply command to the clipboard", {
          id: "review-diff-notice",
        });
        return;
      }
    } catch {
      // Fall through to the shared failure toast below.
    }

    toast.danger("Could not copy git apply command.", {
      id: "review-diff-notice",
    });
  };

  const sourceTrigger = (
    <button type="button" className={toolbarSourceButtonClassName()} aria-label="Review source">
      <span className="flex max-w-full min-w-0 items-center gap-1.5 truncate">
        {SOURCE_LABELS[source]}
      </span>
      <ChevronDownIcon className="icon-2xs text-token-description-foreground" />
    </button>
  );

  const optionsTrigger = (
    <button type="button" className={toolbarIconButtonClassName()} aria-label="Review options">
      <MoreActionsIcon className="icon-xs text-token-description-foreground" />
    </button>
  );

  const jumpToFileTrigger = (
    <button type="button" className={toolbarIconButtonClassName()} aria-label="Jump to file">
      <ReviewJumpToFileIcon className="icon-xs text-token-description-foreground" />
    </button>
  );
  const diffModeLabel = diffMode === "unified" ? "Switch to split diff" : "Switch to unified diff";
  const toggleFileTreeLabel = fileTreeOpen ? "Hide files" : "Show files";
  const handleToggleDirectory = (path: string) => {
    setExpandedDirectoryPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };
  const handleFileTreeResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const ownerDocument = event.currentTarget.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const splitRoot = reviewSplitRootRef.current;
    if (!ownerWindow || !splitRoot) return;

    const startX = event.clientX;
    const startWidth = fileTreeWidth;
    const maxWidth = Math.max(
      REVIEW_FILE_TREE_MIN_WIDTH_PX,
      splitRoot.getBoundingClientRect().width * REVIEW_FILE_TREE_MAX_WIDTH_RATIO,
    );
    const clampWidth = (width: number) =>
      Math.min(maxWidth, Math.max(REVIEW_FILE_TREE_MIN_WIDTH_PX, Math.round(width)));

    const previousCursor = ownerDocument.body.style.cursor;
    const previousUserSelect = ownerDocument.body.style.userSelect;
    ownerDocument.body.style.cursor = "col-resize";
    ownerDocument.body.style.userSelect = "none";

    const cleanup = () => {
      ownerWindow.removeEventListener("pointermove", handlePointerMove);
      ownerWindow.removeEventListener("pointerup", handlePointerUp);
      ownerWindow.removeEventListener("pointercancel", handlePointerCancel);
      ownerDocument.body.style.cursor = previousCursor;
      ownerDocument.body.style.userSelect = previousUserSelect;
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      setFileTreeWidth(clampWidth(startWidth - (moveEvent.clientX - startX)));
    };
    const handlePointerUp = () => {
      cleanup();
    };
    const handlePointerCancel = () => {
      cleanup();
    };

    ownerWindow.addEventListener("pointermove", handlePointerMove);
    ownerWindow.addEventListener("pointerup", handlePointerUp);
    ownerWindow.addEventListener("pointercancel", handlePointerCancel);
  };

  if (!reviewCwd) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-token-main-surface-primary">
        <ReviewPanelEmptyState
          title="No review workspace available"
          description="Start or open a local thread with a project workspace to review file changes here."
          illustration={<ReviewPanelIcon />}
        />
      </div>
    );
  }

  const canViewBranchDiffFromEmptyState =
    snapshot.isGitRepository && reviewCwd.trim().length > 0 && source !== "branch";
  const noFilesEmptyStateCopy = resolveReviewNoFilesEmptyStateCopy(source, snapshot.emptyReason);
  const viewBranchDiffAction =
    noFilesEmptyStateCopy.showViewBranchDiffAction && canViewBranchDiffFromEmptyState ? (
      <button
        type="button"
        className={REVIEW_EMPTY_STATE_ACTION_BUTTON_CLASS_NAME}
        onClick={() => selectReviewSource("branch")}
      >
        View branch diff
      </button>
    ) : null;
  const emptyStateIllustration = noFilesEmptyStateCopy.showIllustration ? (
    <ReviewPanelIcon />
  ) : undefined;
  const fileTreePane = fileTreeOpen ? (
    <div
      className="relative flex h-full shrink-0 border-l border-token-border-default"
      style={{
        maxWidth: `${REVIEW_FILE_TREE_MAX_WIDTH_RATIO * 100}%`,
        opacity: 1,
        width: fileTreeWidth,
      }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        className="group absolute flex touch-none select-none z-40 top-0 bottom-0 left-0 w-4 -translate-x-2 cursor-col-resize active:cursor-col-resize"
        onPointerDown={handleFileTreeResizePointerDown}
        onDoubleClick={() => setFileTreeWidth(REVIEW_FILE_TREE_DEFAULT_WIDTH_PX)}
      >
        <div className="sidebar-resize-handle-line pointer-events-none m-auto opacity-0 h-full w-px bg-gradient-to-b from-transparent via-token-foreground/25 to-transparent group-hover:opacity-100 group-active:opacity-100" />
      </div>
      <div
        className="flex h-full min-h-0 w-full flex-col"
        data-file-tree-virtualized={
          isReviewFileTreeVirtualizationEnabled(
            fileTreeState.rows.length,
            REVIEW_FILE_TREE_VIRTUALIZE_THRESHOLD,
          )
            ? "true"
            : undefined
        }
      >
        <ReviewFileTreePane
          rows={fileTreeState.rows}
          fileFilter={fileFilter}
          onFileFilterChange={setFileFilter}
          selectedTreeItemId={selectedTreeItemId}
          focusedTreeItemId={focusedTreeItemId}
          onSelectTreeItemId={setSelectedTreeItemId}
          onFocusTreeItemId={setFocusedTreeItemId}
          onSelectPath={handleReviewTreePathSelect}
          onToggleDirectory={handleToggleDirectory}
        />
      </div>
    </div>
  ) : null;
  const reviewMainContent =
    gitLoadStatus === "loading" && isGitReviewSource(source) ? (
      <div className="flex h-full w-full items-center justify-center text-sm text-token-description-foreground">
        Loading review…
      </div>
    ) : snapshot.errorMessage ? (
      <ReviewPanelEmptyState
        title="Could not load review"
        description={snapshot.errorMessage}
        illustration={<ReviewPanelIcon />}
      />
    ) : !snapshot.isGitRepository && isGitReviewSource(source) ? (
      <ReviewPanelEmptyState
        title="Create a Git repository"
        description="Track, review, and undo changes in this project."
        illustration={<ReviewPanelIcon />}
        action={
          <button
            type="button"
            className={REVIEW_EMPTY_STATE_ACTION_BUTTON_CLASS_NAME}
            onClick={handleCreateGitRepository}
          >
            Create repository
          </button>
        }
      />
    ) : snapshot.files.length === 0 ? (
      <ReviewPanelEmptyState
        title={noFilesEmptyStateCopy.title}
        description={noFilesEmptyStateCopy.description}
        illustration={emptyStateIllustration}
        action={viewBranchDiffAction}
      />
    ) : visibleFiles.length === 0 ? (
      <ReviewPanelEmptyState
        title="No review matches"
        description="Try a different file filter or review search query."
      />
    ) : (
      <ReviewDiffVirtualizer
        config={{ intersectionObserverMargin: 1_000 }}
        className="electron:bg-token-main-surface-primary flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pb-3"
        style={RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE}
        contentClassName="flex w-full flex-col extension:pl-4 extension:pr-1"
      >
        {isCappedMode ? (
          <div className="bg-token-surface-muted text-token-foreground-muted mb-3 rounded-md px-3 py-2 text-xs">
            This diff is large, showing one file at a time
          </div>
        ) : null}
        <div ref={reviewContentRootRef} className="flex flex-col extension:gap-2">
          {reviewRows}
        </div>
      </ReviewDiffVirtualizer>
    );

  return (
    <div className="relative h-full min-h-0 bg-token-main-surface-primary">
      <FileTypeIconSprite />
      <div className="relative grid h-full min-h-0 w-full grid-rows-[auto_1fr]">
        <div className="h-toolbar-pane border-b bg-token-main-surface-primary [container-name:review-header] [container-type:inline-size] grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 border-token-border px-2 py-1 text-token-description-foreground">
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 font-medium text-token-foreground">
              <NodexDropdownMenu
                triggerButton={sourceTrigger}
                align="start"
                sideOffset={8}
                contentWidth="menuBounded"
              >
                <NodexDropdownItem
                  onSelect={() => selectReviewSource("unstaged")}
                  rightSlot={source === "unstaged" ? <CheckmarkIcon className="size-4" /> : null}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">Unstaged</span>
                    {source === "unstaged" && snapshot.files.length > 0 ? (
                      <ReviewSourceCountBadge count={snapshot.files.length} />
                    ) : null}
                  </span>
                </NodexDropdownItem>
                <NodexDropdownItem
                  onSelect={() => selectReviewSource("staged")}
                  rightSlot={source === "staged" ? <CheckmarkIcon className="size-4" /> : null}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">Staged</span>
                    {source === "staged" && snapshot.files.length > 0 ? (
                      <ReviewSourceCountBadge count={snapshot.files.length} />
                    ) : null}
                  </span>
                </NodexDropdownItem>
                <NodexDropdownFlyoutSubmenuItem
                  label="Commit"
                  onOpenChange={(open) => {
                    if (!open) return;
                    void loadBranchCommits();
                  }}
                  contentClassName="min-w-[320px]"
                >
                  {branchCommitsLoadStatus === "loading" ? (
                    <NodexDropdownMessage compact>Loading commits...</NodexDropdownMessage>
                  ) : branchCommitsLoadStatus === "error" ? (
                    <>
                      <NodexDropdownMessage compact tone="error">
                        {branchCommitsQuery.data?.errorMessage ?? "Unable to load commits"}
                      </NodexDropdownMessage>
                      <NodexDropdownItem onSelect={() => void loadBranchCommits()}>
                        Retry
                      </NodexDropdownItem>
                    </>
                  ) : branchCommits.length === 0 ? (
                    <NodexDropdownMessage compact>No commits on branch</NodexDropdownMessage>
                  ) : (
                    <NodexDropdownScrollList className="max-h-80">
                      {branchCommits.map((commit) => {
                        const relativeTime = formatReviewCommitRelativeTime(commit.committedAt);
                        return (
                          <NodexDropdownItem
                            key={commit.sha}
                            onSelect={() => selectReviewCommit(commit)}
                            tooltipText={commit.subject}
                            rightSlot={
                              source === "commit" && commitSha === commit.sha ? (
                                <CheckmarkIcon className="size-4" />
                              ) : null
                            }
                          >
                            <span className="flex min-w-0 items-center justify-between gap-3">
                              <span className="min-w-0 truncate">{commit.subject}</span>
                              {relativeTime ? (
                                <span className="shrink-0 text-xs text-token-description-foreground">
                                  {relativeTime} ago
                                </span>
                              ) : null}
                            </span>
                          </NodexDropdownItem>
                        );
                      })}
                    </NodexDropdownScrollList>
                  )}
                </NodexDropdownFlyoutSubmenuItem>
                <NodexDropdownItem
                  onSelect={() => selectReviewSource("branch")}
                  rightSlot={source === "branch" ? <CheckmarkIcon className="size-4" /> : null}
                >
                  Branch
                </NodexDropdownItem>
                <NodexDropdownItem
                  onSelect={() => selectReviewSource("last-turn")}
                  rightSlot={
                    source === "last-turn" || source === "selected-turn" ? (
                      <CheckmarkIcon className="size-4" />
                    ) : null
                  }
                >
                  Last turn
                </NodexDropdownItem>
              </NodexDropdownMenu>
            </div>
            {source === "commit" && selectedCommitSubject ? (
              <span className="max-w-[320px] truncate text-token-description-foreground">
                {selectedCommitSubject}
              </span>
            ) : null}
            <DiffStats
              additions={snapshot.files.reduce((total, file) => total + (file.additions ?? 0), 0)}
              deletions={snapshot.files.reduce((total, file) => total + (file.deletions ?? 0), 0)}
              className={REVIEW_AGGREGATE_DIFF_STATS_CLASS_NAME}
            />
          </div>
          <div className="flex min-w-0 flex-shrink-0 items-center gap-1">
            <NodexDropdownMenu
              triggerButton={optionsTrigger}
              align="end"
              sideOffset={8}
              contentWidth="menu"
            >
              {isGitReviewSource(source) ? (
                <NodexDropdownItem
                  onSelect={() => void refreshGitSnapshot()}
                  disabled={gitLoading}
                  leftSlot={<ReviewRefreshIcon className={REVIEW_OPTIONS_MENU_ICON_CLASS_NAME} />}
                >
                  Refresh
                </NodexDropdownItem>
              ) : null}
              <NodexDropdownItem
                onSelect={() => setWrap((current) => !current)}
                leftSlot={
                  wrap ? (
                    <ReviewDisableWordWrapIcon className={REVIEW_OPTIONS_MENU_ICON_CLASS_NAME} />
                  ) : (
                    <ReviewEnableWordWrapIcon className={REVIEW_OPTIONS_MENU_ICON_CLASS_NAME} />
                  )
                }
              >
                {reviewOptionsWordWrapLabel}
              </NodexDropdownItem>
              <NodexDropdownSeparator />
              <NodexDropdownItem
                onSelect={() => setLoadFullFilesEnabled((current) => !current)}
                leftSlot={<FileIcon className={REVIEW_OPTIONS_MENU_ICON_CLASS_NAME} />}
              >
                {reviewOptionsFullFilesLabel}
              </NodexDropdownItem>
              <NodexDropdownItem
                onSelect={() => setRichPreviewEnabled((current) => !current)}
                leftSlot={
                  richPreviewEnabled ? (
                    <ReviewDisableRichPreviewIcon className={REVIEW_OPTIONS_MENU_ICON_CLASS_NAME} />
                  ) : (
                    <ReviewRichPreviewIcon className={REVIEW_OPTIONS_MENU_ICON_CLASS_NAME} />
                  )
                }
              >
                {reviewOptionsRichPreviewLabel}
              </NodexDropdownItem>
              <NodexDropdownItem
                onSelect={() => setWordDiffsEnabled((current) => !current)}
                leftSlot={
                  wordDiffsEnabled ? (
                    <ReviewDisableWordDiffsIcon className={REVIEW_OPTIONS_MENU_ICON_CLASS_NAME} />
                  ) : (
                    <ReviewWordDiffsIcon className={REVIEW_OPTIONS_MENU_ICON_CLASS_NAME} />
                  )
                }
              >
                {reviewOptionsWordDiffsLabel}
              </NodexDropdownItem>
              <NodexDropdownItem
                onSelect={() => setHideWhitespace((current) => !current)}
                disabled={!isGitReviewSource(source)}
                leftSlot={
                  <ReviewHideWhitespaceIcon className={REVIEW_OPTIONS_MENU_ICON_CLASS_NAME} />
                }
              >
                {reviewOptionsWhitespaceLabel}
              </NodexDropdownItem>
              <NodexDropdownItem
                onSelect={() => void handleCopyGitApplyCommand()}
                disabled={!canCopyGitApplyCommand}
                leftSlot={<FileIcon className={REVIEW_OPTIONS_MENU_ICON_CLASS_NAME} />}
              >
                Copy git apply command
              </NodexDropdownItem>
            </NodexDropdownMenu>
            <NodexTooltip tooltipContent={reviewOptionsExpandLabel}>
              <button
                type="button"
                className={toolbarIconButtonClassName()}
                aria-label={reviewOptionsExpandLabel}
                onClick={() =>
                  setRouteState((current) => setAllReviewDiffsExpanded(current, !allDiffsExpanded))
                }
              >
                {allDiffsExpanded ? (
                  <ReviewCollapseAllDiffsIcon className="icon-xs" />
                ) : (
                  <ReviewExpandAllDiffsIcon className="icon-xs" />
                )}
              </button>
            </NodexTooltip>
            <NodexDropdownMenu
              triggerButton={jumpToFileTrigger}
              align="end"
              sideOffset={8}
              contentWidth="panelWide"
              contentMaxHeight="list"
            >
              <NodexDropdownSearchInput
                value={jumpToFileQuery}
                onChange={(event) => setJumpToFileQuery(event.target.value)}
                placeholder="Jump to file"
                aria-label="Jump to file"
              />
              {jumpToFileMatches.length === 0 ? (
                <NodexDropdownMessage compact>No matching files</NodexDropdownMessage>
              ) : (
                jumpToFileMatches.map((file) => (
                  <NodexDropdownItem
                    key={file.key}
                    allowWrap
                    onSelect={() => handleJumpToFileSelect(file)}
                    rightSlot={
                      selectedPath === canonicalPathByEntryKey.get(file.key) ? (
                        <CheckmarkIcon className="size-4" />
                      ) : null
                    }
                  >
                    <ReviewJumpFilePathLabel displayPath={file.displayPath} />
                  </NodexDropdownItem>
                ))
              )}
            </NodexDropdownMenu>
            <button
              type="button"
              className={toolbarIconButtonClassName()}
              aria-label={diffModeLabel}
              onClick={() =>
                setDiffMode((current) => (current === "unified" ? "split" : "unified"))
              }
            >
              {diffMode === "unified" ? (
                <ReviewSplitDiffIcon className="icon-xs" />
              ) : (
                <ReviewUnifiedDiffIcon className="icon-xs" />
              )}
            </button>
            <button
              type="button"
              className={toolbarIconButtonClassName({ active: fileTreeOpen })}
              aria-label={toggleFileTreeLabel}
              onClick={() => setFileTreeOpen((current) => !current)}
            >
              <SidePanelFilesIcon className="icon-sm" />
            </button>
            <button
              type="button"
              className={REVIEW_HEADER_ACTION_BUTTON_CLASS_NAME}
              aria-label="Commit or push"
              disabled={!canUseThreadGitActions}
              onClick={() => void startThreadPrompt(GIT_ACTION_COMMIT_OR_PUSH_PROMPT)}
            >
              <ReviewCommitOrPushIcon className="icon-xs shrink-0" />
              <span className={REVIEW_HEADER_ACTION_LABEL_CLASS_NAME}>Commit or push</span>
            </button>
            <button
              type="button"
              className={REVIEW_HEADER_ACTION_BUTTON_CLASS_NAME}
              aria-label="Create PR"
              disabled={!canUseThreadGitActions}
              onClick={() => void startThreadPrompt(GIT_ACTION_CREATE_PR_PROMPT)}
            >
              <ReviewCreatePrIcon className="icon-xs shrink-0" />
              <span className={REVIEW_HEADER_ACTION_LABEL_CLASS_NAME}>Create PR</span>
            </button>
          </div>
        </div>

        <div ref={reviewSplitRootRef} className="flex min-h-0 max-w-full min-w-0">
          {reviewMainContent}
          {fileTreePane}
        </div>
      </div>
    </div>
  );
}
