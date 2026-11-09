import { isRemoteSpace } from "@/lib/renderer-space";
import { useSpaceHostAvailable } from "@/lib/space-host-runtime";
import { InboxActivity, InboxActivityFilters } from "./inbox-activity";
import { InboxProblemRow } from "./inbox-problem-row";
import { SpaceExecutionHoldControl } from "@/components/workbench/execution-hold-controls";
import { useInboxClock } from "./use-inbox-clock";
import { consumeInboxEntryOpen, useInboxEntryOpen } from "../../lib/inbox-entry-navigation";
import { openNodex } from "../../lib/inbox-runtime";
import { InboxTurnRow } from "./inbox-turn-row";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { acceptPageWork } from "@/lib/page-turn-runtime";
import { openExternalUrl } from "@/lib/file-system-operations";
import { startWork } from "../../lib/work-graph-runtime";
import { readableIpcError } from "@/lib/ipc-error-message";
import { toast } from "@/components/ui/toast";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  inboxNewChatAction,
  inboxScopeKey,
  inboxScopeProjectId,
  type InboxItem,
  type InboxScope,
  type ActivityFilter,
  type InboxSendInput,
} from "../../../shared/inbox";
import {
  inboxSuggestionPolicy,
  inboxSuggestionsOffered,
} from "../../../shared/inbox-suggestion-policy";
import type { Project } from "../../../shared/types";
import { messageTextOf } from "../../../shared/message-content";
import { extractMarkdownText } from "../../../shared/nodex-markdown";
import {
  ArchiveIcon,
  BoardIcon,
  NodexLogoMarkIcon,
  CheckmarkIcon,
  CloseIcon,
  DeleteIcon,
  DispatchIcon,
  ListLayoutIcon,
  InboxIcon,
  RefreshIcon,
} from "@/components/shared/icons";
import { useApplicationPending } from "@/bootstrap/application-surface";
import { NodexButton } from "@/components/ui/button";
import {
  SURFACE_TOOLBAR_ROW_CLASS,
  surfaceViewPillClassName,
} from "@/components/workbench/surface-toolbar";
import { ToolbarIconButton } from "@/components/workbench/workbench-panel-controls";
import type { ShowPagesInChatInput } from "@/lib/page-chat-actions";
import { usePageChatActivitySummaries } from "@/lib/use-page-chat-activity-summaries";
import { cn } from "@/lib/utils";
import { ThreadTimestampSeparator } from "@/features/local-conversation/view/shared/thread-timestamp-separator";
import { InboxComposer } from "./inbox-composer";
import {
  InboxDispatchEditor,
  draftFromAction,
  type InboxDispatchDraft,
} from "./inbox-dispatch-editor";
import { InboxDeleteDialog, type InboxDeleteRequest } from "./inbox-delete-dialog";
import { InboxIconAction } from "./inbox-icon-action";
import { InboxImportantBar } from "./inbox-important";
import { InboxMessage, InboxMessageMenu } from "./inbox-message";
import { INBOX_EASE_OUT, InboxStreamItem } from "./inbox-stream-item";
import {
  inboxChatPageIds,
  inboxBuriedImportant,
  inboxTimestampSeparators,
  type InboxOutcomeTarget,
  type InboxRowOffers,
} from "./inbox-presentation";
import { useInboxAgents, type InboxAgents } from "./inbox-agent-picker";
import { InboxAgentsPopover } from "./inbox-agents-popover";
import { InboxPlanningSummary } from "./inbox-planning-summary";
import { InboxSuggestionPauseNotice } from "./inbox-suggestion-pause-notice";
import { InboxTriage } from "./inbox-triage";
import { InboxCaptureRecovery } from "./inbox-capture-recovery";
import { useInboxCapture } from "./use-inbox-capture";
import { useInboxImageAccess } from "./use-inbox-image-access";
import { useInboxJump, useInboxMessagesInView } from "./use-inbox-important";
import { useInboxActions } from "./use-inbox-actions";
import { useAutomationsQuery } from "@/lib/use-automations-query";
import { useInboxDepartures } from "./use-inbox-departures";
import { useInboxActivity, useInboxStream, useInboxSummary } from "./use-inbox";
import { INBOX_STICK_TO_BOTTOM_PX, type InboxView } from "./inbox-viewport";
import { initialInboxPlace, initiallyFollowsInbox, useInboxViewport } from "./use-inbox-viewport";

