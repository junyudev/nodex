import { ListTree, PictureInPicture2, Slash } from "@/components/shared/icons/generic-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  BranchStatusIcon,
  FileIcon,
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
  TerminalIcon,
  NfmImageBlockIcon,
} from "@/components/shared/icons";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { BranchSelectorPopover } from "../shared/branch-selector-popover";
import { NewChatStartInSelector, StartInIcon } from "../shared/new-chat-start-in-selector";
import { ToolActivityIcon, type ToolActivityIconDescriptor } from "../shared/tools/tool-call-icons";
import {
  EMPTY_BRANCH_SELECTOR_STATE,
  isBranchSelectorMutationCurrent,
  parseBranchSelectorState,
  resolveBranchSelectorCwd,
  type BranchSelectorState,
} from "../shared/branch-selector-state";
import { DiffStats } from "../shared/tools/diff-file-shared";
import {
  ConnectorFallbackIcon,
  ConnectorGlobeIcon,
  PluginCubeIcon,
} from "@/components/shared/icons";
import { getGitWorkerClient, invoke } from "../../../../lib/api";
import {
  CODEX_SUMMARY_PANEL_TRANSITION,
  CODEX_SUMMARY_PANEL_WIDTH,
} from "../../../../lib/codex-panel-motion";
import {
  ImagePreviewDialog,
  resolveImageDisplaySource,
} from "@/features/user-attachment-image-editor";
import { useMcpResource, useMcpServerStatuses } from "../../../../lib/use-mcp-queries";
import { useCodexMcpApps } from "../../use-codex-mcp-apps";
import { useGitBranchState } from "../../../../lib/use-git-branch-state";
import { useSummaryGitState } from "../../data/use-summary-git-state";
import { cn } from "../../../../lib/utils";
import type {
  CodexBackgroundTerminalRow,
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
import {
  buildThreadSummaryPanelOutputRows,
  isThreadSummaryPanelImagePreviewableOutput,
  resolveThreadSummaryPanelOutputOpenTarget,
  type ThreadSummaryPanelOutputRow,
} from "../../projection/thread-summary-panel-output-model";
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
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadStageActions,
  ThreadStageRouteInput,
  ThreadSummaryPanelComputerUsePipState,
  ThreadSummaryPanelAuxiliaryRow,
  ThreadSummaryPanelBrowserRow,
  ThreadSummaryPanelScheduledAutomationRow,
} from "../../thread-stage-types";
import { ThreadSummaryPanelRow } from "./thread-summary-panel-row";
import { ThreadSummaryPanelSection } from "./thread-summary-panel-section";
import {
  ThreadSummaryGitActionDialog,
  type SummaryGitActionDialogMode,
  type SummaryGitActionWorkflowPhase,
  type SummaryGitActionWorkflowState,
} from "./thread-summary-git-action-dialog";
import { ThreadSummaryCreatePullRequestDialog } from "./thread-summary-create-pull-request-dialog";
import { ThreadSummaryBranchSetupDialog } from "./thread-summary-branch-setup-dialog";
import { ThreadSummaryPanelToggleButton } from "./thread-summary-panel-toggle";
import { SubagentAvatar } from "../shared/subagent-avatar";
import { CodexShimmerText } from "../shared/codex-shimmer-text";
import {
  buildMcpAppSidePanelInput,
  resolveMcpAppResourceUri,
  resolveMcpEmbeddedRenderableResource,
  resolveMcpRenderableResource,
} from "../shared/tools/mcp-tool-call-resource-utils";

const EMPTY_CHILD_MEMBERSHIPS: readonly CodexConversationChildMembership[] = [];
const EMPTY_KNOWN_CONVERSATIONS_BY_ID: Record<string, CodexConversationSnapshot> = {};
const EMPTY_BACKGROUND_TERMINAL_ROWS: readonly CodexBackgroundTerminalRow[] = [];
const EMPTY_SIDE_CHAT_ROWS: readonly ThreadSummaryPanelAuxiliaryRow[] = [];
const EMPTY_BROWSER_ROWS: readonly ThreadSummaryPanelBrowserRow[] = [];
const EMPTY_MCP_SERVER_STATUSES: ProtocolListMcpServerStatusResponse = {
  data: [],
  nextCursor: null,
};

