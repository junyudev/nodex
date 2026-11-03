import { toastFailure } from "@/lib/failure-toast";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import type { CodexSubagentRow } from "../../../../../shared/codex-subagent-row-model";
import { PictureInPicture2, Slash } from "@/components/shared/icons/generic-icons";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  BranchStatusIcon,
  ChevronDownIcon,
  ClockIcon,
  CloseIcon,
  ComposerPlanModeIcon,
  SidePanelSideChatIcon,
  LocalStatusIcon,
  ActivitySpinnerIcon,
  ThreadSummaryChangesIcon,
  ThreadSummaryCommitIcon,
  ThreadSummaryCreatePullRequestIcon,
  ThreadSummaryPushIcon,
  OpenInIcon,
} from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { BranchSelectorPopover } from "../shared/branch-selector-popover";
import {
  ThreadExecutionLocationSelector,
  type ThreadExecutionLocationModel,
} from "./thread-execution-location-selector";
import { ToolActivityIcon, type ToolActivityIconDescriptor } from "../shared/tools/tool-call-icons";
import {
  EMPTY_BRANCH_SELECTOR_STATE,
  isBranchSelectorMutationCurrent,
  parseBranchSelectorState,
  resolveBranchSelectorCwd,
  type BranchSelectorState,
} from "../shared/branch-selector-state";
import { DiffStats } from "../shared/tools/diff-file-shared";
import { ConnectorGlobeIcon } from "@/components/shared/icons";
import { useMcpResource, useMcpServerStatuses } from "../../../../lib/use-mcp-queries";
import { useCodexMcpApps } from "../../use-codex-mcp-apps";
import { useGitBranchState } from "../../../../lib/use-git-branch-state";
import { useSummaryGitState } from "../../data/use-summary-git-state";
import { threadSummaryGitOperations } from "../../thread-summary-git-operations";
import { cn } from "../../../../lib/utils";
import type {
  CodexConversationChildMembership,
  CodexConversationSnapshot,
  CodexConversationTurn,
  GitActionStatusResult,
  GhPrStatusResult,
  GitReviewSource,
  ProtocolListMcpServerStatusResponse,
} from "../../../../lib/types";
import { buildBackgroundAgentOpenContext } from "../../projection/background-subagent-open-context";
import { buildBackgroundSubagentRows } from "../../projection/background-subagent-row-model";
import {
  buildBackgroundSubagentCompactStripModel,
  getBackgroundSubagentListRows,
  type BackgroundSubagentCompactStripModel,
} from "../../projection/background-subagent-summary-model";
import { useThreadSummaryOutputRows } from "../../use-turn-end-resources";
import { describeThreadOutput } from "../../projection/thread-output-presentation";
import { useThreadOutputDestination } from "../use-thread-output-destination";
import {
  isContextMenuKey,
  ThreadOutputIcon,
  useThreadOutputOpener,
} from "../use-thread-output-opener";
import { type ThreadSummaryPanelOutputRow } from "../../projection/thread-summary-panel-output-model";
import {
  buildThreadSummaryPanelPlanRow,
  type ThreadSummaryPanelPlanRow,
} from "../../projection/thread-summary-panel-plan-model";
import {
  buildThreadSummaryPanelSourceModel,
  type ThreadSummaryPanelSourceItem,
  type ThreadSummaryPanelSourceOpenAction,
} from "../../projection/thread-summary-panel-source-model";
import {
  buildThreadSummaryPanelSectionModel,
  type ThreadSummaryPanelSectionModel,
} from "../../projection/thread-summary-panel-section-model";
import type {
  ConversationBackgroundTasks,
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadStageActions,
  ThreadSummaryPanelComputerUsePipState,
  ThreadSummaryPanelAuxiliaryRow,
  ThreadSummaryPanelBrowserRow,
  ThreadSummaryPanelScheduledAutomationRow,
} from "../../thread-stage-types";
import { ThreadSummaryPanelRow } from "./thread-summary-panel-row";
import {
  ThreadSummaryPanelCountBadge,
  ThreadSummaryPanelSection,
} from "./thread-summary-panel-section";
import {
  ThreadSummaryGitActionDialog,
  type SummaryGitActionDialogMode,
  type SummaryGitActionWorkflowPhase,
  type SummaryGitActionWorkflowState,
} from "./thread-summary-git-action-dialog";
import { ThreadSummaryCreatePullRequestDialog } from "./thread-summary-create-pull-request-dialog";
import { ThreadSummaryBackgroundSection } from "./thread-summary-background-section";
import { ThreadSummaryBranchSetupDialog } from "./thread-summary-branch-setup-dialog";
import {
  ThreadPinnedSummaryPanelShell,
  ThreadSummaryPanelPopoverShell,
} from "./thread-summary-panel-shell";
import { SubagentAvatar, SubagentGlyphIcon } from "../shared/subagent-avatar";
import { CodexShimmerText } from "../shared/codex-shimmer-text";
import {
  buildMcpAppSidePanelInput,
  resolveMcpAppResourceUri,
  resolveMcpEmbeddedRenderableResource,
  resolveMcpRenderableResource,
} from "../shared/tools/mcp-tool-call-resource-utils";
import {
  REMOTE_HOSTED_PIP_HOME_SURFACE_ATTRIBUTE,
  REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE,
} from "../../../../../shared/remote-hosted-pip";

const EMPTY_CHILD_MEMBERSHIPS: readonly CodexConversationChildMembership[] = [];
const EMPTY_KNOWN_CONVERSATIONS_BY_ID: Record<string, CodexConversationSnapshot> = {};
const EMPTY_SIDE_CHAT_ROWS: readonly ThreadSummaryPanelAuxiliaryRow[] = [];
const EMPTY_BROWSER_ROWS: readonly ThreadSummaryPanelBrowserRow[] = [];
const EMPTY_MCP_SERVER_STATUSES: ProtocolListMcpServerStatusResponse = {
  data: [],
  nextCursor: null,
};

export interface ThreadSummaryPanelContentProps {
  sourceRoot?: { readonly hostId: string; readonly threadId: string };
  activeThreadId: string | null;
  activeThreadTitle?: string | null;
  activeThreadIsManagedWorktree?: boolean;
  activeThreadProjectless?: boolean;
  cwd: string | null;
  projectlessOutputDirectory?: string | null;
  projectWorkspacePath: string | null;
  turns: readonly CodexConversationTurn[];
  /** Live background work the conversation's Agents left running, with Stop and output. */
  backgroundTasks?: ConversationBackgroundTasks | null;
  backgroundAgentRows?: readonly CodexSubagentRow[];
  childMemberships?: readonly CodexConversationChildMembership[];
  knownConversationsById?: Record<string, CodexConversationSnapshot>;
  sideChatRows?: readonly ThreadSummaryPanelAuxiliaryRow[];
  browserRows?: readonly ThreadSummaryPanelBrowserRow[];
  scheduledAutomation?: ThreadSummaryPanelScheduledAutomationRow | null;
  computerUsePip?: ThreadSummaryPanelComputerUsePipState | null;
  isVisible?: boolean;
  executionLocation?: ThreadExecutionLocationModel | null;
  actions?: Partial<ThreadStageActions>;
  taskDetailsKind?: "thread" | "observation";
  onOpenThread?: ThreadStageActions["onOpenThread"];
}

interface ThreadFloatingSummaryPanelProps extends ThreadSummaryPanelContentProps {
  hideImmediately?: boolean;
  mounted: boolean;
  open: boolean;
}

interface SummaryGitActionStatusState {
  loading: boolean;
  cwd: string | null;
  status: GitActionStatusResult | null;
}

interface SummaryPullRequestStatusState {
  loading: boolean;
  cwd: string | null;
  status: GhPrStatusResult | null;
}