/** The Inbox holds what still needs the reader; Activity holds what was handled or done. */
const INBOX_VIEWS = {
  inbox: { label: "Inbox", icon: InboxIcon },
  activity: { label: "Activity", icon: ListLayoutIcon },
} as const satisfies Record<InboxView, { label: string; icon: unknown }>;

export interface InboxRouteProps {
  /**
   * Which Inbox to show. Each is the Home tab of its Scene: the Library Inbox of its own Scene,
   * a Project's Inbox of that Project's.
   */
  readonly scope: InboxScope;
  readonly windowSessionId: string;
  readonly projects: readonly Project[];
  readonly focusComposerToken?: number;
  readonly onOpenSession: (sessionId: string) => void;
  /** Opens an automation in Automations, from a run of it waiting here. */
  readonly onOpenAutomation?: (automationId: string) => void;
  readonly onOpenPage: (pageId: string) => void;
  /** Shows a new chat's message Pages beside it, without leaving the Inbox. */
  readonly onShowPagesInChat: (input: ShowPagesInChatInput) => Promise<void>;
  readonly onOpenDatabase: (databaseId: string) => void;
  readonly onOpenSettings: () => void;
  readonly onOpenGitHubSettings: () => void;
  /** Whether this Inbox is the visible surface; only then does its first load hold startup. */
  readonly visible?: boolean;
}