export interface ThreadSummaryPanelContentProps {
  activeThreadId: string | null;
  activeThreadTitle?: string | null;
  activeThreadIsManagedWorktree?: boolean;
  activeThreadProjectless?: boolean;
  cwd: string | null;
  projectlessOutputDirectory?: string | null;
  projectWorkspacePath: string | null;
  turns: readonly CodexConversationTurn[];
  backgroundTerminalRows?: readonly CodexBackgroundTerminalRow[];
  childMemberships?: readonly CodexConversationChildMembership[];
  knownConversationsById?: Record<string, CodexConversationSnapshot>;
  sideChatRows?: readonly ThreadSummaryPanelAuxiliaryRow[];
  browserRows?: readonly ThreadSummaryPanelBrowserRow[];
  scheduledAutomation?: ThreadSummaryPanelScheduledAutomationRow | null;
  computerUsePip?: ThreadSummaryPanelComputerUsePipState | null;
  isVisible?: boolean;
  newThreadStartInSelector?: ThreadStageRouteInput["newThreadStartInSelector"];
  actions?: Partial<ThreadStageActions>;
  onOpenThread?: ThreadStageActions["onOpenThread"];
  onErrorMessage: (message: string | null) => void;
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

const EMPTY_GIT_ACTION_STATUS: SummaryGitActionStatusState = {
  loading: false,
  cwd: null,
  status: null,
};

const EMPTY_PULL_REQUEST_STATUS: SummaryPullRequestStatusState = {
  loading: false,
  cwd: null,
  status: null,
};

function resolveSummaryOutputImagePreviewSrc(row: ThreadSummaryPanelOutputRow): string | null {
  if (!isThreadSummaryPanelImagePreviewableOutput(row)) return null;

  if (!("path" in row)) return null;
  const source = row.path.trim();
  if (!source) return null;
  return resolveImageDisplaySource(source, { allowLocalPath: true });
}

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
    return <div className="py-1 text-base text-token-description-foreground">No sources yet</div>;
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

function SummaryCountBadge({ count }: { count: number }) {
  if (count === 0) return null;

  return <span className="text-base text-token-description-foreground opacity-50">{count}</span>;
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
        <span className="max-w-48 shrink-0 truncate text-size-chat text-token-text-secondary">
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
        <span className="min-w-0 max-w-[40%] truncate text-size-chat text-token-text-tertiary">
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
      <SubagentAvatar seed={row.conversationId} className="icon-sm pointer-events-none" />
      <span className="min-w-0 truncate font-medium">{row.displayName}</span>
      {active ? (
        <CodexShimmerText
          variant="classic"
          className="shrink-0 whitespace-nowrap text-size-chat text-token-text-tertiary"
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
      className="shrink-0 text-size-chat"
    />
  );
}

function SummaryOutputIcon({ row }: { row: ThreadSummaryPanelOutputRow }) {
  if (row.kind === "generated-image" || row.kind === "image") {
    return <NfmImageBlockIcon className="size-3.5" />;
  }

  if (row.kind === "website") {
    return <ConnectorGlobeIcon className="size-3.5" aria-hidden={true} />;
  }

  if (row.kind === "google-drive") {
    return <ConnectorFallbackIcon className="size-3.5" aria-hidden={true} />;
  }

  if (row.kind === "appgen-app") {
    return <PluginCubeIcon className="size-3.5" aria-hidden={true} />;
  }

  return <FileIcon className="size-3.5" />;
}

function SummaryOutputLabel({ row }: { row: ThreadSummaryPanelOutputRow }) {
  if (row.kind !== "appgen-app") return row.label;

  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate">{row.label}</span>
      <OpenInIcon
        className="icon-xs shrink-0 opacity-0 group-focus-visible/summary-panel-row:opacity-100 group-hover/summary-panel-row:opacity-100"
        aria-hidden={true}
      />
    </span>
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
        {model.displayRows.map((row) => (
          <SubagentAvatar key={row.conversationId} seed={row.conversationId} className="size-4" />
        ))}
      </span>
      {model.workingCount > 0 ? (
        <span className="text-base whitespace-nowrap text-token-foreground">
          {model.workingCount} working
        </span>
      ) : null}
      {model.doneCount > 0 ? (
        <span className="text-base whitespace-nowrap text-token-text-tertiary">
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

function useSummaryGitActionStatus(
  cwd: string | null,
  open: boolean,
  refreshKey = 0,
): SummaryGitActionStatusState {
  const [state, setState] = useState<SummaryGitActionStatusState>(EMPTY_GIT_ACTION_STATUS);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!open || !cwd) {
      if (stateRef.current !== EMPTY_GIT_ACTION_STATUS) {
        setState(EMPTY_GIT_ACTION_STATUS);
      }
      return;
    }

    let cancelled = false;
    setState({ loading: true, cwd, status: null });
    void getGitWorkerClient()
      .request({ method: "action-status", params: { cwd } })
      .then((result) => {
        if (cancelled) return;
        setState({ loading: false, cwd, status: result as GitActionStatusResult });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ loading: false, cwd, status: null });
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, open, refreshKey]);

  return state;
}

function useSummaryPullRequestStatus(
  cwd: string | null,
  open: boolean,
  refreshKey = 0,
): SummaryPullRequestStatusState {
  const [state, setState] = useState<SummaryPullRequestStatusState>(EMPTY_PULL_REQUEST_STATUS);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!open || !cwd) {
      if (stateRef.current !== EMPTY_PULL_REQUEST_STATUS) {
        setState(EMPTY_PULL_REQUEST_STATUS);
      }
      return;
    }

    let cancelled = false;
    setState({ loading: true, cwd, status: null });
    void invoke("gh-pr-status", { cwd })
      .then((result) => {
        if (cancelled) return;
        setState({ loading: false, cwd, status: result as GhPrStatusResult });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ loading: false, cwd, status: null });
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, open, refreshKey]);

  return state;
}

