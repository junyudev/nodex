import { FormattedMessage, useIntl } from "@/lib/i18n";
import { useEffect, useRef } from "react";
import { CopyIcon, MoreActionsIcon, RefreshIcon, SendToChatIcon } from "@/components/shared/icons";
import { WebsiteGitHubIcon } from "@/components/shared/icons/website-icons";
import {
  PageStageFrame,
  PageStageContentLayout,
  PageStageBodyPlaceholder,
  PageTitlePlaceholder,
} from "@/components/board/page-stage/frame";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  ViewerButton,
  ViewerCapsule,
  ViewerControlGroup,
  ViewerHeader,
  ViewerIconButton,
} from "@/components/ui/viewer-header";
import { writeTextToClipboard } from "@/lib/clipboard";
import { getIntl } from "@/lib/i18n";
import { useGitHubSettingsNavigation } from "@/lib/github-settings-navigation";
import { readPageStageContentWidthPreference } from "@/lib/page-stage-layout";
import { toastFailure } from "@/lib/failure-toast";
import { cn } from "@/lib/utils";
import type { CodexPromptInput } from "@/lib/types";
import type {
  GitHubThreadDetail,
  GitHubThreadKind,
  GitHubThreadRef,
  GitHubThreadReveal,
  GitHubThreadView,
  GitHubUnavailable,
} from "../../../shared/github-thread";
import { gitHubThreadLabel, gitHubThreadUrl } from "../../../shared/github-thread";
import { gitHubUnavailableDescription, gitHubUnavailableTitle } from "./github-thread-copy";
import { GitHubPullRequestFilesView } from "./github-thread-files";
import { gitHubChatContext, type GitHubChatContextSubject } from "./github-thread-model";
import { GitHubThreadOverview } from "./github-thread-overview";
import { useOpenOnGitHub } from "./github-thread-parts";
import {
  GitHubThreadStateIcon,
  gitHubThreadStateOf,
  unknownGitHubThreadState,
} from "./github-thread-state";
import type { GitHubThreadCommandRunner } from "./github-thread-surface-types";
import {
  gitHubChatContextPromptInput,
  useGitHubThread,
  useGitHubThreadCommand,
  useGitHubThreadLinks,
} from "./use-github-thread";

export interface GitHubThreadSurfaceProps {
  readonly thread: GitHubThreadRef;
  /** What the link said the thread is; GitHub's answer replaces it. */
  readonly kindHint: GitHubThreadKind;
  /** The last title the tab showed, held while the thread loads. */
  readonly titleSnapshot?: string | null;
  /** The part of the thread the tab shows, kept with the tab. */
  readonly view: GitHubThreadView;
  readonly onViewChange: (view: GitHubThreadView) => void;
  /** A one-shot request from the link that opened or refocused the tab. */
  readonly reveal: GitHubThreadReveal | null;
  readonly onRevealConsumed: () => void;
  /** Keeps the tab's title current for tab strips and restore. */
  readonly onTitleSnapshotChange?: (title: string) => void;
  /** Present when the tab sits beside a chat whose draft can take GitHub context. */
  readonly onAddToChatComposer?: (input: CodexPromptInput) => void;
}

const REVEAL_HIGHLIGHT_MS = 1600;