function InboxHeader({
  view,
  inboxCount,
  databaseId,
  databaseLabel,
  agents,
  onViewChange,
  onOpenDatabase,
  onOpenSettings,
  onOpenNodex,
}: {
  readonly view: InboxView;
  readonly inboxCount: number;
  readonly databaseId: string | null;
  /** What the Database button opens: the Inbox's own Database or the Project's Board. */
  readonly databaseLabel: string;
  readonly agents: InboxAgents;
  readonly onViewChange: (view: InboxView) => void;
  readonly onOpenDatabase: (databaseId: string) => void;
  readonly onOpenSettings: () => void;
  /** Opens Nodex's own conversation, where the reader can talk to it directly. */
  readonly onOpenNodex: () => void;
}) {
  const hostAvailable = useSpaceHostAvailable();
  return (
    // An Inbox is its Scene's Home tab, so it tops the tab like a Board's views do.
    <header className={cn(SURFACE_TOOLBAR_ROW_CLASS, "shrink-0")}>
      <div role="tablist" aria-label="Inbox view" className="-ml-1 flex min-w-0 items-center">
        {(["inbox", "activity"] as const).map((option) => {
          const ViewIcon = INBOX_VIEWS[option].icon;
          return (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={view === option}
              onClick={() => onViewChange(option)}
              className={cn(surfaceViewPillClassName({ active: view === option }), "mx-0.5")}
            >
              <ViewIcon className="size-4 shrink-0 text-current" />
              <span className="ml-1.5">{INBOX_VIEWS[option].label}</span>
              {option === "inbox" && inboxCount > 0 ? (
                <span className="ml-1.5 font-normal text-token-text-tertiary tabular-nums">
                  {inboxCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="ml-auto flex items-center gap-0.5">
        <SpaceExecutionHoldControl />
        <ToolbarIconButton label="Open Nodex" onClick={onOpenNodex} disabled={!hostAvailable}>
          <NodexLogoMarkIcon monochrome className="icon-sm" />
        </ToolbarIconButton>
        {databaseId ? (
          <ToolbarIconButton label={databaseLabel} onClick={() => onOpenDatabase(databaseId)}>
            <BoardIcon className="icon-sm" />
          </ToolbarIconButton>
        ) : null}
        {!isRemoteSpace() ? (
          <InboxAgentsPopover agents={agents} onOpenSettings={onOpenSettings} />
        ) : null}
      </div>
    </header>
  );
}

function EmptyState({
  everUsed,
  projectName,
  planning,
}: {
  readonly everUsed: boolean;
  /** Set for a Project's Inbox. */
  readonly projectName: string | null;
  /** How the Inbox plans the next messages, beneath an empty Inbox. */
  readonly planning: ReactNode;
}) {
  if (!everUsed) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-base font-medium text-token-foreground">
            {projectName ? `Nothing in ${projectName} yet` : "Nothing in your Inbox yet"}
          </p>
          <p className="max-w-sm text-sm text-balance text-token-description-foreground">
            {projectName
              ? "Drop thoughts, todos, and questions about this Project. Each becomes a Page on its Board, and Nodex suggests what to do with it."
              : "Drop a thought, a todo, or a question. Review a suggestion or decide where it goes."}
          </p>
        </div>
        {planning}
      </div>
    );
  }
  return (
    <motion.div
      data-testid="inbox-zero"
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35, ease: INBOX_EASE_OUT }}
      className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-6"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <motion.span
          initial={{ scale: 0.6, rotate: -12 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 22, delay: 0.08 }}
          className="flex size-10 items-center justify-center rounded-full bg-token-foreground/[0.05] text-token-foreground"
        >
          <CheckmarkIcon className="icon-sm" />
        </motion.span>
        <div className="flex flex-col gap-1">
          <p className="text-base font-medium text-token-foreground">All clear</p>
          <p className="text-sm text-token-description-foreground">
            Everything you dropped here has somewhere to be.
          </p>
        </div>
      </div>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25, duration: 0.4, ease: INBOX_EASE_OUT }}
        className="flex w-full justify-center"
      >
        {planning}
      </motion.div>
    </motion.div>
  );
}

/** Groups share one suggestion; it renders on the newest message in the group. */
function groupAnchors(items: readonly InboxItem[]): ReadonlyMap<string, string> {
  const anchorByProposal = new Map<string, string>();
  for (const item of items) {
    const proposal = item.proposal;
    if (proposal && proposal.pageIds.length > 1)
      anchorByProposal.set(proposal.proposalId, item.pageId);
  }
  return anchorByProposal;
}

type StreamEntry =
  | { readonly kind: "time"; readonly key: string; readonly sentAtMs: number }
  | { readonly kind: "message"; readonly key: string; readonly item: InboxItem };

/** One flat keyed list, so a time separator leaves with the message it introduces. */
function streamEntries(items: readonly InboxItem[], nowMs: number): readonly StreamEntry[] {
  const separators = inboxTimestampSeparators(items, nowMs);
  return items.flatMap((item, index): StreamEntry[] => {
    const sentAtMs = separators[index];
    const message: StreamEntry = { kind: "message", key: item.pageId, item };
    return sentAtMs == null
      ? [message]
      : [{ kind: "time", key: `time:${item.pageId}`, sentAtMs }, message];
  });
}

export function InboxRoute({
  scope,
  windowSessionId,
  projects,
  focusComposerToken,
  onOpenSession,
  onOpenAutomation,
  onOpenPage,
  onShowPagesInChat,
  onOpenDatabase,
  onOpenSettings,
  onOpenGitHubSettings,
  visible = true,
}: InboxRouteProps) {
  // Keeps the automations behind waiting runs current while the Inbox shows them.
  useAutomationsQuery();
  const entryOpen = useInboxEntryOpen(scope);
  const scopeKey = inboxScopeKey(scope);
  const inboxProjectId = inboxScopeProjectId(scope);
  const projectName = inboxProjectId
    ? (projects.find((project) => project.id === inboxProjectId)?.name ?? "this Project")
    : null;
  // Returning to an Inbox lands in the view, the Activity filter, and at the place, the reader
  // left.
  const [initialPlace] = useState(() => initialInboxPlace(scopeKey));
  const [view, setView] = useState<InboxView>(initialPlace.view);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(initialPlace.activityFilter);
  const [followsInitially] = useState(() => initiallyFollowsInbox(scopeKey));
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [manualDrafts, setManualDrafts] = useState<Readonly<Record<string, InboxDispatchDraft>>>(
    {},
  );
  const [bulkDraft, setBulkDraft] = useState<InboxDispatchDraft | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<InboxDeleteRequest | null>(null);
  // An external navigation request changes the view before rendering it. A handled message is
  // found among the messages Activity holds.
  if (visible && entryOpen && view !== entryOpen.view) {
    setSelected(new Set());
    setBulkDraft(null);
    setView(entryOpen.view);
  }
  if (
    visible &&
    entryOpen?.view === "activity" &&
    activityFilter !== "all" &&
    activityFilter !== "messages"
  ) {
    setActivityFilter("messages");
  }
  const stream = useInboxStream(scope);
  const activity = useInboxActivity(scope, activityFilter, view === "activity");
  const summary = useInboxSummary(scope);
  // The view shown pages through its own window.
  const shown = view === "inbox" ? stream : activity;
  useApplicationPending(visible && (shown.isPending || summary.isPending));
  // The Inbox's preferences arrive with the Agents they name.
  const agents = useInboxAgents();
  const settings = agents.settings;
  // A message decided here shows where it went in its place before it leaves the Inbox.
  const departures = useInboxDepartures(view === "inbox" ? stream.items : []);
  const actions = useInboxActions(
    projects,
    scope,
    windowSessionId,
    summary.data?.storeEpoch ?? null,
    stream.items,
    (pageIds, decision) => {
      if (
        decision.kind === "chat" &&
        decision.type === "new_chat" &&
        settings.showPageBesideNewChats
      )
        void onShowPagesInChat({
          sessionId: decision.sessionId,
          // The Pages open as this Inbox opens them beside itself.
          routingContext: inboxProjectId
            ? { kind: "project", projectId: inboxProjectId }
            : { kind: "library" },
          pages: pageIds.map((pageId) => ({
            pageId,
            titleSnapshot: stream.items.find((item) => item.pageId === pageId)?.title,
          })),
        });
      if (view !== "inbox") return;
      departures.depart(
        stream.items.filter((item) => pageIds.includes(item.pageId)),
        decision,
      );
    },
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(followsInitially);
  const contentRef = useRef<HTMLDivElement>(null);
  // The Inbox reads like a conversation, oldest first; Activity reads newest first.
  const inboxItems = view === "inbox" ? departures.items.toReversed() : [];
  // A Nodex post about a card that no chat works on yet can start it from the post.
  const linkedChats = usePageChatActivitySummaries(inboxChatPageIds(inboxItems));
  const nowMs = useInboxClock();
  const policy = inboxSuggestionPolicy(settings, agents.providers, nowMs);
  const suggestionsOffered = !isRemoteSpace() && inboxSuggestionsOffered(policy);
  const entries = streamEntries(inboxItems, nowMs);
  const anchors = groupAnchors(inboxItems);
  const keysByPage = new Map(
    inboxItems.map((item) => [item.pageId, item.pageKey ?? "another message"]),
  );
  const selectedItems = inboxItems.filter(
    (item) => item.rowKind === "intake" && selected.has(item.pageId),
  );

  const viewport = useInboxViewport({
    scopeKey,
    view,
    activityFilter,
    scrollRef,
    stickToBottomRef,
    anchorIds:
      view === "inbox"
        ? stream.items.map((item) => item.pageId)
        : activity.rows.map((row) => row.id),
    ready: !shown.isPending,
    hasNextPage: shown.hasNextPage,
    isFetchingNextPage: shown.isFetchingNextPage,
    fetchNextPage: shown.fetchNextPage,
  });

  // An important message out of view is pointed back to, however far back it waits, once the
  // stream it would be found in has loaded.
  const important = view === "inbox" && !stream.isPending ? (summary.data?.important ?? []) : [];
  const importantInView = useInboxMessagesInView(
    scrollRef,
    important.map((message) => message.pageId),
  );
  const buriedImportant = inboxBuriedImportant(
    important,
    summary.data?.importantCount ?? 0,
    importantInView,
  );
  const jump = useInboxJump({
    scrollRef,
    stickToBottomRef,
    hasNextPage: shown.hasNextPage,
    isFetchingNextPage: shown.isFetchingNextPage,
    fetchNextPage: shown.fetchNextPage,
  });
  const jumpToEntry = jump.jump;
  useLayoutEffect(() => {
    if (!visible || !entryOpen || view !== entryOpen.view || shown.isPending) return;
    jumpToEntry(entryOpen.pageId);
    consumeInboxEntryOpen(entryOpen);
  }, [visible, entryOpen, view, shown.isPending, jumpToEntry]);

  const following = view === "inbox" && inboxItems.length > 0;
  // While the reader is at the bottom, the Inbox follows new content like a conversation.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!following || !scroller || !content) return;
    const follow = () => {
      if (stickToBottomRef.current) scroller.scrollTop = scroller.scrollHeight;
    };
    follow();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    return () => observer.disconnect();
  }, [following]);

  const changeView = (next: InboxView) => {
    setSelected(new Set());
    setBulkDraft(null);
    setView(next);
  };
  const changeActivityFilter = (next: ActivityFilter) => {
    if (next === activityFilter) return;
    // Another filter is another timeline: it opens at its newest facts.
    viewport.followLatest("activity", next);
    setActivityFilter(next);
  };
  const toggleSelected = (pageId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  const clearSelection = () => {
    setSelected(new Set());
    setBulkDraft(null);
  };
  const send = async (intent: InboxSendInput) => {
    stickToBottomRef.current = true;
    viewport.followLatest("inbox");
    if (view !== "inbox") changeView("inbox");
    return await actions.send(intent);
  };
  const imageAccess = useInboxImageAccess(scope.kind === "project" ? scope : { kind: "library" });
  const capture = useInboxCapture({
    windowSessionId,
    scope,
    storeEpoch: summary.data?.storeEpoch ?? null,
    visiblePageIds: stream.items.map((item) => item.pageId),
    onSend: send,
  });
  const [replyFocusToken, setReplyFocusToken] = useState(0);
  const replyTo = (item: InboxItem) => {
    capture.changeDraft((draft) => ({
      ...draft,
      replyTo: {
        pageId: item.pageId,
        label: item.title,
        ...(item.turn ? { turnEpisode: item.turn.turn.episode } : {}),
      },
    }));
    setReplyFocusToken((token) => token + 1);
  };
  const setManualDraft = (pageId: string, draft: InboxDispatchDraft | null) =>
    setManualDrafts((current) => {
      const next = { ...current };
      if (draft) next[pageId] = draft;
      else delete next[pageId];
      return next;
    });
  const requestDelete = (items: readonly InboxItem[]) =>
    setDeleteRequest({
      pageIds: items.map((item) => item.pageId),
      preview: items.length === 1 && items[0] ? extractMarkdownText(items[0].body) : null,
    });
  const openTarget = (target: InboxOutcomeTarget) =>
    target.kind === "session" ? onOpenSession(target.sessionId) : onOpenDatabase(target.databaseId);

  const renderMessage = (item: InboxItem) => {
    if (item.rowKind === "problem")
      return (
        <InboxProblemRow
          item={item}
          onOpenPage={onOpenPage}
          onOpenGitHubSettings={onOpenGitHubSettings}
        />
      );
    if (item.rowKind === "turn" && item.turn) {
      const data = item.turn;
      const reply = (body: string) =>
        actions.send({
          operationId: createBoundedOperationId("inbox.turn-reply"),
          pageId: createUuidV7(),
          documentId: createUuidV7(),
          issuedAt: Date.now(),
          storeEpoch: summary.data?.storeEpoch ?? "",
          scope,
          replyToPageId: item.pageId,
          turnEpisode: data.turn.episode,
          body,
        });
      return (
        <InboxTurnRow
          item={item}
          onOpenPage={() => onOpenPage(item.pageId)}
          onOpenChat={() =>
            data.active_chat ? onOpenSession(data.active_chat.session_id) : onOpenPage(item.pageId)
          }
          onReply={() => replyTo(item)}
          onAnswer={reply}
          onAccept={() => acceptPageWork(item.pageId, data.turn.episode)}
          onStart={() =>
            startWork({ pageId: item.pageId, again: false, turnEpisode: data.turn.episode })
          }
          onOpenPR={() => {
            if (data.pull_request_url) void openExternalUrl(data.pull_request_url);
          }}
        />
      );
    }
    const proposal = item.proposal;
    const anchor = proposal ? anchors.get(proposal.proposalId) : undefined;
    const menu = (rowOffers: InboxRowOffers, handleManually: () => void) => (
      <InboxMessageMenu
        item={item}
        rowOffers={rowOffers}
        handlers={{
          onDispatch: handleManually,
          onSuggestAgain: suggestionsOffered
            ? () =>
                void actions.requestSuggestion(
                  proposal?.pageIds ?? [item.pageId],
                  proposal?.basis ?? [item.basis],
                )
            : undefined,
          onSetDone: (done) => void actions.setState([item.pageId], done ? "done" : "open"),
          onSetKind: (kind) => void actions.setKind(item.pageId, kind),
          onSetImportant: (marked) => void actions.setImportant(item.pageId, marked),
          onDelete: () => requestDelete([item]),
        }}
      />
    );
    return (
      <InboxTriage
        item={item}
        projects={projects}
        agents={agents}
        inboxProjectId={inboxProjectId}
        policy={policy}
        decided={departures.outcomeOf(item.pageId)}
        actions={actions}
        manualDraft={manualDrafts[item.pageId] ?? null}
        groupedWithKey={anchor && anchor !== item.pageId ? (keysByPage.get(anchor) ?? null) : null}
        menu={menu}
        members={(proposal?.pageIds ?? []).flatMap((pageId) => {
          const member = inboxItems.find((entry) => entry.pageId === pageId);
          return member
            ? [
                {
                  pageId,
                  label: member.pageKey ?? member.title,
                  preview: extractMarkdownText(member.body),
                },
              ]
            : [];
        })}
        onOpenPage={onOpenPage}
        onOpenSession={onOpenSession}
        onOpenAutomation={onOpenAutomation}
        onManualDraftChange={(draft) => setManualDraft(item.pageId, draft)}
        onReply={item.source.kind === "nodex" ? () => replyTo(item) : undefined}
      >
        {(triage) => (
          <InboxMessage
            item={item}
            selected={selected.has(item.pageId)}
            selectionActive={selected.size > 0}
            onToggleSelected={() => toggleSelected(item.pageId)}
            linkedChats={triage.opensChat ? null : (linkedChats.get(item.pageId) ?? null)}
            onOpenChat={onOpenSession}
            onOpenAutomation={onOpenAutomation}
            onOpenPage={() => onOpenPage(item.pageId)}
            onUnmarkImportant={() => void actions.setImportant(item.pageId, false)}
            arrivalToken={jump.arrival.pageId === item.pageId ? jump.arrival.token : null}
            editor={triage.editor}
            messageActions={triage.messageActions}
            strip={triage.strip}
            actions={triage.actions}
          />
        )}
      </InboxTriage>
    );
  };

  const selectedPageIds = selectedItems.map((item) => item.pageId);
  const combinedText = selectedItems.map((item) => messageTextOf(item.body)).join("\n\n");
  const loadEarlier = shown.hasNextPage ? (
    <button
      type="button"
      disabled={shown.isFetchingNextPage}
      onClick={() => {
        stickToBottomRef.current = false;
        void shown.fetchNextPage();
      }}
      className="cursor-interaction self-center rounded-lg px-2 py-1 text-xs text-token-description-foreground hover:text-token-foreground"
    >
      {shown.isFetchingNextPage
        ? "Loading…"
        : view === "inbox"
          ? "Show earlier messages"
          : "Show more"}
    </button>
  ) : null;
  const failed = shown.error ?? (view === "inbox" ? summary.error : null);
  const retry = () => {
    void shown.retry();
    void summary.refetch();
  };
  const loaded = view === "inbox" ? stream.items.length > 0 : activity.rows.length > 0;

  const header = (
    <InboxHeader
      view={view}
      inboxCount={summary.data?.inboxCount ?? 0}
      databaseId={summary.data?.databaseId ?? null}
      databaseLabel={inboxProjectId ? "Open Board" : "Open Inbox as a Database"}
      onViewChange={changeView}
      agents={agents}
      onOpenDatabase={onOpenDatabase}
      onOpenSettings={onOpenSettings}
      onOpenNodex={() =>
        void openNodex().then(onOpenSession, (error: unknown) =>
          toast.danger(readableIpcError(error, "Couldn’t open Nodex")),
        )
      }
    />
  );

  return (
    <div
      data-testid="inbox-route"
      data-inbox-scope={inboxProjectId ? "project" : "library"}
      className="flex h-full min-h-0 w-full flex-col"
    >
      {header}
      <div
        data-testid={view === "activity" ? "inbox-activity" : undefined}
        className="relative flex min-h-0 flex-1 flex-col"
      >
        {view === "activity" ? (
          <InboxActivityFilters filter={activityFilter} onChange={changeActivityFilter} />
        ) : null}
        <InboxImportantBar buried={buriedImportant} nowMs={nowMs} onJump={jump.jump} />
        <div
          ref={scrollRef}
          data-testid="inbox-stream"
          data-inbox-view={view}
          onScroll={(event) => {
            viewport.onScroll();
            if (view !== "inbox") return;
            const element = event.currentTarget;
            stickToBottomRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              INBOX_STICK_TO_BOTTOM_PX;
          }}
          // Both gutters stay reserved, so a scrollbar appearing never nudges the stream sideways.
          className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable_both-edges]"
        >
          {failed ? (
            <div
              role="status"
              className="mx-auto flex w-full max-w-(--thread-content-max-width) items-center gap-2 px-toolbar py-2 text-sm text-token-description-foreground"
            >
              <span>{`Couldn’t ${loaded ? "refresh" : "load"} ${INBOX_VIEWS[view].label}`}</span>
              <NodexButton size="xs" variant="ghost" onClick={retry}>
                Retry
              </NodexButton>
            </div>
          ) : null}
          {shown.isPending || (failed && !loaded) ? null : view === "activity" ? (
            <div className="mx-auto flex w-full max-w-(--thread-content-max-width) flex-1 flex-col gap-3 px-toolbar pt-2 pb-6">
              <InboxActivity
                rows={activity.rows}
                filter={activityFilter}
                arrival={jump.arrival}
                onOpenPage={onOpenPage}
                onOpenSession={onOpenSession}
                onOpenAutomation={onOpenAutomation}
                onOpenGitHubSettings={onOpenGitHubSettings}
                onOpenTarget={openTarget}
                onReturn={(pageId) => void actions.setState([pageId], "open")}
                onSetDone={(pageId, done) =>
                  void actions.setState([pageId], done ? "done" : "open")
                }
                onDelete={(item) => requestDelete([item])}
              />
              {loadEarlier}
            </div>
          ) : inboxItems.length === 0 ? (
            <EmptyState
              everUsed={(summary.data?.entryCount ?? 0) > 0}
              projectName={projectName}
              planning={
                <InboxPlanningSummary
                  agents={agents}
                  policy={policy}
                  nowMs={nowMs}
                  projectName={projectName}
                />
              }
            />
          ) : (
            <div
              ref={contentRef}
              // Like a conversation, a short Inbox rests against the composer.
              className="mx-auto mt-auto flex w-full max-w-(--thread-content-max-width) shrink-0 flex-col px-toolbar pt-6 pb-3"
            >
              {loadEarlier}
              <AnimatePresence initial={false}>
                {entries.map((entry) =>
                  entry.kind === "time" ? (
                    <motion.div key={entry.key} layout="position" exit={{ opacity: 0 }}>
                      <ThreadTimestampSeparator sentAtMs={entry.sentAtMs} />
                    </motion.div>
                  ) : (
                    <InboxStreamItem
                      key={entry.key}
                      onHoldChange={(held) => departures.hold(entry.item.pageId, held)}
                    >
                      {renderMessage(entry.item)}
                    </InboxStreamItem>
                  ),
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
      <div
        className={cn(
          "relative mx-auto flex w-full max-w-(--thread-content-max-width) shrink-0 flex-col px-toolbar pb-6",
          // Activity has no composer; the draft stays as it was for the Inbox.
          view === "activity" && "hidden",
        )}
      >
        {/* Selection tools float over the stream, so selecting never resizes or shifts it. */}
        <AnimatePresence>
          {selectedItems.length > 0 ? (
            <motion.div
              key={bulkDraft ? "bulk-editor" : "bulk-bar"}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.18, ease: INBOX_EASE_OUT }}
              className={cn(
                "absolute bottom-full z-10 mb-2",
                bulkDraft ? "inset-x-toolbar" : "left-1/2 -translate-x-1/2",
              )}
            >
              {bulkDraft ? (
                <div className="rounded-2xl border border-token-border bg-token-main-surface-primary p-2 shadow-lg">
                  <InboxDispatchEditor
                    embedded
                    initial={bulkDraft}
                    projects={projects}
                    agents={agents}
                    inboxProjectId={inboxProjectId}
                    onCancel={() => setBulkDraft(null)}
                    onSubmit={async (action, choice) => {
                      const done = await actions.dispatch(
                        (bulkDraft.basis ?? []).map((basis) => basis.pageId),
                        action,
                        bulkDraft.basis ?? [],
                        choice,
                      );
                      if (done) setSelected(new Set());
                      return done;
                    }}
                  />
                </div>
              ) : (
                <div
                  data-testid="inbox-bulk-bar"
                  className="flex items-center gap-0.5 rounded-full border border-token-border bg-token-main-surface-primary py-1 pr-1 pl-3 shadow-lg"
                >
                  <span className="mr-1.5 text-sm text-token-foreground tabular-nums">
                    {selectedItems.length} selected
                  </span>
                  {suggestionsOffered ? (
                    <InboxIconAction
                      label="Suggest together"
                      icon={RefreshIcon}
                      disabled={selectedItems.length > 16}
                      onClick={() =>
                        void actions
                          .requestSuggestion(
                            selectedPageIds,
                            selectedItems.map((item) => item.basis),
                          )
                          .then((done) => {
                            if (done) clearSelection();
                          })
                      }
                    />
                  ) : null}
                  <InboxIconAction
                    label="Handle manually"
                    icon={DispatchIcon}
                    disabled={selectedItems.length > 16}
                    onClick={() =>
                      setBulkDraft({
                        ...draftFromAction(
                          inboxNewChatAction(inboxProjectId, combinedText),
                          combinedText,
                        ),
                        basis: selectedItems.map((item) => item.basis),
                      })
                    }
                  />
                  <InboxIconAction
                    label="Keep"
                    icon={ArchiveIcon}
                    onClick={() =>
                      void actions.keep(selectedPageIds).then((done) => {
                        if (done) clearSelection();
                      })
                    }
                  />
                  <InboxIconAction
                    label="Mark done"
                    icon={CheckmarkIcon}
                    onClick={() =>
                      void actions.setState(selectedPageIds, "done").then((done) => {
                        if (done) clearSelection();
                      })
                    }
                  />
                  <InboxIconAction
                    label="Delete"
                    icon={DeleteIcon}
                    tone="danger"
                    onClick={() => requestDelete(selectedItems)}
                  />
                  <span aria-hidden="true" className="mx-1 h-4 w-px bg-token-border" />
                  <InboxIconAction
                    label="Clear selection"
                    icon={CloseIcon}
                    onClick={clearSelection}
                  />
                </div>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
        {actions.pendingDecisions.map(({ key, prepared }) => (
          <div
            key={key}
            role="status"
            className="mb-2 flex min-w-0 items-center gap-2 px-2 text-sm text-token-description-foreground"
          >
            <details className="min-w-0 flex-1">
              <summary className="cursor-interaction">Handoff not confirmed</summary>
              {prepared.action && "prompt" in prepared.action ? (
                <p className="whitespace-pre-wrap">{prepared.action.prompt}</p>
              ) : null}
              {summary.data && prepared.storeEpoch !== summary.data.storeEpoch ? (
                <p className="mt-1 text-xs">
                  From before a Profile restore. Review the current message before trying again.
                </p>
              ) : null}
            </details>
            {summary.data && prepared.storeEpoch !== summary.data.storeEpoch ? (
              <NodexButton
                size="xs"
                variant="ghost"
                onClick={() => void actions.forgetDecision(key)}
              >
                Clear
              </NodexButton>
            ) : (
              <NodexButton
                size="xs"
                variant="ghost"
                disabled={!summary.data}
                onClick={() => void actions.retryDecision(key)}
              >
                Retry
              </NodexButton>
            )}
          </div>
        ))}
        <InboxCaptureRecovery
          captures={capture.pending}
          storeEpoch={summary.data?.storeEpoch ?? null}
          ready={capture.ready}
          onRetry={capture.retry}
          onRecover={capture.recover}
        />
        {!isRemoteSpace() && policy.kind === "paused" && view === "inbox" ? (
          <InboxSuggestionPauseNotice pause={policy.pause} nowMs={nowMs} />
        ) : null}
        {capture.validationError ? (
          <p role="alert" className="mb-2 text-xs text-token-error-foreground">
            {capture.validationError}
          </p>
        ) : null}
        {capture.error ? (
          <div
            role="alert"
            className="mb-2 flex items-center gap-2 text-xs text-token-error-foreground"
          >
            {capture.canEdit
              ? "Draft could not be saved. Your text is still here."
              : "Couldn’t load your saved draft."}
            <NodexButton size="xs" variant="ghost" onClick={() => void capture.retryPersistence()}>
              Retry
            </NodexButton>
          </div>
        ) : null}
        <InboxComposer
          draft={capture.draft}
          onDraftChange={capture.changeDraft}
          images={imageAccess}
          disabled={!capture.ready || capture.savingDraft}
          readOnly={!capture.canEdit || capture.savingDraft}
          onSend={capture.submit}
          focusToken={(focusComposerToken ?? 0) + replyFocusToken}
          placeholder={projectName ? `Add a thought to ${projectName}…` : undefined}
        />
      </div>
      {deleteRequest ? (
        <InboxDeleteDialog
          request={deleteRequest}
          onCancel={() => setDeleteRequest(null)}
          onConfirm={async () => {
            const done = await actions.delete(deleteRequest.pageIds);
            if (!done) return;
            setDeleteRequest(null);
            setSelected((current) => {
              const next = new Set(current);
              for (const pageId of deleteRequest.pageIds) next.delete(pageId);
              return next;
            });
          }}
        />
      ) : null}
    </div>
  );
}