function useSummaryPanelBranchState({
  cwd,
  enabled,
  onErrorMessage,
}: {
  cwd: string | null;
  enabled: boolean;
  onErrorMessage: (message: string | null) => void;
}) {
  const [branchState, setBranchState] = useState<BranchSelectorState>(EMPTY_BRANCH_SELECTOR_STATE);
  const [busy, setBusy] = useState(false);
  const branchStateRef = useRef(branchState);
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
  branchStateRef.current = branchState;
  branchCwdRef.current = cwd;

  const resetBranchState = useCallback(() => {
    if (branchStateRef.current === EMPTY_BRANCH_SELECTOR_STATE) return;
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
      setBranchState(
        result.data ? parseBranchSelectorState(result.data) : EMPTY_BRANCH_SELECTOR_STATE,
      );
    } catch {
      if (branchCwdRef.current !== requestedCwd) return;
      setBranchState(EMPTY_BRANCH_SELECTOR_STATE);
    }
  }, [enabled, refetchBranchState, resetBranchState]);

  useEffect(() => {
    if (!enabled || !cwd) {
      resetBranchState();
      return;
    }

    if (!branchStateData) {
      resetBranchState();
      return;
    }

    setBranchState(parseBranchSelectorState(branchStateData));
  }, [branchStateData, cwd, enabled, resetBranchState]);

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
      onErrorMessage(null);
      try {
        const result = await getGitWorkerClient().request({
          method: "checkout-branch",
          params: { cwd: requestedCwd, branch },
        });
        if (!isCurrentRequest()) return false;
        if (result.type === "error") throw new Error(result.errorMessage);
        setBranchState(parseBranchSelectorState(result.value));
        return true;
      } catch (error) {
        if (isCurrentRequest()) {
          onErrorMessage(error instanceof Error ? error.message : "Could not switch branches");
        }
        return false;
      } finally {
        if (isCurrentRequest()) setBusy(false);
      }
    },
    [cwd, onErrorMessage],
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
      onErrorMessage(null);
      try {
        const result = await getGitWorkerClient().request({
          method: "create-branch",
          params: { cwd: requestedCwd, branch },
        });
        if (!isCurrentRequest()) return false;
        if (result.type === "error") throw new Error(result.errorMessage);
        setBranchState(parseBranchSelectorState(result.value));
        return true;
      } catch (error) {
        if (isCurrentRequest()) {
          onErrorMessage(error instanceof Error ? error.message : "Could not create branch");
        }
        return false;
      } finally {
        if (isCurrentRequest()) setBusy(false);
      }
    },
    [cwd, onErrorMessage],
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
  activeThreadId,
  activeThreadTitle = null,
  activeThreadIsManagedWorktree = false,
  activeThreadProjectless = false,
  cwd,
  projectlessOutputDirectory = null,
  projectWorkspacePath,
  turns,
  backgroundTerminalRows = EMPTY_BACKGROUND_TERMINAL_ROWS,
  childMemberships = EMPTY_CHILD_MEMBERSHIPS,
  knownConversationsById = EMPTY_KNOWN_CONVERSATIONS_BY_ID,
  sideChatRows = EMPTY_SIDE_CHAT_ROWS,
  browserRows = EMPTY_BROWSER_ROWS,
  scheduledAutomation = null,
  computerUsePip = null,
  isVisible = true,
  newThreadStartInSelector,
  actions,
  onOpenThread,
  onErrorMessage,
}: Omit<ThreadFloatingSummaryPanelProps, "mounted" | "open">) {
  const branchCwd = useMemo(
    () => resolveBranchSelectorCwd(cwd, projectWorkspacePath),
    [cwd, projectWorkspacePath],
  );
  const [previewImage, setPreviewImage] = useState<{
    row: ThreadSummaryPanelOutputRow;
    src: string;
  } | null>(null);
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
  const previewReturnFocusRef = useRef<HTMLDivElement | null>(null);
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
  } = useSummaryPanelBranchState({ cwd: branchCwd, enabled: isVisible, onErrorMessage });
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
  const outputRows = useMemo(
    () => buildThreadSummaryPanelOutputRows(turns, { cwd, projectlessOutputDirectory }),
    [cwd, projectlessOutputDirectory, turns],
  );
  const backgroundSubagentRows = useMemo(
    () =>
      buildBackgroundSubagentRows({
        childMemberships,
        knownConversationsById,
        parentTurns: turns,
      }),
    [childMemberships, knownConversationsById, turns],
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
        suppressOutputs: hasGitEnvironmentSummary,
        sideChatCount: sideChatRows.length,
        backgroundSubagentRows,
        taskCount: backgroundTerminalRows.length,
        hasComputerUsePip,
        browserCount: browserRows.length,
        sourceCount: sourceModel.count,
      }),
    [
      activeThreadId,
      backgroundSubagentRows,
      backgroundTerminalRows.length,
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
  const runTargetLabel =
    newThreadStartInSelector?.target.runInTarget === "newWorktree" ? "New worktree" : "Local";
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
    void invoke("git:action:cancel", { operationId }).finally(() => {
      setGitActionWorkflow((current) => (current?.operationId === operationId ? null : current));
      setGitActionDialogMode(null);
    });
  }, []);
  const handlePreviewOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) return;

    setPreviewImage(null);
  }, []);
  const openSummaryOutputInSidePanel = actions?.onOpenSummaryOutputInSidePanel;
  const handleOpenOutput = useCallback(
    (row: ThreadSummaryPanelOutputRow, returnFocusTarget: HTMLDivElement) => {
      onErrorMessage(null);
      const previewSrc = resolveSummaryOutputImagePreviewSrc(row);
      if (previewSrc) {
        previewReturnFocusRef.current = returnFocusTarget;
        setPreviewImage({ row, src: previewSrc });
        return;
      }

      const target = resolveThreadSummaryPanelOutputOpenTarget(row);
      if (target.type === "url") {
        window.open(target.url, "_blank", "noopener,noreferrer");
        return;
      }

      const openDesktopFile = () =>
        invoke("shell:open-file-link", { path: target.path }, "fileManager")
          .then((opened) => {
            if (opened) return;
            onErrorMessage("Could not open output");
          })
          .catch((error: unknown) => {
            onErrorMessage(error instanceof Error ? error.message : "Could not open output");
          });

      if (!openSummaryOutputInSidePanel) {
        void openDesktopFile();
        return;
      }

      void Promise.resolve(
        openSummaryOutputInSidePanel({
          path: target.path,
          title: row.label,
        }),
      )
        .then((opened) => {
          if (opened) return;
          return openDesktopFile();
        })
        .catch(() => openDesktopFile());
    },
    [onErrorMessage, openSummaryOutputInSidePanel],
  );
  const onOpenPlanInSidePanel = actions?.onOpenPlanInSidePanel;
  const handleOpenPlan = useCallback(
    (row: ThreadSummaryPanelPlanRow) => {
      void onOpenPlanInSidePanel?.(row.target);
    },
    [onOpenPlanInSidePanel],
  );
  const onOpenBackgroundTerminalOutput = actions?.onOpenBackgroundTerminalOutput;
  const handleOpenBackgroundTerminalOutput = useCallback(
    (row: CodexBackgroundTerminalRow) => {
      void onOpenBackgroundTerminalOutput?.(row);
    },
    [onOpenBackgroundTerminalOutput],
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
  const processManagerAction = actions?.onOpenProcessManager ? (
    <NodexTooltip tooltipContent="View all processes" side="top">
      <button
        type="button"
        aria-label="View all processes"
        className="ms-auto inline-flex size-6 cursor-interaction items-center justify-center rounded-sm border-0 bg-transparent text-token-text-tertiary hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={() => {
          void actions.onOpenProcessManager?.();
        }}
      >
        <ListTree className="icon-xs" aria-hidden="true" />
      </button>
    </NodexTooltip>
  ) : null;

  return (
    <>
      <div
        data-testid="thread-summary-panel"
        className="relative flex max-h-full min-h-0 flex-col overflow-hidden rounded-3xl bg-token-dropdown-background pt-3 electron:elevation-prominent extension:border extension:border-token-border-default extension:shadow-md"
      >
        <div className="flex h-fit max-h-full min-h-0 flex-col gap-3 overflow-y-auto pb-3">
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
                            className="text-size-chat"
                          />
                        ) : null
                      }
                      trailingVisible
                    />
                    {newThreadStartInSelector && actions ? (
                      <NewChatStartInSelector
                        model={newThreadStartInSelector}
                        actions={actions}
                        disabled={!isVisible}
                        worktreeAvailable={worktreeAvailable}
                        side="left"
                        align="start"
                        sideOffset={4}
                        menuTitle="Continue in"
                        tooltipContent="Select where to run the task"
                        renderTrigger={({ iconKey, title, disabled }) => (
                          <ThreadSummaryPanelRow
                            label={<SummaryDropdownRowLabel label={runTargetLabel} />}
                            labelClassName="flex min-w-0 items-center"
                            title={title}
                            icon={
                              <span className="shrink-0">
                                <StartInIcon
                                  iconKey={iconKey}
                                  className="icon-sm text-token-foreground"
                                />
                              </span>
                            }
                            disabled={disabled}
                            interactive
                          />
                        )}
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
                        onCreate={createBranch}
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
                    titleSuffix={<SummaryCountBadge count={section.count ?? outputRows.length} />}
                  >
                    {outputRows.map((row) => (
                      <ThreadSummaryPanelRow
                        key={row.id}
                        label={<SummaryOutputLabel row={row} />}
                        labelClassName={row.kind === "appgen-app" ? "min-w-0" : undefined}
                        title={row.title}
                        icon={<SummaryOutputIcon row={row} />}
                        interactive
                        onClick={(event) => handleOpenOutput(row, event.currentTarget)}
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
                    titleSuffix={<SummaryCountBadge count={section.count ?? sideChatRows.length} />}
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
                      section.count === null ? null : <SummaryCountBadge count={section.count} />
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
                        interactive={Boolean(onOpenThread)}
                        onClick={
                          onOpenThread
                            ? () => {
                                void onOpenThread(
                                  row.conversationId,
                                  buildBackgroundAgentOpenContext(row),
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
                return (
                  <ThreadSummaryPanelSection
                    key={section.kind}
                    sectionKey="background-tasks"
                    title="Tasks"
                    titleSuffix={
                      <SummaryCountBadge count={section.count ?? backgroundTerminalRows.length} />
                    }
                    after={processManagerAction}
                  >
                    {backgroundTerminalRows.slice(0, 4).map((row) => (
                      <ThreadSummaryPanelRow
                        key={row.id}
                        label={row.command}
                        title={row.command}
                        icon={<TerminalIcon className="icon-sm shrink-0" />}
                        interactive={Boolean(onOpenBackgroundTerminalOutput)}
                        onClick={
                          onOpenBackgroundTerminalOutput
                            ? () => handleOpenBackgroundTerminalOutput(row)
                            : undefined
                        }
                        trailing={
                          row.previewLine ? (
                            <span className="block max-w-24 truncate text-size-chat text-token-text-tertiary">
                              {row.previewLine}
                            </span>
                          ) : null
                        }
                        trailingVisible={Boolean(row.previewLine)}
                      />
                    ))}
                  </ThreadSummaryPanelSection>
                );

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
                      trailing={<SummaryComputerUsePipTrailing visible={computerUsePip.visible} />}
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
                    titleSuffix={<SummaryCountBadge count={section.count ?? browserRows.length} />}
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
                    titleSuffix={<SummaryCountBadge count={section.count ?? sourceModel.count} />}
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
                  <div key={section.kind} className="px-4 text-size-chat text-token-text-tertiary">
                    Start a thread to populate live summary rows.
                  </div>
                );
            }
          })}
        </div>
      </div>
      {previewImage ? (
        <ImagePreviewDialog
          open
          onOpenChange={handlePreviewOpenChange}
          src={previewImage.src}
          alt={previewImage.row.label}
          allowLocalPath
          finalFocus={() => {
            previewReturnFocusRef.current?.focus();
            previewReturnFocusRef.current = null;
            return false;
          }}
        />
      ) : null}
      <ThreadSummaryGitActionDialog
        open={gitActionDialogMode !== null}
        cwd={branchCwd}
        initialMode={gitActionDialogMode ?? "commit"}
        onOpenChange={handleGitActionDialogOpenChange}
        onCompleted={handleGitActionCompleted}
        onErrorMessage={onErrorMessage}
        onWorkflowChange={setGitActionWorkflow}
      />
      <ThreadSummaryCreatePullRequestDialog
        open={createPullRequestDialogOpen}
        cwd={branchCwd}
        onOpenChange={handleCreatePullRequestDialogOpenChange}
        onCompleted={handleCreatePullRequestCompleted}
        onErrorMessage={onErrorMessage}
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
        onErrorMessage={onErrorMessage}
        onOpenChange={handleBranchSetupOpenChange}
      />
    </>
  );
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
    <NodexPopover open={open} onOpenChange={handleOpenChange}>
      <NodexTooltip tooltipContent="Toggle summary" side="bottom">
        <NodexPopoverTrigger>
          <ThreadSummaryPanelToggleButton label="Toggle summary" pressed={open} />
        </NodexPopoverTrigger>
      </NodexTooltip>
      <NodexPopoverContent
        align="end"
        side="bottom"
        sideOffset={8}
        className="!w-auto !overflow-visible !rounded-3xl !bg-transparent !p-0 !shadow-none !ring-0 !backdrop-blur-none"
        style={{
          maxHeight: "none",
          maxWidth: "none",
        }}
      >
        <div
          data-thread-summary-panel-mode="popover"
          className="flex max-h-[min(var(--nodex-floating-surface-available-height),calc(100vh-16px))] flex-col"
          style={{ width: CODEX_SUMMARY_PANEL_WIDTH }}
        >
          <ThreadSummaryPanelSurface {...props} isVisible />
        </div>
      </NodexPopoverContent>
    </NodexPopover>
  );
}