/** The body of a GitHub tab: one issue or pull request, read natively. */
export function GitHubThreadSurface(props: GitHubThreadSurfaceProps) {
  const { thread, kindHint } = props;
  const query = useGitHubThread(thread);
  const links = useGitHubThreadLinks(thread);
  const mutation = useGitHubThreadCommand(thread);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const result = query.data;
  const detail = result?.status === "ready" ? result.detail : null;
  const kind = detail?.kind ?? kindHint;
  const view: GitHubThreadView = kind === "pull_request" ? props.view : "overview";

  const { onTitleSnapshotChange } = props;
  const title = detail?.title ?? null;
  useEffect(() => {
    if (title) onTitleSnapshotChange?.(title);
  }, [onTitleSnapshotChange, title]);

  // A reveal stays pending with the tab until it is done: switch to the view it names, wait for
  // the thread, scroll to its anchor, and only then let it go.
  const { reveal, onRevealConsumed, onViewChange } = props;
  const ready = detail !== null;
  const highlight = useRef<{ target: HTMLElement; timeout: number } | null>(null);
  useEffect(() => {
    if (!reveal) return;
    if (kind === "pull_request" && reveal.view !== props.view) {
      onViewChange(reveal.view);
      return;
    }
    const anchor = reveal.anchor;
    if (!anchor) {
      onRevealConsumed();
      return;
    }
    if (!ready) return;
    const frame = window.requestAnimationFrame(() => {
      onRevealConsumed();
      const target = scrollRef.current?.querySelector<HTMLElement>(
        `[data-github-anchor="${CSS.escape(anchor)}"]`,
      );
      if (!target) return;
      target.scrollIntoView({ block: "start" });
      if (highlight.current) {
        window.clearTimeout(highlight.current.timeout);
        delete highlight.current.target.dataset.revealed;
      }
      target.dataset.revealed = "true";
      highlight.current = {
        target,
        timeout: window.setTimeout(() => {
          delete target.dataset.revealed;
          highlight.current = null;
        }, REVEAL_HIGHLIGHT_MS),
      };
    });
    return () => window.cancelAnimationFrame(frame);
  }, [kind, onRevealConsumed, onViewChange, props.view, ready, reveal]);
  useEffect(
    () => () => {
      if (highlight.current) window.clearTimeout(highlight.current.timeout);
    },
    [],
  );

  const run: GitHubThreadCommandRunner & { readonly post: (body: string) => Promise<boolean> } = {
    pending: mutation.isPending,
    command: (command) => mutation.mutate(command),
    post: (body) =>
      mutation
        .mutateAsync({ type: "comment", body })
        .then((outcome) => outcome.status === "applied")
        .catch(() => false),
  };

  const { onAddToChatComposer } = props;
  const addToChat =
    detail && onAddToChatComposer
      ? (subject: GitHubChatContextSubject) =>
          void gitHubChatContextPromptInput(gitHubChatContext(detail, subject)).then(
            (input) => {
              onAddToChatComposer(input);
              toast.success(
                getIntl().formatMessage({
                  id: "githubThread.addedToChat",
                  defaultMessage: "Added to the chat’s draft",
                }),
              );
            },
            (error: unknown) =>
              toastFailure(
                getIntl().formatMessage({
                  id: "githubThread.addToChatFailed",
                  defaultMessage: "Couldn’t add it to the chat",
                }),
                error,
              ),
          )
      : null;

  const url = detail?.url ?? gitHubThreadUrl(thread, kindHint);
  const toolbar = (
    <GitHubThreadToolbar
      thread={detail?.ref ?? thread}
      kind={kind}
      detail={detail}
      url={url}
      view={view}
      onViewChange={props.onViewChange}
      refreshing={query.isFetching}
      onRefresh={() => void query.refetch()}
      run={run}
      onAddToChat={addToChat}
      unavailable={result !== undefined && result.status !== "ready"}
    />
  );

  const limitWidth = view === "overview" && readPageStageContentWidthPreference();
  return (
    <PageStageFrame
      toolbar={toolbar}
      limitMainContentWidth={limitWidth}
      scrollContainerRef={scrollRef}
      data-github-thread-surface=""
      aria-busy={!result}
    >
      {!result ? (
        <PageStageContentLayout
          title={<PageTitlePlaceholder title={props.titleSnapshot ?? null} />}
          body={<PageStageBodyPlaceholder seed={gitHubThreadLabel(thread)} />}
        />
      ) : result.status !== "ready" ? (
        <GitHubThreadUnavailable
          unavailable={result}
          kind={kindHint}
          url={url}
          onRetry={() => void query.refetch()}
        />
      ) : view === "files" && result.detail.kind === "pull_request" ? (
        <GitHubPullRequestFilesView pr={result.detail} />
      ) : (
        <GitHubThreadOverview
          detail={result.detail}
          links={links.data ?? null}
          run={run}
          onShowFiles={() => props.onViewChange("files")}
          onAddToChat={addToChat}
          revealChecks={reveal?.anchor === "checks"}
        />
      )}
    </PageStageFrame>
  );
}