type SummaryCommitBlockerReason = "changes-loading" | "changes-unavailable" | "no-changes";
type SummaryPushBlockerReason = "branch-missing" | "nothing-to-push" | "push-status-loading";

type SummaryCommitOrPushMode = "commit" | "push";
type SummaryBranchSetupNextAction = SummaryGitActionDialogMode | "create-pull-request";

function getSummaryGitActionPhaseLabel(phase: SummaryGitActionWorkflowPhase): string {
  if (phase === "generating-commit-message" || phase === "generating-pr-message")
    return "Generating messages…";
  if (phase === "pushing") return "Pushing changes…";
  if (phase === "creating-pr") return "Creating PR…";
  return "Committing…";
}

function getSummaryCommitBlockerLabel(reason: SummaryCommitBlockerReason): string {
  if (reason === "changes-loading") return "Loading diff…";
  if (reason === "changes-unavailable") return "Commit is unavailable right now";
  return "No changes to commit";
}

function getSummaryPushBlockerLabel(reason: SummaryPushBlockerReason): string {
  if (reason === "branch-missing") return "Branch information unavailable";
  if (reason === "nothing-to-push") return "No new commits to push";
  return "Loading push status…";
}

function resolveSummaryCommitBlockerReason({
  hasUncommittedChanges,
  isChangesLoading,
  isChangesUnavailable,
}: {
  hasUncommittedChanges: boolean;
  isChangesLoading: boolean;
  isChangesUnavailable: boolean;
}): SummaryCommitBlockerReason | null {
  if (isChangesLoading) return "changes-loading";
  if (isChangesUnavailable) return "changes-unavailable";
  if (!hasUncommittedChanges) return "no-changes";
  return null;
}

function resolveSummaryPushBlockerReason({
  status,
  loading,
}: {
  status: GitActionStatusResult | null;
  loading: boolean;
}): SummaryPushBlockerReason | null {
  if (loading || !status) return "push-status-loading";
  if (!status.currentBranch) return "branch-missing";
  if (status.commitsAhead === 0) return "nothing-to-push";
  return null;
}

function resolveSummaryCommitOrPushMode({
  hasUncommittedChanges,
  hasBranchChanges,
}: {
  hasUncommittedChanges: boolean;
  hasBranchChanges: boolean;
}): SummaryCommitOrPushMode | null {
  if (hasUncommittedChanges) return "commit";
  if (hasBranchChanges) return "push";
  return null;
}

function buildSummarySourceIconDescriptor(
  item: ThreadSummaryPanelSourceItem,
): ToolActivityIconDescriptor {
  if (item.kind !== "tool") return { kind: "semantic", icon: "web-search" };

  if (!item.logoUrl && !item.logoUrlDark) {
    return { kind: "semantic", icon: "connector" };
  }

  return {
    kind: "logo",
    alt: `${item.label} logo`,
    logoUrl: item.logoUrl,
    logoDarkUrl: item.logoUrlDark,
    fallbackIcon: "connector",
  };
}

function useSummarySourceMcpAppInput(item: ThreadSummaryPanelSourceItem, enabled: boolean) {
  const immediateInput = item.openAction?.type === "mcpApp" ? item.openAction.input : null;
  const target = item.mcpAppTarget;
  const shouldResolve = enabled && !immediateInput && Boolean(target);
  const { data: statusData } = useMcpServerStatuses({
    enabled: shouldResolve,
  });
  const mcpServerStatuses = statusData ?? EMPTY_MCP_SERVER_STATUSES;
  const resourceUri = useMemo(
    () =>
      target ? resolveMcpAppResourceUri({ payload: target.payload, mcpServerStatuses }) : null,
    [mcpServerStatuses, target],
  );
  const resourceParams = useMemo(() => {
    if (!target || !resourceUri) return null;
    return {
      threadId: target.threadId,
      server: target.payload.invocation.server,
      uri: resourceUri,
    };
  }, [resourceUri, target]);
  const { data: resourceResponse = null } = useMcpResource(resourceParams, {
    enabled: shouldResolve,
  });
  const fetchedResource = useMemo(
    () => (resourceUri ? resolveMcpRenderableResource(resourceUri, resourceResponse) : null),
    [resourceResponse, resourceUri],
  );
  const embeddedResource = useMemo(
    () =>
      target
        ? resolveMcpEmbeddedRenderableResource({ payload: target.payload, mcpServerStatuses })
        : null,
    [mcpServerStatuses, target],
  );
  const resource = fetchedResource ?? embeddedResource;

  if (immediateInput) return immediateInput;
  if (!target || !resource) return null;

  return buildMcpAppSidePanelInput({
    threadId: target.threadId,
    payload: target.payload,
    resource,
  });
}

function SummarySourceIcon({
  item,
  canOpenMcpApps,
  onOpenSource,
}: {
  item: ThreadSummaryPanelSourceItem;
  canOpenMcpApps: boolean;
  onOpenSource: (action: ThreadSummaryPanelSourceOpenAction) => void;
}) {
  const resolvedMcpAppInput = useSummarySourceMcpAppInput(item, canOpenMcpApps);
  const openAction =
    item.openAction?.type === "url"
      ? item.openAction
      : resolvedMcpAppInput
        ? { type: "mcpApp" as const, input: resolvedMcpAppInput }
        : null;
  const icon = (
    <ToolActivityIcon
      descriptor={buildSummarySourceIconDescriptor(item)}
      className="icon-xs shrink-0"
    />
  );

  const trigger = openAction ? (
    <button
      type="button"
      aria-label={item.label}
      className="flex size-6 shrink-0 cursor-interaction items-center justify-center rounded-sm text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-foreground"
      onClick={() => onOpenSource(openAction)}
    >
      {icon}
    </button>
  ) : (
    <span
      role="img"
      aria-label={item.label}
      className="flex size-6 shrink-0 items-center justify-center rounded-sm text-token-text-secondary"
    >
      {icon}
    </span>
  );

  return (
    <NodexTooltip tooltipContent={item.label} side="left">
      {trigger}
    </NodexTooltip>
  );
}

function SummarySourceIconStrip({
  items,
  canOpenMcpApps,
  onOpenSource,
}: {
  items: readonly ThreadSummaryPanelSourceItem[];
  canOpenMcpApps: boolean;
  onOpenSource: (action: ThreadSummaryPanelSourceOpenAction) => void;
}) {
  if (items.length === 0) {
    return <div className="py-1 text-sm text-token-description-foreground">No sources yet</div>;
  }

  return (
    <ul className="-ml-1 flex flex-wrap gap-0.5" aria-label="Sources">
      {items.map((item) => (
        <li key={item.id} className="flex">
          <SummarySourceIcon
            item={item}
            canOpenMcpApps={canOpenMcpApps}
            onOpenSource={onOpenSource}
          />
        </li>
      ))}
    </ul>
  );
}

function SummaryDropdownRowLabel({ label }: { label: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-token-foreground">
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDownIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
    </span>
  );
}

function getBrowserRowVisibleDisplayUrl(row: ThreadSummaryPanelBrowserRow): string | null {
  if (!row.displayUrl) return null;
  if (row.displayUrl === row.title) return null;
  return row.displayUrl;
}

function getBrowserRowAriaLabel(row: ThreadSummaryPanelBrowserRow): string {
  const displayUrl = getBrowserRowVisibleDisplayUrl(row);
  return displayUrl ? `${row.title} ${displayUrl}` : row.title;
}

function getBrowserRowTitle(row: ThreadSummaryPanelBrowserRow): string {
  if (row.url.length === 0) return row.title;
  return `${row.title}\n${row.url}`;
}

function getScheduledAutomationTitle(row: ThreadSummaryPanelScheduledAutomationRow): string {
  return `Next run: ${row.nextRunLabel}`;
}

