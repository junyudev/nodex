import { useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { InboxItem, InboxWindowFilter } from "../../../shared/inbox";
import type { Project } from "../../../shared/types";
import {
  ArchiveIcon,
  BoardIcon,
  CheckmarkIcon,
  CloseIcon,
  DeleteIcon,
  DispatchIcon,
  SettingsGeneralIcon,
  AskAiIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { AppShellHeaderContentRegistrar } from "@/lib/workbench-ui-scopes";
import { cn } from "@/lib/utils";
import { ThreadTimestampSeparator } from "@/features/local-conversation/view/shared/thread-timestamp-separator";
import { InboxComposer } from "./inbox-composer";
import {
  InboxDispatchEditor,
  draftFromAction,
  type InboxDispatchDraft,
} from "./inbox-dispatch-editor";
import { InboxDeleteDialog, type InboxDeleteRequest } from "./inbox-delete-dialog";
import { InboxHistory } from "./inbox-history";
import { InboxIconAction } from "./inbox-icon-action";
import { InboxMessage, InboxMessageMenu } from "./inbox-message";
import {
  INBOX_VIEW_LABELS,
  inboxTimestampSeparators,
  type InboxOutcomeTarget,
} from "./inbox-presentation";
import { InboxTriage } from "./inbox-triage";
import { useInboxActions } from "./use-inbox-actions";
import {
  useInboxInvalidation,
  useInboxSettings,
  useInboxStream,
  useInboxSummary,
} from "./use-inbox";

const STICK_TO_BOTTOM_PX = 160;
const EASE_OUT = [0.2, 0, 0, 1] as const;

export interface InboxRouteProps {
  readonly projects: readonly Project[];
  readonly focusComposerToken?: number;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onOpenPage: (pageId: string) => void;
  readonly onOpenDatabase: (databaseId: string) => void;
  readonly onOpenSettings: () => void;
}

function InboxHeader({
  view,
  inboxCount,
  databaseId,
  onViewChange,
  onOpenDatabase,
  onOpenSettings,
}: {
  readonly view: InboxWindowFilter;
  readonly inboxCount: number;
  readonly databaseId: string | null;
  readonly onViewChange: (view: InboxWindowFilter) => void;
  readonly onOpenDatabase: (databaseId: string) => void;
  readonly onOpenSettings: () => void;
}) {
  return (
    <header className="draggable grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 electron:h-toolbar">
      <div role="tablist" aria-label="Inbox view" className="no-drag flex min-w-0 items-center">
        {(["inbox", "processed"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={view === option}
            onClick={() => onViewChange(option)}
            className={cn(
              "cursor-interaction inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-base transition-colors",
              view === option
                ? "font-medium text-token-foreground"
                : "text-token-description-foreground hover:text-token-foreground",
            )}
          >
            {INBOX_VIEW_LABELS[option]}
            {option === "inbox" && inboxCount > 0 ? (
              <span className="text-xs font-normal text-token-description-foreground tabular-nums">
                {inboxCount}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="no-drag flex items-center gap-0.5">
        {databaseId ? (
          <NodexTooltip tooltipContent="Open Inbox as a Database" side="bottom">
            <NodexButton
              size="icon-xs"
              variant="ghost"
              aria-label="Open Inbox as a Database"
              onClick={() => onOpenDatabase(databaseId)}
            >
              <BoardIcon className="icon-xs" />
            </NodexButton>
          </NodexTooltip>
        ) : null}
        <NodexTooltip tooltipContent="Inbox settings" side="bottom">
          <NodexButton
            size="icon-xs"
            variant="ghost"
            aria-label="Inbox settings"
            onClick={onOpenSettings}
          >
            <SettingsGeneralIcon className="icon-xs" />
          </NodexButton>
        </NodexTooltip>
      </div>
    </header>
  );
}

function EmptyState({
  view,
  everUsed,
  onShowHistory,
}: {
  readonly view: InboxWindowFilter;
  readonly everUsed: boolean;
  readonly onShowHistory: () => void;
}) {
  if (view === "processed") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-base font-medium text-token-foreground">Nothing handled yet</p>
        <p className="max-w-sm text-sm text-balance text-token-description-foreground">
          Messages you dispatch, file, keep, or finish collect here.
        </p>
      </div>
    );
  }
  if (!everUsed) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-base font-medium text-token-foreground">Nothing in your Inbox yet</p>
        <p className="max-w-sm text-sm text-balance text-token-description-foreground">
          Drop a thought, a todo, or a question. Nodex suggests where it should go, and nothing runs
          until you confirm.
        </p>
      </div>
    );
  }
  return (
    <motion.div
      data-testid="inbox-zero"
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35, ease: EASE_OUT }}
      className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
    >
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
      <NodexButton size="xs" variant="ghost" onClick={onShowHistory}>
        Show History
      </NodexButton>
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
  projects,
  focusComposerToken,
  onOpenSession,
  onOpenPage,
  onOpenDatabase,
  onOpenSettings,
}: InboxRouteProps) {
  useInboxInvalidation();
  const [view, setView] = useState<InboxWindowFilter>("inbox");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [manualDrafts, setManualDrafts] = useState<Readonly<Record<string, InboxDispatchDraft>>>(
    {},
  );
  const [bulkDraft, setBulkDraft] = useState<InboxDispatchDraft | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<InboxDeleteRequest | null>(null);
  const stream = useInboxStream(view);
  const summary = useInboxSummary();
  const settings = useInboxSettings();
  const actions = useInboxActions(projects);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  // The Inbox reads like a conversation, oldest first; History reads newest first.
  const inboxItems = view === "inbox" ? stream.items.toReversed() : [];
  const entries = streamEntries(inboxItems, Date.now());
  const anchors = groupAnchors(inboxItems);
  const keysByPage = new Map(
    inboxItems.map((item) => [item.pageId, item.pageKey ?? "another message"]),
  );
  const selectedItems = inboxItems.filter((item) => selected.has(item.pageId));

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

  const changeView = (next: InboxWindowFilter) => {
    stickToBottomRef.current = next === "inbox";
    setSelected(new Set());
    setBulkDraft(null);
    setView(next);
    if (next === "processed") scrollRef.current?.scrollTo({ top: 0 });
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
  const send = async (text: string) => {
    stickToBottomRef.current = true;
    if (view !== "inbox") changeView("inbox");
    return await actions.send(text);
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
      preview: items.length === 1 ? (items[0]?.body ?? null) : null,
    });
  const openTarget = (target: InboxOutcomeTarget) =>
    target.kind === "session" ? onOpenSession(target.sessionId) : onOpenDatabase(target.databaseId);

  const renderMessage = (item: InboxItem) => {
    const proposal = item.proposal;
    const anchor = proposal ? anchors.get(proposal.proposalId) : undefined;
    const menu = (
      <InboxMessageMenu
        item={item}
        handlers={{
          onOpenPage: () => onOpenPage(item.pageId),
          onDispatch: () =>
            setManualDraft(
              item.pageId,
              draftFromAction(
                proposal?.action ?? { type: "new_chat", projectId: null, prompt: item.body },
                item.body,
              ),
            ),
          onSuggestAgain: () => void actions.requestSuggestion([item.pageId]),
          onSetDone: (done) => void actions.setState([item.pageId], done ? "done" : "open"),
          onDelete: () => requestDelete([item]),
        }}
      />
    );
    return (
      <InboxTriage
        item={item}
        projects={projects}
        suggestionsEnabled={settings.suggestionsEnabled}
        actions={actions}
        manualDraft={manualDrafts[item.pageId] ?? null}
        groupedWithKey={anchor && anchor !== item.pageId ? (keysByPage.get(anchor) ?? null) : null}
        menu={menu}
        onManualDraftChange={(draft) => setManualDraft(item.pageId, draft)}
      >
        {(triage) => (
          <InboxMessage
            item={item}
            selected={selected.has(item.pageId)}
            selectionActive={selected.size > 0}
            onToggleSelected={() => toggleSelected(item.pageId)}
            onOpenSource={onOpenSession}
            strip={triage.strip}
            actions={triage.actions}
          />
        )}
      </InboxTriage>
    );
  };

  const selectedPageIds = selectedItems.map((item) => item.pageId);
  const combinedText = selectedItems.map((item) => item.body).join("\n\n");
  const loadEarlier = stream.hasNextPage ? (
    <button
      type="button"
      disabled={stream.isFetchingNextPage}
      onClick={() => {
        stickToBottomRef.current = false;
        void stream.fetchNextPage();
      }}
      className="cursor-interaction self-center rounded-lg px-2 py-1 text-xs text-token-description-foreground hover:text-token-foreground"
    >
      {stream.isFetchingNextPage
        ? "Loading…"
        : view === "inbox"
          ? "Show earlier messages"
          : "Show more"}
    </button>
  ) : null;

  return (
    <div data-testid="inbox-route" className="main-surface flex h-full min-h-0 w-full flex-col">
      <AppShellHeaderContentRegistrar
        content={
          <InboxHeader
            view={view}
            inboxCount={summary.data?.inboxCount ?? 0}
            databaseId={summary.data?.databaseId ?? null}
            onViewChange={changeView}
            onOpenDatabase={onOpenDatabase}
            onOpenSettings={onOpenSettings}
          />
        }
      />
      <div aria-hidden="true" className="h-toolbar shrink-0" />
      <div
        ref={scrollRef}
        data-testid="inbox-stream"
        data-inbox-view={view}
        onScroll={(event) => {
          if (view !== "inbox") return;
          const element = event.currentTarget;
          stickToBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < STICK_TO_BOTTOM_PX;
        }}
        // Both gutters stay reserved, so a scrollbar appearing never nudges the stream sideways.
        className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable_both-edges]"
      >
        {stream.isPending ? null : stream.items.length === 0 ? (
          <EmptyState
            view={view}
            everUsed={(summary.data?.entryCount ?? 0) > 0}
            onShowHistory={() => changeView("processed")}
          />
        ) : view === "processed" ? (
          <div className="mx-auto flex w-full max-w-(--thread-content-max-width) flex-col gap-3 px-toolbar py-6">
            <InboxHistory
              items={stream.items}
              onOpenTarget={openTarget}
              onOpenPage={onOpenPage}
              onReturn={(pageId) => void actions.setState([pageId], "open")}
              onDelete={(item) => requestDelete([item])}
            />
            {loadEarlier}
          </div>
        ) : (
          <div
            ref={contentRef}
            // Like a conversation, a short Inbox rests against the composer.
            className="mx-auto mt-auto flex w-full max-w-(--thread-content-max-width) flex-col px-toolbar pt-6 pb-3"
          >
            {loadEarlier}
            <AnimatePresence initial={false}>
              {entries.map((entry) =>
                entry.kind === "time" ? (
                  <motion.div key={entry.key} layout="position" exit={{ opacity: 0 }}>
                    <ThreadTimestampSeparator sentAtMs={entry.sentAtMs} />
                  </motion.div>
                ) : (
                  <motion.div
                    key={entry.key}
                    layout="position"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    // A handled message folds away, which is what clearing the Inbox feels like.
                    exit={{ opacity: 0, height: 0, scale: 0.98 }}
                    transition={{ duration: 0.28, ease: EASE_OUT }}
                    className="origin-top overflow-hidden pb-4"
                  >
                    {renderMessage(entry.item)}
                  </motion.div>
                ),
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
      <div className="relative mx-auto flex w-full max-w-(--thread-content-max-width) shrink-0 flex-col px-toolbar pb-6">
        {/* Selection tools float over the stream, so selecting never resizes or shifts it. */}
        <AnimatePresence>
          {selectedItems.length > 0 ? (
            <motion.div
              key={bulkDraft ? "bulk-editor" : "bulk-bar"}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.18, ease: EASE_OUT }}
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
                    onCancel={() => setBulkDraft(null)}
                    onSubmit={async (action) => {
                      const done = await actions.dispatch(selectedPageIds, action);
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
                  <InboxIconAction
                    label="Suggest together"
                    icon={AskAiIcon}
                    disabled={selectedItems.length > 16}
                    onClick={() =>
                      void actions.requestSuggestion(selectedPageIds).then((done) => {
                        if (done) clearSelection();
                      })
                    }
                  />
                  <InboxIconAction
                    label="Dispatch…"
                    icon={DispatchIcon}
                    disabled={selectedItems.length > 16}
                    onClick={() =>
                      setBulkDraft(
                        draftFromAction(
                          { type: "new_chat", projectId: null, prompt: combinedText },
                          combinedText,
                        ),
                      )
                    }
                  />
                  <InboxIconAction
                    label="Keep as notes"
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
                    label="Delete…"
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
        <InboxComposer onSend={send} focusToken={focusComposerToken} />
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