async function copyToClipboard(text: string, copied: string, failed: string) {
  if (await writeTextToClipboard(text)) toast.success(copied);
  else toast.danger(failed);
}

function GitHubThreadToolbar({
  thread,
  kind,
  detail,
  url,
  view,
  onViewChange,
  refreshing,
  onRefresh,
  run,
  onAddToChat,
  unavailable,
}: {
  readonly thread: GitHubThreadRef;
  readonly kind: GitHubThreadKind;
  readonly detail: GitHubThreadDetail | null;
  readonly url: string;
  readonly view: GitHubThreadView;
  readonly onViewChange: (view: GitHubThreadView) => void;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly run: GitHubThreadCommandRunner;
  readonly onAddToChat: ((subject: GitHubChatContextSubject) => void) | null;
  /** A thread that cannot be read has nothing to switch between. */
  readonly unavailable: boolean;
}) {
  const intl = useIntl();
  const openOnGitHub = useOpenOnGitHub();
  const state = detail ? gitHubThreadStateOf(detail) : unknownGitHubThreadState(kind);
  const openLabel = intl.formatMessage({
    id: "githubThread.openOnGitHub",
    defaultMessage: "Open on GitHub",
  });
  const pr = detail?.kind === "pull_request" ? detail : null;
  return (
    <ViewerHeader
      className="w-full"
      density="compact"
      placement="overlay"
      label={intl.formatMessage({ id: "githubThread.toolbar.label", defaultMessage: "GitHub" })}
      leading={[
        {
          id: "thread",
          allowShrink: true,
          content: (
            <ViewerCapsule className="flex min-w-0 items-center gap-1.5 px-3 text-sm">
              <GitHubThreadStateIcon state={state} />
              <span className="min-w-0 truncate text-token-description-foreground">
                {thread.owner}/{thread.repo}
              </span>
              <span className="shrink-0 font-medium tabular-nums text-token-text-primary">
                #{thread.number}
              </span>
            </ViewerCapsule>
          ),
        },
        {
          id: "view",
          content:
            kind === "pull_request" && !unavailable ? (
              <ViewerControlGroup
                label={intl.formatMessage({
                  id: "githubThread.view.label",
                  defaultMessage: "Show",
                })}
              >
                {(["overview", "files"] as const).map((value) => (
                  <ViewerButton
                    key={value}
                    variant={view === value ? "selected" : "default"}
                    aria-pressed={view === value}
                    onClick={() => onViewChange(value)}
                  >
                    {value === "overview"
                      ? intl.formatMessage({
                          id: "githubThread.view.overview",
                          defaultMessage: "Overview",
                        })
                      : pr
                        ? intl.formatMessage(
                            { id: "githubThread.view.filesCount", defaultMessage: "Files {count}" },
                            { count: pr.changedFiles },
                          )
                        : intl.formatMessage({
                            id: "githubThread.view.files",
                            defaultMessage: "Files",
                          })}
                  </ViewerButton>
                ))}
              </ViewerControlGroup>
            ) : null,
        },
      ]}
      trailing={[
        {
          id: "refresh",
          collapsePriority: 1,
          content: (
            <ViewerIconButton
              label={intl.formatMessage({ id: "githubThread.refresh", defaultMessage: "Refresh" })}
              onClick={onRefresh}
              disabled={refreshing}
            >
              <RefreshIcon className={cn("icon-xs", refreshing && "animate-spin")} />
            </ViewerIconButton>
          ),
        },
        {
          id: "open",
          collapsePriority: 0,
          content: (
            <NodexTooltip tooltipContent={openLabel} delayOpen>
              <ViewerButton aria-label={openLabel} onClick={(event) => openOnGitHub(url, event)}>
                <WebsiteGitHubIcon className="icon-xs" />
                <span
                  className="overflow-hidden whitespace-nowrap"
                  data-viewer-header-collapsible=""
                >
                  {openLabel}
                </span>
              </ViewerButton>
            </NodexTooltip>
          ),
        },
        {
          id: "more",
          content: (
            <NodexDropdownMenu
              align="end"
              triggerButton={
                <ViewerButton
                  uniform
                  aria-label={intl.formatMessage({
                    id: "githubThread.more",
                    defaultMessage: "More",
                  })}
                >
                  <MoreActionsIcon className="icon-xs" />
                </ViewerButton>
              }
            >
              {onAddToChat && detail ? (
                <NodexDropdownItem
                  leftSlot={<SendToChatIcon className="icon-xs" />}
                  onSelect={() => onAddToChat({ kind: "thread" })}
                >
                  <FormattedMessage
                    id="githubThread.activity.addToChat"
                    defaultMessage="Add to chat"
                  />
                </NodexDropdownItem>
              ) : null}
              <NodexDropdownItem
                leftSlot={<CopyIcon className="icon-xs" />}
                onSelect={() =>
                  void copyToClipboard(
                    url,
                    getIntl().formatMessage({
                      id: "githubThread.copiedLink",
                      defaultMessage: "Copied link",
                    }),
                    getIntl().formatMessage({
                      id: "githubThread.copyLinkFailed",
                      defaultMessage: "Couldn’t copy the link",
                    }),
                  )
                }
              >
                <FormattedMessage id="githubThread.copyLink" defaultMessage="Copy link" />
              </NodexDropdownItem>
              {pr ? (
                <NodexDropdownItem
                  leftSlot={<CopyIcon className="icon-xs" />}
                  onSelect={() =>
                    void copyToClipboard(
                      pr.headBranch,
                      getIntl().formatMessage({
                        id: "githubThread.copiedBranch",
                        defaultMessage: "Copied branch name",
                      }),
                      getIntl().formatMessage({
                        id: "githubThread.copyBranchFailed",
                        defaultMessage: "Couldn’t copy the branch name",
                      }),
                    )
                  }
                >
                  <FormattedMessage
                    id="githubThread.copyBranch"
                    defaultMessage="Copy branch name"
                  />
                </NodexDropdownItem>
              ) : null}
              {detail ? <ThreadStateItems detail={detail} run={run} /> : null}
            </NodexDropdownMenu>
          ),
        },
      ]}
    />
  );
}