function SummaryScheduledAutomationLabel({
  row,
}: {
  row: ThreadSummaryPanelScheduledAutomationRow;
}) {
  return (
    <>
      <span className="min-w-0 flex-1 truncate">{row.name}</span>
      {row.scheduleSummary ? (
        <span className="max-w-48 shrink-0 truncate text-sm text-token-text-secondary">
          {row.scheduleSummary}
        </span>
      ) : null}
    </>
  );
}

function SummaryComputerUsePipTrailing({ visible }: { visible: boolean }) {
  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center text-token-text-tertiary">
      <PictureInPicture2 className="size-5" aria-hidden="true" />
      {visible ? null : <Slash className="absolute size-5" aria-hidden="true" />}
    </span>
  );
}

function SummaryBrowserFavicon({
  faviconUrl,
  isAgentWorking,
}: {
  faviconUrl: string | null;
  isAgentWorking: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const iconClassName = cn("size-full", isAgentWorking && "opacity-30");

  if (!faviconUrl || failed) {
    return <ConnectorGlobeIcon className={iconClassName} aria-hidden={true} />;
  }

  return (
    <img
      src={faviconUrl}
      alt=""
      className={cn("size-full rounded-[2px] object-contain", isAgentWorking && "opacity-30")}
      onError={() => setFailed(true)}
    />
  );
}

const BROWSER_USE_POINTER_PATH =
  "M12.725 20.288c-.367.716-.842 1.166-1.425 1.35-.583.191-1.15.12-1.7-.213-.55-.325-.954-.846-1.213-1.563L3.787 6.95c-.175-.492-.216-.958-.124-1.4.091-.45.291-.83.6-1.137a2.187 2.187 0 0 1 1.137-.6c.45-.092.92-.05 1.412.125l12.913 4.6c.717.258 1.237.662 1.563 1.212.333.542.404 1.104.212 1.688-.183.583-.633 1.058-1.35 1.425l-4.925 2.512-2.5 4.913Z";

function BrowserUsePointerIcon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("relative flex items-center justify-center", className)}
      data-browser-use-pointer="true"
    >
      <svg
        className="absolute inset-0 size-full"
        fill="none"
        viewBox="0 0 24 24"
        style={{ color: "var(--color-token-main-surface-primary)" }}
      >
        <path
          d={BROWSER_USE_POINTER_PATH}
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      </svg>
      <svg
        className="absolute inset-0 size-full text-token-text-primary"
        fill="none"
        viewBox="0 0 24 24"
      >
        <path d={BROWSER_USE_POINTER_PATH} fill="currentColor" />
      </svg>
    </span>
  );
}

function SummaryBrowserRowIcon({ row }: { row: ThreadSummaryPanelBrowserRow }) {
  return (
    <span
      aria-hidden={true}
      className="icon-xs relative flex shrink-0 items-center justify-center overflow-visible"
    >
      <SummaryBrowserFavicon faviconUrl={row.faviconUrl} isAgentWorking={row.isAgentWorking} />
      {row.isAgentWorking ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <BrowserUsePointerIcon className="size-4" />
        </span>
      ) : null}
    </span>
  );
}

function SummaryBrowserRowLabel({ row }: { row: ThreadSummaryPanelBrowserRow }) {
  const displayUrl = getBrowserRowVisibleDisplayUrl(row);
  const content = (
    <>
      <span className={cn("min-w-0 truncate", displayUrl && "max-w-[60%]")}>{row.title}</span>
      {displayUrl ? (
        <span className="min-w-0 max-w-[40%] truncate text-sm text-token-text-tertiary">
          {displayUrl}
        </span>
      ) : null}
    </>
  );

  if (!row.isAgentWorking) return content;

  return (
    <CodexShimmerText variant="classic" className="flex min-w-0 items-baseline gap-2">
      {content}
    </CodexShimmerText>
  );
}