export function ThreadFloatingSummaryPanel({
  hideImmediately = false,
  mounted,
  open,
  ...props
}: ThreadFloatingSummaryPanelProps) {
  const reducedMotion = useResolvedReducedMotion();
  if (!mounted) return null;

  return (
    <div
      className="pointer-events-none absolute top-(--thread-floating-content-top-inset) right-0 bottom-(--thread-floating-content-bottom-inset) z-40"
      data-thread-summary-panel-hide-immediately={String(hideImmediately)}
      data-thread-summary-panel-mode="pinned"
      data-thread-summary-panel-open={String(open)}
    >
      <div className="relative flex max-h-full">
        <motion.div
          className={cn(
            "pointer-events-none max-h-full min-h-0 origin-top-right pe-4",
            hideImmediately && "invisible",
          )}
          initial={false}
          animate={{
            opacity: open ? 1 : 0,
            translateX: open ? 0 : "100%",
            scale: open ? 1 : 0.8,
          }}
          transition={
            hideImmediately || reducedMotion ? { duration: 0 } : CODEX_SUMMARY_PANEL_TRANSITION
          }
        >
          <div
            className={cn(
              "flex max-h-full flex-col",
              open ? "pointer-events-auto" : "pointer-events-none",
            )}
            style={{ width: CODEX_SUMMARY_PANEL_WIDTH }}
          >
            <ThreadSummaryPanelSurface {...props} isVisible={open} />
          </div>
        </motion.div>
      </div>
    </div>
  );
}