/** Lifecycle changes that can be undone, so they apply at once. */
function ThreadStateItems({
  detail,
  run,
}: {
  readonly detail: GitHubThreadDetail;
  readonly run: GitHubThreadCommandRunner;
}) {
  const items = [];
  if (detail.kind === "pull_request" && detail.state === "open" && detail.viewer.canChangeDraft) {
    items.push(
      <NodexDropdownItem
        key="draft"
        disabled={run.pending}
        onSelect={() => run.command({ type: "set_draft", draft: !detail.draft })}
      >
        {detail.draft ? (
          <FormattedMessage
            id="githubThread.actions.readyForReview"
            defaultMessage="Ready for review"
          />
        ) : (
          <FormattedMessage
            id="githubThread.actions.convertToDraft"
            defaultMessage="Convert to draft"
          />
        )}
      </NodexDropdownItem>,
    );
  }
  if (detail.viewer.canChangeState && detail.state !== "merged") {
    const closing = detail.state === "open";
    items.push(
      <NodexDropdownItem
        key="state"
        disabled={run.pending}
        onSelect={() => run.command({ type: "set_state", state: closing ? "closed" : "open" })}
      >
        {closing ? (
          <FormattedMessage
            id="githubThread.actions.close"
            defaultMessage="{kind, select, pull_request {Close pull request} other {Close issue}}"
            values={{ kind: detail.kind }}
          />
        ) : (
          <FormattedMessage
            id="githubThread.actions.reopen"
            defaultMessage="{kind, select, pull_request {Reopen pull request} other {Reopen issue}}"
            values={{ kind: detail.kind }}
          />
        )}
      </NodexDropdownItem>,
    );
    if (closing && detail.kind === "issue") {
      items.push(
        <NodexDropdownItem
          key="not-planned"
          disabled={run.pending}
          onSelect={() =>
            run.command({ type: "set_state", state: "closed", reason: "not_planned" })
          }
        >
          <FormattedMessage
            id="githubThread.actions.closeNotPlanned"
            defaultMessage="Close as not planned"
          />
        </NodexDropdownItem>,
      );
    }
  }
  if (items.length === 0) return null;
  return (
    <>
      <NodexDropdownSeparator />
      {items}
    </>
  );
}