function getBackgroundSubagentTitle(row: ThreadComposerShellBackgroundAgentRowModel): string {
  return [
    row.displayName,
    row.agentRole ? `Role: ${row.agentRole}` : null,
    row.spawnModel ? `Model: ${row.spawnModel}` : null,
    row.statusSummary ? `Status: ${row.statusSummary}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function BackgroundSubagentRowLabel({ row }: { row: ThreadComposerShellBackgroundAgentRowModel }) {
  const active = row.status === "active";
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {row.identityThreadId === null ? (
        <SubagentGlyphIcon className="size-3.5 shrink-0" />
      ) : (
        <SubagentAvatar seed={row.identityThreadId} className="size-3.5 pointer-events-none" />
      )}
      <span className="min-w-0 truncate font-medium">{row.displayName}</span>
      {active ? (
        <CodexShimmerText
          variant="classic"
          className="shrink-0 whitespace-nowrap text-sm text-token-text-tertiary"
        >
          is working
        </CodexShimmerText>
      ) : null}
    </span>
  );
}

function BackgroundSubagentRowTrailing({
  row,
}: {
  row: ThreadComposerShellBackgroundAgentRowModel;
}) {
  if (!row.diffStats) return null;

  return (
    <DiffStats
      additions={row.diffStats.linesAdded}
      deletions={row.diffStats.linesRemoved}
      className="shrink-0 text-sm"
    />
  );
}

/** One output in the summary, marked when opening it leaves Nodex. */
function ThreadSummaryOutputRow({
  row,
  cwd,
  hostId,
  outputs,
  onOpen,
}: {
  row: ThreadSummaryPanelOutputRow;
  cwd: string | null | undefined;
  hostId: string;
  outputs: ReturnType<typeof useThreadOutputOpener>;
  onOpen: (
    row: ThreadSummaryPanelOutputRow,
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
  ) => void;
}) {
  const destination = useThreadOutputDestination(row, hostId);
  return (
    <ThreadSummaryPanelRow
      label={describeThreadOutput(row, cwd).title}
      title={row.title}
      icon={<ThreadOutputIcon row={row} className="size-4" />}
      trailing={
        destination === "external-browser" ? (
          <OpenInIcon className="icon-xs" aria-hidden />
        ) : undefined
      }
      interactive
      onClick={(event) => onOpen(row, event)}
      onContextMenu={(event) => outputs.openContextMenu(row, event)}
      onKeyDown={(event) => {
        if (isContextMenuKey(event)) outputs.openContextMenu(row, event);
      }}
    />
  );
}

function BackgroundSubagentCompactStrip({
  model,
  onOpenSubagentsPanel,
}: {
  model: BackgroundSubagentCompactStripModel<ThreadComposerShellBackgroundAgentRowModel>;
  onOpenSubagentsPanel: ThreadStageActions["onOpenSubagentsPanel"] | undefined;
}) {
  if (model.displayRows.length === 0) return null;

  const content = (
    <>
      <span className="flex shrink-0 items-center gap-1.5">
        {model.displayRows.map((row) =>
          row.identityThreadId === null ? (
            <SubagentGlyphIcon key={row.conversationId} className="size-3.5 shrink-0" />
          ) : (
            <SubagentAvatar key={row.conversationId} seed={row.identityThreadId} />
          ),
        )}
      </span>
      {model.workingCount > 0 ? (
        <span className="text-sm whitespace-nowrap text-token-foreground">
          {model.workingCount} working
        </span>
      ) : null}
      {model.doneCount > 0 ? (
        <span className="text-sm whitespace-nowrap text-token-text-tertiary">
          {model.doneCount} done
        </span>
      ) : null}
    </>
  );

  if (!onOpenSubagentsPanel) {
    return <div className="flex min-h-8 items-center gap-2">{content}</div>;
  }

  return (
    <button
      type="button"
      aria-label="Open subagents"
      className="flex min-h-8 w-full cursor-interaction items-center gap-2 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2"
      onClick={() => void onOpenSubagentsPanel()}
    >
      {content}
    </button>
  );
}

function useSummaryReadStatus<T>(
  cwd: string | null,
  open: boolean,
  refreshKey: number,
  read: (cwd: string) => Promise<T>,
): { loading: boolean; cwd: string | null; status: T | null } {
  const [request, setRequest] = useState({ cwd, open, refreshKey });
  const [result, setResult] = useState<{ request: typeof request; status: T | null } | null>(null);
  if (request.cwd !== cwd || request.open !== open || request.refreshKey !== refreshKey) {
    setRequest({ cwd, open, refreshKey });
  }
  useEffect(() => {
    if (!request.open || !request.cwd) return;
    let cancelled = false;
    void read(request.cwd).then(
      (status) => {
        if (!cancelled) setResult({ request, status });
      },
      () => {
        if (!cancelled) setResult({ request, status: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [request, read]);
  if (!open || !cwd) return { loading: false, cwd: null, status: null };
  return {
    loading: result?.request !== request,
    cwd,
    status: result?.request === request ? result.status : null,
  };
}

function useSummaryGitActionStatus(
  cwd: string | null,
  open: boolean,
  refreshKey = 0,
): SummaryGitActionStatusState {
  return useSummaryReadStatus(cwd, open, refreshKey, threadSummaryGitOperations.readStatus);
}

function useSummaryPullRequestStatus(
  cwd: string | null,
  open: boolean,
  refreshKey = 0,
): SummaryPullRequestStatusState {
  return useSummaryReadStatus(
    cwd,
    open,
    refreshKey,
    threadSummaryGitOperations.readPullRequestStatus,
  );
}

function useSummaryPanelBranchState({ cwd, enabled }: { cwd: string | null; enabled: boolean }) {
  const [branchState, setBranchState] = useState<BranchSelectorState>(EMPTY_BRANCH_SELECTOR_STATE);
  const [busy, setBusy] = useState(false);
  const branchCwdRef = useRef<string | null>(cwd);
  const mutationRequestIdRef = useRef(0);
  const {
    data: branchStateData,
    isError: branchStateError,
    isFetching: branchStateFetching,
    isLoading: branchStateLoading,
    refetch: refetchBranchState,
  } = useGitBranchState(cwd, {
    enabled,
    watch: true,
  });
  useLayoutEffect(() => {
    branchCwdRef.current = cwd;
  }, [cwd]);

  const resetBranchState = useCallback(() => {
    setBranchState(EMPTY_BRANCH_SELECTOR_STATE);
  }, []);

  const refreshBranchState = useCallback(async () => {
    if (!enabled) {
      resetBranchState();
      return;
    }
    const requestedCwd = branchCwdRef.current;
    if (!requestedCwd) {
      resetBranchState();
      return;
    }

    try {
      const result = await refetchBranchState();
      if (branchCwdRef.current !== requestedCwd) return;
      if (!result.data) {
        resetBranchState();
        return;
      }
      setBranchState(parseBranchSelectorState(result.data));
    } catch {
      if (branchCwdRef.current !== requestedCwd) return;
      setBranchState(EMPTY_BRANCH_SELECTOR_STATE);
    }
  }, [enabled, refetchBranchState, resetBranchState]);

  const [previousQuery, setPreviousQuery] = useState<{
    branchStateData: typeof branchStateData;
    cwd: typeof cwd;
    enabled: typeof enabled;
  } | null>(null);
  if (
    previousQuery === null ||
    previousQuery.branchStateData !== branchStateData ||
    previousQuery.cwd !== cwd ||
    previousQuery.enabled !== enabled
  ) {
    setPreviousQuery({ branchStateData, cwd, enabled });
    setBranchState(
      enabled && cwd && branchStateData
        ? parseBranchSelectorState(branchStateData)
        : EMPTY_BRANCH_SELECTOR_STATE,
    );
  }

  const checkoutBranch = useCallback(
    async (branch: string) => {
      const requestedCwd = cwd;
      if (!requestedCwd) return false;
      const requestId = mutationRequestIdRef.current + 1;
      mutationRequestIdRef.current = requestId;
      const isCurrentRequest = () =>
        isBranchSelectorMutationCurrent({
          activeRequestId: mutationRequestIdRef.current,
          requestId,
          activeCwd: branchCwdRef.current,
          requestedCwd,
        });

      setBusy(true);
      return runWithCleanup(
        async () => {
          const result = await threadSummaryGitOperations.checkoutBranch(requestedCwd, branch);
          if (!isCurrentRequest()) return false;
          if (result.type === "error") throw new Error(result.errorMessage);
          setBranchState(parseBranchSelectorState(result.value));
          return true;
        },
        {
          cleanup: () => {
            if (isCurrentRequest()) setBusy(false);
          },
          onError: (error) => {
            if (isCurrentRequest()) {
              toastFailure("Couldn’t switch branches", error);
            }
            return false;
          },
        },
      );
    },
    [cwd],
  );

  const createBranch = useCallback(
    async (branch: string) => {
      const requestedCwd = cwd;
      if (!requestedCwd) return false;
      const requestId = mutationRequestIdRef.current + 1;
      mutationRequestIdRef.current = requestId;
      const isCurrentRequest = () =>
        isBranchSelectorMutationCurrent({
          activeRequestId: mutationRequestIdRef.current,
          requestId,
          activeCwd: branchCwdRef.current,
          requestedCwd,
        });

      setBusy(true);
      return runWithCleanup(
        async () => {
          const result = await threadSummaryGitOperations.createBranch(requestedCwd, branch);
          if (!isCurrentRequest()) return false;
          if (result.type === "error") throw new Error(result.errorMessage);
          setBranchState(parseBranchSelectorState(result.value));
          return true;
        },
        {
          cleanup: () => {
            if (isCurrentRequest()) setBusy(false);
          },
          onError: (cause) => {
            if (!isCurrentRequest()) return false;
            throw cause;
          },
        },
      );
    },
    [cwd],
  );

  return {
    branchState,
    busy,
    error: branchStateError,
    loading:
      branchStateLoading || (branchStateFetching && branchState === EMPTY_BRANCH_SELECTOR_STATE),
    refreshBranchState,
    checkoutBranch,
    createBranch,
  };
}

export function ThreadSummaryPanelSurface({
  sourceRoot,
  activeThreadId,
  activeThreadTitle = null,
  activeThreadIsManagedWorktree = false,
  activeThreadProjectless = false,
  cwd,
  projectlessOutputDirectory = null,
  projectWorkspacePath,
  turns,
  backgroundTasks = null,
  backgroundAgentRows: projectedBackgroundAgentRows,
  childMemberships = EMPTY_CHILD_MEMBERSHIPS,
  knownConversationsById = EMPTY_KNOWN_CONVERSATIONS_BY_ID,
  sideChatRows = EMPTY_SIDE_CHAT_ROWS,
  browserRows = EMPTY_BROWSER_ROWS,
  scheduledAutomation = null,
  computerUsePip = null,
  isVisible = true,
  executionLocation,
  actions,
  taskDetailsKind = "thread",
  onOpenThread,
}: Omit<ThreadFloatingSummaryPanelProps, "mounted" | "open">) {
  const branchCwd = useMemo(
    () => resolveBranchSelectorCwd(cwd, projectWorkspacePath),
    [cwd, projectWorkspacePath],
  );
  const [gitActionDialogMode, setGitActionDialogMode] = useState<SummaryGitActionDialogMode | null>(
    null,
  );
  const [createPullRequestDialogOpen, setCreatePullRequestDialogOpen] = useState(false);
  const [gitActionWorkflow, setGitActionWorkflow] = useState<SummaryGitActionWorkflowState | null>(
    null,
  );
  const [branchSetupOpen, setBranchSetupOpen] = useState(false);
  const [branchSetupNextAction, setBranchSetupNextAction] =
    useState<SummaryBranchSetupNextAction | null>(null);
  const [gitActionRefreshKey, setGitActionRefreshKey] = useState(0);
  const gitSummary = useSummaryGitState(branchCwd, isVisible);
  const gitActionStatus = useSummaryGitActionStatus(branchCwd, isVisible, gitActionRefreshKey);
  const {
    branchState,
    busy: branchBusy,
    checkoutBranch,
    createBranch,
    error: branchError,
    loading: branchLoading,
    refreshBranchState,
  } = useSummaryPanelBranchState({ cwd: branchCwd, enabled: isVisible });
  const handleCreateBranch = useCallback(
    async (branch: string) => {
      try {
        return await createBranch(branch);
      } catch (cause) {
        toastFailure("Couldn’t create a branch", cause);
        return false;
      }
    },
    [createBranch],
  );
  const { data: mcpApps } = useCodexMcpApps({ enabled: isVisible });
  const sourceModel = useMemo(
    () => buildThreadSummaryPanelSourceModel(turns, mcpApps ?? []),
    [mcpApps, turns],
  );
  const handleOpenSource = useCallback(
    (action: ThreadSummaryPanelSourceOpenAction) => {
      if (action.type === "url") {
        window.open(action.url, "_blank", "noopener,noreferrer");
        return;
      }

      void actions?.onOpenMcpAppSidePanel?.(action.input);
    },
    [actions],
  );
  const planRow = useMemo(
    () => buildThreadSummaryPanelPlanRow({ activeThreadId, cwd, turns }),
    [activeThreadId, cwd, turns],
  );
  const outputRows = useThreadSummaryOutputRows({
    turns,
    hostId: sourceRoot?.hostId ?? "local",
    cwd,
    projectlessOutputDirectory,
  });
  const backgroundSubagentRows = useMemo(
    () =>
      (
        projectedBackgroundAgentRows ??
        buildBackgroundSubagentRows({
          childMemberships,
          knownConversationsById,
          parentTurns: turns,
        })
      ).filter((row) => row.displayName.trim().length > 0),
    [projectedBackgroundAgentRows, childMemberships, knownConversationsById, turns],
  );
  const compactBackgroundSubagentModel = useMemo(
    () => buildBackgroundSubagentCompactStripModel(backgroundSubagentRows),
    [backgroundSubagentRows],
  );
  const listedBackgroundSubagentRows = useMemo(
    () => getBackgroundSubagentListRows(backgroundSubagentRows),
    [backgroundSubagentRows],
  );
  const hasRepository = gitSummary.hasRepository;
  const currentBranch =
    branchState.currentBranch ??
    gitActionStatus.status?.currentBranch ??
    gitSummary.currentBranch ??
    null;
  const defaultBranch =
    branchState.defaultBranch ??
    gitActionStatus.status?.defaultBranch ??
    gitSummary.defaultBranch ??
    null;
  const pullRequestStatus = useSummaryPullRequestStatus(
    branchCwd,
    Boolean(isVisible && hasRepository && currentBranch),
    gitActionRefreshKey,
  );
  const isDetachedHead = Boolean(
    hasRepository && gitActionStatus.status?.hasHeadCommit && !currentBranch,
  );
  const isManagedWorktreeDefaultBranch = Boolean(
    activeThreadIsManagedWorktree &&
    currentBranch &&
    defaultBranch &&
    currentBranch === defaultBranch,
  );
  const changes = {
    additions: gitSummary.additions,
    deletions: gitSummary.deletions,
  };
  const hasUncommittedChanges = gitSummary.hasUncommittedChanges;
  const hasBranchChanges = gitSummary.hasBranchChanges;
  const hasChangesSnapshotError = gitSummary.error;
  const commitBlockerReason = resolveSummaryCommitBlockerReason({
    hasUncommittedChanges,
    isChangesLoading: gitSummary.loading,
    isChangesUnavailable: hasChangesSnapshotError,
  });
  const pushBlockerReason = resolveSummaryPushBlockerReason({
    status: gitActionStatus.status,
    loading: gitActionStatus.loading,
  });
  const commitOrPushMode = resolveSummaryCommitOrPushMode({
    hasUncommittedChanges,
    hasBranchChanges,
  });
  const commitOrPushBranchStatusPending = Boolean(
    commitOrPushMode === "commit" && hasRepository && !currentBranch && gitActionStatus.loading,
  );
  const commitOrPushBlockerLabel = commitOrPushBranchStatusPending
    ? "Branch information unavailable"
    : commitOrPushMode === "push"
      ? pushBlockerReason
        ? getSummaryPushBlockerLabel(pushBlockerReason)
        : null
      : commitBlockerReason
        ? getSummaryCommitBlockerLabel(commitBlockerReason)
        : null;
  const commitOrPushNeedsBranchSetup = Boolean(
    (isDetachedHead && commitOrPushMode === "commit") ||
    (isManagedWorktreeDefaultBranch && commitOrPushMode === "push"),
  );
  const createPullRequestNeedsBranchSetup = isManagedWorktreeDefaultBranch;
  const commitOrPushWorkflow =
    gitActionWorkflow?.workflow === "commit" || gitActionWorkflow?.workflow === "push"
      ? gitActionWorkflow
      : null;
  const createPullRequestWorkflow =
    gitActionWorkflow?.workflow === "create-pull-request" ? gitActionWorkflow : null;
  const existingPullRequestUrl =
    pullRequestStatus.status?.status === "ready" ? pullRequestStatus.status.url : null;
  const commitOrPushRowLabel = commitOrPushWorkflow
    ? getSummaryGitActionPhaseLabel(commitOrPushWorkflow.phase)
    : "Commit or push";
  const createPullRequestGhBlockerLabel =
    pullRequestStatus.status?.available === false
      ? (pullRequestStatus.status.message ?? "GitHub CLI unavailable")
      : null;
  const createPullRequestRowLabel = createPullRequestWorkflow
    ? getSummaryGitActionPhaseLabel(createPullRequestWorkflow.phase)
    : existingPullRequestUrl
      ? "Open pull request"
      : (createPullRequestGhBlockerLabel ?? "Create pull request");
  const createPullRequestRowTitle = createPullRequestWorkflow
    ? getSummaryGitActionPhaseLabel(createPullRequestWorkflow.phase)
    : pullRequestStatus.loading
      ? "Checking pull request"
      : existingPullRequestUrl
        ? (pullRequestStatus.status?.title ?? "Open pull request")
        : createPullRequestNeedsBranchSetup
          ? "Create branch"
          : currentBranch
            ? (createPullRequestGhBlockerLabel ?? "Create pull request")
            : "Branch information unavailable";
  const commitOrPushRowTitle = commitOrPushWorkflow
    ? getSummaryGitActionPhaseLabel(commitOrPushWorkflow.phase)
    : commitOrPushNeedsBranchSetup
      ? "Create branch"
      : (commitOrPushBlockerLabel ??
        (commitOrPushMode ? "Commit or push" : "No changes to commit or push"));
  const commitOrPushRowDisplayTitle =
    commitOrPushRowTitle === commitOrPushRowLabel ? undefined : commitOrPushRowTitle;
  const createPullRequestRowDisplayTitle =
    createPullRequestRowTitle === createPullRequestRowLabel ? undefined : createPullRequestRowTitle;
  const hasGitEnvironmentSummary = Boolean(
    branchCwd && !activeThreadProjectless && (hasRepository || gitSummary.loading),
  );
  const hasComputerUsePip =
    computerUsePip !== null && actions?.onToggleSummaryComputerUsePip !== undefined;
  const summarySections = useMemo(
    () =>
      buildThreadSummaryPanelSectionModel({
        activeThreadId,
        hasScheduledAutomation: scheduledAutomation !== null,
        hasEnvironment: hasGitEnvironmentSummary,
        hasPlan: planRow !== null,
        outputCount: outputRows.length,
        sideChatCount: sideChatRows.length,
        backgroundSubagentRows,
        taskCount: backgroundTasks?.tasks.length ?? 0,
        hasComputerUsePip,
        browserCount: browserRows.length,
        sourceCount: sourceModel.count,
      }),
    [
      activeThreadId,
      backgroundSubagentRows,
      backgroundTasks,
      browserRows.length,
      hasComputerUsePip,
      outputRows.length,
      planRow,
      scheduledAutomation,
      sideChatRows.length,
      sourceModel.count,
      hasGitEnvironmentSummary,
    ],
  );
  const primaryGitSource = gitSummary.primarySource;
  const runTargetLabel = activeThreadIsManagedWorktree ? "Worktree" : "Local";
  const worktreeAvailable = Boolean(
    branchCwd &&
    (branchState.currentBranch || branchState.defaultBranch || branchState.branches.length > 0),
  );

  const handleOpenGitReview = useCallback(
    (source: GitReviewSource) => {
      if (!hasRepository) return;
      void actions?.onOpenSummaryGitReview?.({ source });
    },
    [actions, hasRepository],
  );
  const handleOpenGitActionDialog = useCallback(
    (mode: "commit" | "push" | null) => {
      if (!hasRepository || gitSummary.loading || !mode) return;
      setGitActionDialogMode(mode);
    },
    [gitSummary.loading, hasRepository],
  );
  const handleOpenBranchSetup = useCallback(
    (nextAction: SummaryBranchSetupNextAction | null) => {
      if (!hasRepository || gitSummary.loading) return;
      setBranchSetupNextAction(nextAction);
      setBranchSetupOpen(true);
    },
    [gitSummary.loading, hasRepository],
  );
  const handleBranchSetupOpenChange = useCallback((nextOpen: boolean) => {
    setBranchSetupOpen(nextOpen);
    if (!nextOpen) setBranchSetupNextAction(null);
  }, []);
  const handleOpenCreatePullRequestDialog = useCallback(() => {
    if (!hasRepository || gitSummary.loading) return;
    setCreatePullRequestDialogOpen(true);
  }, [gitSummary.loading, hasRepository]);
  const handleBranchSetupCreated = useCallback(() => {
    setGitActionRefreshKey((current) => current + 1);
    void gitSummary.refresh();
    void refreshBranchState();
    if (branchSetupNextAction === "create-pull-request") {
      setCreatePullRequestDialogOpen(true);
    } else if (branchSetupNextAction) {
      setGitActionDialogMode(branchSetupNextAction);
    }
    setBranchSetupNextAction(null);
  }, [branchSetupNextAction, gitSummary, refreshBranchState]);
  const handleGitActionDialogOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) return;
    setGitActionDialogMode(null);
  }, []);
  const handleCreatePullRequestDialogOpenChange = useCallback((nextOpen: boolean) => {
    setCreatePullRequestDialogOpen(nextOpen);
  }, []);
  const handleGitActionCompleted = useCallback(() => {
    setGitActionRefreshKey((current) => current + 1);
    void gitSummary.refresh();
    void refreshBranchState();
  }, [gitSummary, refreshBranchState]);
  const handleCreatePullRequestCompleted = useCallback(() => {
    setGitActionRefreshKey((current) => current + 1);
    void gitSummary.refresh();
    void refreshBranchState();
  }, [gitSummary, refreshBranchState]);
  const handleCancelGitAction = useCallback((operationId: string) => {
    void threadSummaryGitOperations.cancel(operationId).finally(() => {
      setGitActionWorkflow((current) => (current?.operationId === operationId ? null : current));
      setGitActionDialogMode(null);
    });
  }, []);
  const outputs = useThreadOutputOpener({
    hostId: sourceRoot?.hostId ?? "local",
    cwd,
    workspaceRoot: projectWorkspacePath,
  });
  const handleOpenOutput = (
    row: ThreadSummaryPanelOutputRow,
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
  ) => {
    void outputs
      .openFromEvent(row, event)
      .then((opened) => {
        if (!opened) toastFailure("Couldn’t open the output");
      })
      .catch((cause: unknown) => toastFailure("Couldn’t open the output", cause));
  };
  const onOpenPlanInSidePanel = actions?.onOpenPlanInSidePanel;
  const handleOpenPlan = useCallback(
    (row: ThreadSummaryPanelPlanRow) => {
      void onOpenPlanInSidePanel?.(row.target);
    },
    [onOpenPlanInSidePanel],
  );
  const onOpenScheduledAutomation = actions?.onOpenSummaryScheduledAutomation;
  const onToggleComputerUsePip = actions?.onToggleSummaryComputerUsePip;
  const handleOpenScheduledAutomation = useCallback(
    (row: ThreadSummaryPanelScheduledAutomationRow) => {
      void onOpenScheduledAutomation?.({
        automationId: row.id,
        title: row.name,
      });
    },
    [onOpenScheduledAutomation],
  );
  const handleOpenAuxiliaryRow = useCallback(
    (
      row: Pick<ThreadSummaryPanelAuxiliaryRow, "id" | "panelId" | "leafId">,
      open: ThreadStageActions["onOpenSummarySideChatRow"],
    ) => {
      if (!open || !row.panelId) return;
      void open({
        rowId: row.id,
        panelId: row.panelId,
        leafId: row.leafId ?? null,
      });
    },
    [],
  );
  const handleOpenBrowserRow = useCallback(
    (row: ThreadSummaryPanelBrowserRow) => {
      void actions?.onOpenSummaryBrowserRow?.({
        browserTabId: row.browserTabId,
        rowId: row.id,
        ...(row.panelId ? { panelId: row.panelId } : {}),
        leafId: row.leafId ?? null,
      });
    },
    [actions],
  );
  return (
    <>
      <div
        data-testid="thread-summary-panel"
        {...{
          [REMOTE_HOSTED_PIP_HOME_SURFACE_ATTRIBUTE]: isVisible
            ? "thread-summary-panel"
            : undefined,
          [REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE]: isVisible ? "thread-summary-panel" : undefined,
        }}
        className="group/summary-panel relative flex max-h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-token-dropdown-background electron:elevation-prominent extension:border extension:border-token-border-default extension:shadow-md"
      >
        <div className="flex h-fit max-h-full min-h-0 min-w-0 flex-col overflow-x-hidden overflow-y-auto">
          <div className="flex flex-col gap-2 py-2.5">
            {summarySections.map((section: ThreadSummaryPanelSectionModel) => {
              switch (section.kind) {
                case "scheduled":
                  if (!scheduledAutomation) return null;
                  return (
                    <ThreadSummaryPanelSection
                      key={section.kind}
                      sectionKey="automation"
                      title="Scheduled"
                    >
                      <ThreadSummaryPanelRow
                        aria-label="Open scheduled task"
                        icon={<ClockIcon className="icon-xs shrink-0" />}
                        label={<SummaryScheduledAutomationLabel row={scheduledAutomation} />}
                        labelClassName="flex min-w-0 flex-1 items-baseline gap-2"
                        title={getScheduledAutomationTitle(scheduledAutomation)}
                        interactive={Boolean(onOpenScheduledAutomation)}
                        onClick={
                          onOpenScheduledAutomation
                            ? () => handleOpenScheduledAutomation(scheduledAutomation)
                            : undefined
                        }
                      />
                    </ThreadSummaryPanelSection>
                  );

                case "environment":
                  return (
                    <ThreadSummaryPanelSection
                      key={section.kind}
                      sectionKey="environment"
                      title="Environment"
                    >
                      <ThreadSummaryPanelRow
                        label="Changes"
                        icon={<ThreadSummaryChangesIcon className="icon-sm shrink-0" />}
                        interactive={Boolean(hasRepository && actions?.onOpenSummaryGitReview)}
                        disabled={
                          !hasRepository || gitSummary.loading || !actions?.onOpenSummaryGitReview
                        }
                        onClick={() => handleOpenGitReview(primaryGitSource)}
                        trailing={
                          gitSummary.loading ? (
                            <ActivitySpinnerIcon className="icon-xs shrink-0 text-token-text-tertiary" />
                          ) : changes.additions > 0 || changes.deletions > 0 ? (
                            <DiffStats
                              additions={changes.additions}
                              deletions={changes.deletions}
                              className="text-sm"
                            />
                          ) : null
                        }
                        trailingVisible
                      />
                      {executionLocation ? (
                        <ThreadExecutionLocationSelector
                          key={executionLocation.threadId}
                          model={executionLocation}
                          disabled={!isVisible}
                          worktreeAvailable={worktreeAvailable}
                        />
                      ) : (
                        <ThreadSummaryPanelRow
                          label={runTargetLabel}
                          icon={<LocalStatusIcon className="icon-sm text-token-foreground" />}
                        />
                      )}
                      {isDetachedHead ? (
                        <ThreadSummaryPanelRow
                          label="Create branch"
                          title="Create branch"
                          icon={<BranchStatusIcon className="icon-sm shrink-0" />}
                          interactive
                          disabled={!isVisible || branchBusy}
                          onClick={() => handleOpenBranchSetup(null)}
                        />
                      ) : (
                        <BranchSelectorPopover
                          cwd={branchCwd}
                          state={branchState}
                          busy={branchBusy}
                          loading={branchLoading}
                          error={branchError}
                          onRefresh={refreshBranchState}
                          onCheckout={checkoutBranch}
                          onCreate={handleCreateBranch}
                          selectedBranch={currentBranch}
                          disabled={!isVisible || !branchCwd || branchBusy}
                          side="left"
                          align="start"
                          sideOffset={4}
                          contentClassName="!w-[296px]"
                          renderTrigger={({ triggerLabel, title, disabled }) => (
                            <ThreadSummaryPanelRow
                              label={<SummaryDropdownRowLabel label={triggerLabel} />}
                              labelClassName="flex min-w-0 items-center"
                              title={title}
                              icon={<BranchStatusIcon className="icon-sm shrink-0" />}
                              disabled={disabled}
                              interactive
                            />
                          )}
                        />
                      )}
                      {isManagedWorktreeDefaultBranch ? (
                        <ThreadSummaryPanelRow
                          label="Create branch"
                          title="Create branch"
                          icon={<BranchStatusIcon className="icon-sm shrink-0" />}
                          interactive
                          disabled={!isVisible || branchBusy}
                          onClick={() => handleOpenBranchSetup(null)}
                        />
                      ) : null}
                      <ThreadSummaryPanelRow
                        label={commitOrPushRowLabel}
                        title={commitOrPushRowDisplayTitle}
                        icon={
                          commitOrPushMode === "push" ? (
                            <ThreadSummaryPushIcon className="icon-sm shrink-0" />
                          ) : (
                            <ThreadSummaryCommitIcon className="icon-sm shrink-0" />
                          )
                        }
                        interactive={Boolean(
                          hasRepository &&
                          commitOrPushMode &&
                          !commitOrPushWorkflow &&
                          (commitOrPushNeedsBranchSetup || !commitOrPushBlockerLabel),
                        )}
                        disabled={
                          !hasRepository ||
                          !commitOrPushMode ||
                          Boolean(commitOrPushWorkflow) ||
                          (!commitOrPushNeedsBranchSetup && Boolean(commitOrPushBlockerLabel))
                        }
                        trailing={
                          commitOrPushWorkflow ? (
                            <NodexTooltip tooltipContent="Cancel git action">
                              <button
                                type="button"
                                aria-label="Cancel git action"
                                className="cursor-interaction flex size-4 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-token-text-tertiary hover:text-token-foreground focus:outline-none"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleCancelGitAction(commitOrPushWorkflow.operationId);
                                }}
                              >
                                <CloseIcon className="icon-xs" aria-hidden="true" />
                              </button>
                            </NodexTooltip>
                          ) : undefined
                        }
                        trailingVisible={Boolean(commitOrPushWorkflow)}
                        onClick={() => {
                          if (commitOrPushNeedsBranchSetup) {
                            handleOpenBranchSetup("commit");
                            return;
                          }

                          handleOpenGitActionDialog(commitOrPushMode);
                        }}
                      />
                      <ThreadSummaryPanelRow
                        label={createPullRequestRowLabel}
                        title={createPullRequestRowDisplayTitle}
                        icon={
                          <ThreadSummaryCreatePullRequestIcon className="icon-sm shrink-0 text-token-text-tertiary" />
                        }
                        interactive={Boolean(
                          hasRepository &&
                          !createPullRequestWorkflow &&
                          !createPullRequestGhBlockerLabel &&
                          (existingPullRequestUrl ||
                            currentBranch ||
                            createPullRequestNeedsBranchSetup),
                        )}
                        disabled={
                          !hasRepository ||
                          Boolean(createPullRequestWorkflow) ||
                          gitSummary.loading ||
                          pullRequestStatus.loading ||
                          Boolean(createPullRequestGhBlockerLabel) ||
                          (!existingPullRequestUrl &&
                            !currentBranch &&
                            !createPullRequestNeedsBranchSetup)
                        }
                        trailing={
                          createPullRequestWorkflow ? (
                            <NodexTooltip tooltipContent="Cancel git action">
                              <button
                                type="button"
                                aria-label="Cancel git action"
                                className="cursor-interaction flex size-4 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-token-text-tertiary hover:text-token-foreground focus:outline-none"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleCancelGitAction(createPullRequestWorkflow.operationId);
                                }}
                              >
                                <CloseIcon className="icon-xs" aria-hidden="true" />
                              </button>
                            </NodexTooltip>
                          ) : undefined
                        }
                        trailingVisible={Boolean(createPullRequestWorkflow)}
                        onClick={() => {
                          if (existingPullRequestUrl) {
                            window.open(existingPullRequestUrl, "_blank", "noopener,noreferrer");
                            return;
                          }

                          if (createPullRequestNeedsBranchSetup) {
                            handleOpenBranchSetup("create-pull-request");
                            return;
                          }

                          handleOpenCreatePullRequestDialog();
                        }}
                      />
                    </ThreadSummaryPanelSection>
                  );

                case "plan":
                  if (!planRow) return null;
                  return (
                    <ThreadSummaryPanelSection key={section.kind} sectionKey="plan" title="Plan">
                      <ThreadSummaryPanelRow
                        icon={<ComposerPlanModeIcon className="icon-xs shrink-0" />}
                        label={planRow.label}
                        labelClassName="min-w-0 truncate"
                        title={planRow.title}
                        interactive={Boolean(onOpenPlanInSidePanel)}
                        onClick={onOpenPlanInSidePanel ? () => handleOpenPlan(planRow) : undefined}
                      />
                    </ThreadSummaryPanelSection>
                  );

                case "outputs":
                  return (
                    <ThreadSummaryPanelSection
                      key={section.kind}
                      sectionKey="artifacts"
                      title="Outputs"
                      titleSuffix={
                        <ThreadSummaryPanelCountBadge count={section.count ?? outputRows.length} />
                      }
                    >
                      {outputRows.map((row) => (
                        <ThreadSummaryOutputRow
                          key={row.id}
                          row={row}
                          cwd={cwd}
                          hostId={sourceRoot?.hostId ?? "local"}
                          outputs={outputs}
                          onOpen={handleOpenOutput}
                        />
                      ))}
                    </ThreadSummaryPanelSection>
                  );

                case "sideChats":
                  return (
                    <ThreadSummaryPanelSection
                      key={section.kind}
                      sectionKey="side-chats"
                      title="Side chats"
                      titleSuffix={
                        <ThreadSummaryPanelCountBadge
                          count={section.count ?? sideChatRows.length}
                        />
                      }
                    >
                      {sideChatRows.slice(0, 4).map((row) => (
                        <ThreadSummaryPanelRow
                          key={row.id}
                          label={row.title}
                          title={row.title}
                          icon={
                            row.isResponseInProgress ? (
                              <ActivitySpinnerIcon className="icon-sm shrink-0" />
                            ) : (
                              <SidePanelSideChatIcon className="icon-sm shrink-0" />
                            )
                          }
                          interactive={Boolean(actions?.onOpenSummarySideChatRow && row.panelId)}
                          onClick={
                            actions?.onOpenSummarySideChatRow && row.panelId
                              ? () => handleOpenAuxiliaryRow(row, actions.onOpenSummarySideChatRow)
                              : undefined
                          }
                        />
                      ))}
                    </ThreadSummaryPanelSection>
                  );

                case "subagents":
                  return (
                    <ThreadSummaryPanelSection
                      key={section.kind}
                      sectionKey="background-subagents"
                      title="Subagents"
                      titleSuffix={
                        section.count === null ? null : (
                          <ThreadSummaryPanelCountBadge count={section.count} />
                        )
                      }
                      autoCollapse={section.autoCollapse}
                    >
                      <BackgroundSubagentCompactStrip
                        model={compactBackgroundSubagentModel}
                        onOpenSubagentsPanel={actions?.onOpenSubagentsPanel}
                      />
                      {listedBackgroundSubagentRows.map((row) => (
                        <ThreadSummaryPanelRow
                          key={row.conversationId}
                          label={<BackgroundSubagentRowLabel row={row} />}
                          title={getBackgroundSubagentTitle(row)}
                          interactive={Boolean(
                            taskDetailsKind === "observation"
                              ? actions?.onOpenTaskObservation
                              : onOpenThread,
                          )}
                          onClick={
                            taskDetailsKind === "observation"
                              ? actions?.onOpenTaskObservation
                                ? () => actions.onOpenTaskObservation?.(row.conversationId)
                                : undefined
                              : onOpenThread
                                ? () => {
                                    void onOpenThread(
                                      row.conversationId,
                                      buildBackgroundAgentOpenContext(row, sourceRoot),
                                    );
                                  }
                                : undefined
                          }
                          trailing={<BackgroundSubagentRowTrailing row={row} />}
                          trailingVisible={Boolean(row.diffStats)}
                        />
                      ))}
                    </ThreadSummaryPanelSection>
                  );

                case "tasks":
                  return backgroundTasks ? (
                    <ThreadSummaryBackgroundSection
                      key={section.kind}
                      background={backgroundTasks}
                      autoCollapse={section.autoCollapse}
                    />
                  ) : null;

                case "computerUsePip": {
                  if (!computerUsePip || !onToggleComputerUsePip) return null;

                  const title = computerUsePip.visible ? "Hide PiP" : "Show PiP";
                  return (
                    <ThreadSummaryPanelSection
                      key={section.kind}
                      sectionKey="computer-use-pip"
                      mode="headerless"
                      title="Computer Use"
                    >
                      <ThreadSummaryPanelRow
                        aria-label={title}
                        icon={
                          <ToolActivityIcon
                            descriptor={{ kind: "semantic", icon: "computer-use" }}
                            className="icon-xs shrink-0"
                          />
                        }
                        label="Computer Use"
                        title={title}
                        interactive
                        onClick={() => {
                          void onToggleComputerUsePip(!computerUsePip.visible);
                        }}
                        trailing={
                          <SummaryComputerUsePipTrailing visible={computerUsePip.visible} />
                        }
                        trailingVisible
                      />
                    </ThreadSummaryPanelSection>
                  );
                }

                case "browser":
                  return (
                    <ThreadSummaryPanelSection
                      key={section.kind}
                      sectionKey="browser-tabs"
                      title="Browser"
                      titleSuffix={
                        <ThreadSummaryPanelCountBadge count={section.count ?? browserRows.length} />
                      }
                    >
                      {browserRows.map((row) => (
                        <ThreadSummaryPanelRow
                          key={row.browserTabId}
                          label={<SummaryBrowserRowLabel row={row} />}
                          title={getBrowserRowTitle(row)}
                          aria-label={getBrowserRowAriaLabel(row)}
                          icon={<SummaryBrowserRowIcon row={row} />}
                          labelClassName={cn(
                            "min-w-0 flex-1",
                            !row.isAgentWorking && "flex items-baseline gap-2",
                          )}
                          interactive={Boolean(actions?.onOpenSummaryBrowserRow)}
                          onClick={
                            actions?.onOpenSummaryBrowserRow
                              ? () => handleOpenBrowserRow(row)
                              : undefined
                          }
                        />
                      ))}
                    </ThreadSummaryPanelSection>
                  );

                case "sources":
                  return (
                    <ThreadSummaryPanelSection
                      key={section.kind}
                      sectionKey="tool-sources"
                      title="Sources"
                      titleSuffix={
                        <ThreadSummaryPanelCountBadge count={section.count ?? sourceModel.count} />
                      }
                    >
                      <SummarySourceIconStrip
                        items={sourceModel.items}
                        canOpenMcpApps={Boolean(actions?.onOpenMcpAppSidePanel)}
                        onOpenSource={handleOpenSource}
                      />
                    </ThreadSummaryPanelSection>
                  );

                case "emptyHint":
                  return (
                    <div key={section.kind} className="px-5 text-sm text-token-text-tertiary">
                      Start a thread to populate live summary rows.
                    </div>
                  );
              }
            })}
          </div>
        </div>
      </div>
      {outputs.preview}
      <ThreadSummaryGitActionDialog
        open={gitActionDialogMode !== null}
        cwd={branchCwd}
        initialMode={gitActionDialogMode ?? "commit"}
        onOpenChange={handleGitActionDialogOpenChange}
        onCompleted={handleGitActionCompleted}
        onWorkflowChange={setGitActionWorkflow}
      />
      <ThreadSummaryCreatePullRequestDialog
        open={createPullRequestDialogOpen}
        cwd={branchCwd}
        onOpenChange={handleCreatePullRequestDialogOpenChange}
        onCompleted={handleCreatePullRequestCompleted}
        onWorkflowChange={setGitActionWorkflow}
      />
      <ThreadSummaryBranchSetupDialog
        open={branchSetupOpen}
        branches={branchState.branches}
        currentBranch={currentBranch}
        defaultBranch={defaultBranch}
        threadTitle={activeThreadTitle}
        onCreateBranch={createBranch}
        onCreated={handleBranchSetupCreated}
        onOpenChange={handleBranchSetupOpenChange}
      />
    </>
  );
}

/** Live background work the summary lists, for the toggle that opens it. */
export function threadSummaryBackgroundCount(
  content: Pick<ThreadSummaryPanelContentProps, "backgroundTasks">,
): number {
  return content.backgroundTasks?.tasks.length ?? 0;
}

export function ThreadSummaryPanelPopover({
  onOpenChange,
  open: controlledOpen,
  ...props
}: ThreadSummaryPanelContentProps & {
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen == null) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange],
  );

  return (
    <ThreadSummaryPanelPopoverShell
      open={open}
      onOpenChange={handleOpenChange}
      backgroundCount={threadSummaryBackgroundCount(props)}
    >
      <ThreadSummaryPanelSurface {...props} isVisible={open} />
    </ThreadSummaryPanelPopoverShell>
  );
}

export function ThreadFloatingSummaryPanel({
  hideImmediately = false,
  mounted,
  open,
  ...props
}: ThreadFloatingSummaryPanelProps) {
  if (!mounted) return null;

  return (
    <ThreadPinnedSummaryPanelShell open={open} hideImmediately={hideImmediately}>
      <ThreadSummaryPanelSurface {...props} isVisible={open && !hideImmediately} />
    </ThreadPinnedSummaryPanelShell>
  );
}