/** A thread that cannot be read here says why, offers the fix, and always offers GitHub itself. */
function GitHubThreadUnavailable({
  unavailable,
  kind,
  url,
  onRetry,
}: {
  readonly unavailable: GitHubUnavailable;
  readonly kind: GitHubThreadKind;
  readonly url: string;
  readonly onRetry: () => void;
}) {
  const intl = useIntl();
  const onOpenGitHubSettings = useGitHubSettingsNavigation();
  const openOnGitHub = useOpenOnGitHub();
  const { reason } = unavailable;
  const retryAt = unavailable.retryAt ? Date.parse(unavailable.retryAt) : Number.NaN;
  const description =
    gitHubUnavailableDescription(intl, reason, kind) ??
    (reason === "rate_limited" && Number.isFinite(retryAt)
      ? intl.formatMessage(
          { id: "githubThread.unavailable.retryAt", defaultMessage: "Try again after {time}." },
          { time: intl.formatTime(retryAt, { timeStyle: "short" }) },
        )
      : unavailable.message);
  const settingsFix =
    (reason === "not_connected" || reason === "reconnect") && onOpenGitHubSettings;
  return (
    <div
      className="flex min-h-[60vh] items-center justify-center"
      data-github-thread-unavailable={reason}
    >
      <EmptyState
        icon={
          <GitHubThreadStateIcon state={unknownGitHubThreadState(kind)} className="icon-base" />
        }
        title={gitHubUnavailableTitle(intl, reason)}
        description={description}
        actions={
          <div className="flex items-center gap-2">
            {settingsFix ? (
              <NodexButton size="toolbar" variant="primary" onClick={onOpenGitHubSettings}>
                {reason === "reconnect" ? (
                  <FormattedMessage
                    id="githubThread.unavailable.reconnectAction"
                    defaultMessage="Reconnect"
                  />
                ) : (
                  <FormattedMessage
                    id="githubThread.unavailable.connectAction"
                    defaultMessage="Connect GitHub"
                  />
                )}
              </NodexButton>
            ) : reason === "failed" || reason === "rate_limited" ? (
              <NodexButton size="toolbar" variant="secondary" onClick={onRetry}>
                <FormattedMessage id="githubThread.retry" defaultMessage="Try again" />
              </NodexButton>
            ) : null}
            <NodexButton
              size="toolbar"
              variant="ghost"
              onClick={(event) => openOnGitHub(url, event)}
            >
              <WebsiteGitHubIcon className="icon-xs" />
              <FormattedMessage id="githubThread.openOnGitHub" defaultMessage="Open on GitHub" />
            </NodexButton>
          </div>
        }
      />
    </div>
  );
}
