import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { MoreActionsIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { LoadingPlaceholder } from "@/components/ui/loading-placeholder";
import { toast } from "@/components/ui/toast";
import { writeTextToClipboard } from "@/lib/clipboard";
import type { DocumentRecovery } from "@/lib/document-recovery";
import {
  formatRecoveryTime,
  receivedRecoveryKey,
  recoveryReviewEntries,
  stagedRecoveryKey,
  type RecoveryReviewEntry,
} from "@/lib/document-recovery-entries";
import {
  loadRecoveryComparison,
  orderRecoveryEntries,
  recoveryDecision,
  recoveryEntryIsPending,
  recoveryEntryMeta,
  recoveryEntryTitle,
  recoveryNewContentMarkdown,
  type RecoveryComparison,
} from "@/lib/document-recovery-review";
import type { RecoveryStagingSummary } from "@/lib/document-recovery-staging";
import { toastFailure } from "@/lib/failure-toast";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import type { ModalCloseProps } from "@/lib/modal-registry";
import { cn } from "@/lib/utils";
import { contentRoutingIdentityKey } from "../../../shared/content-routing-context";
import type {
  RecoveryChoice,
  RecoveryDraftInspection,
} from "../../../shared/block-documents/document-recovery";
import { RecoveryDiff } from "./recovery-diff";
import { useOpenDocumentRecoveryReview } from "./recovery-entry";
import {
  RecoveryCanvasPreview,
  RecoveryDocumentPreview,
  type RecoveryPreviewContext,
} from "./recovery-preview";

type RecoveryReviewProps = ModalCloseProps & {
  module: DocumentRecovery;
  exportLocal?: () => Promise<void>;
  initialDraftId?: string;
  initialSourceKey?: string;
};

export function RecoveryReview(props: RecoveryReviewProps) {
  return (
    <RecoveryReviewContent
      key={`${contentRoutingIdentityKey(props.module.scope)}\0${props.module.documentId ?? "library"}\0${props.initialSourceKey ?? props.initialDraftId ?? "list"}`}
      {...props}
    />
  );
}

interface RecoveryAction {
  readonly label: string;
  readonly run: () => void;
}

const RESOLVE_FAILURE_TITLE = {
  restore: "Couldn’t restore these edits",
  copy: "Couldn’t save a copy",
  discard: "Couldn’t discard these edits",
  reopen: "Couldn’t undo the discard",
  reconcile: "Couldn’t check these edits",
} as const satisfies Record<RecoveryChoice, string>;

/** Reads what Core allows and the two versions to compare; stale reads stay on screen until replaced. */
function useReceivedDraft(module: DocumentRecovery, draftId: string | null, requestKey: string) {
  const [loaded, setLoaded] = useState<{
    readonly draftId: string;
    readonly inspection: RecoveryDraftInspection | null;
    readonly comparison: RecoveryComparison;
    readonly failure: string | null;
  } | null>(null);
  // A new revision of the draft, or of the Library's drafts, is a new read of the same draft.
  const [request, setRequest] = useState({ key: requestKey, draftId });
  if (request.key !== requestKey) setRequest({ key: requestKey, draftId });
  useEffect(() => {
    const { draftId } = request;
    if (!draftId) return;
    let active = true;
    void (async () => {
      const inspection = await module.inspect(draftId);
      if (!active) return;
      setLoaded((previous) => ({
        draftId,
        inspection,
        comparison:
          previous?.draftId === draftId ? previous.comparison : ({ kind: "loading" } as const),
        failure: null,
      }));
      const comparison = await loadRecoveryComparison(inspection, module.preview);
      if (active) setLoaded({ draftId, inspection, comparison, failure: null });
    })().catch((error: unknown) => {
      if (active)
        setLoaded({
          draftId,
          inspection: null,
          comparison: { kind: "loading" },
          failure: error instanceof Error ? error.message : String(error),
        });
    });
    return () => {
      active = false;
    };
  }, [module, request]);
  return loaded?.draftId === draftId ? loaded : null;
}

function RecoveryReviewContent({
  module,
  onClose,
  exportLocal,
  initialDraftId,
  initialSourceKey,
}: RecoveryReviewProps) {
  const state = useSyncExternalStore(module.subscribe, module.getSnapshot);
  const openReview = useOpenDocumentRecoveryReview();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(
    initialSourceKey
      ? stagedRecoveryKey(initialSourceKey)
      : initialDraftId
        ? receivedRecoveryKey(initialDraftId)
        : null,
  );
  const [resolvedRequested, setResolvedRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [lastDiscard, setLastDiscard] = useState<{
    readonly draftId: string;
    readonly title: string;
  } | null>(null);
  const { pending, resolved } = orderRecoveryEntries(recoveryReviewEntries(state));
  // With nothing left to review, what was already resolved is the only reason to be here.
  const listResolved = resolvedRequested || (!state.loading && pending.length === 0);
  useEffect(() => module.connect(), [module]);
  useEffect(() => {
    void module.setIncludeResolved(listResolved);
  }, [module, listResolved]);
  useEffect(
    () => () => {
      void module.setIncludeResolved(false);
    },
    [module],
  );
  const listed = listResolved ? [...pending, ...resolved] : pending;
  const redirected = Object.entries(state.acceptedLocal).find(
    ([key]) => stagedRecoveryKey(key) === selected,
  )?.[1];
  const entry =
    listed.find((candidate) => candidate.key === selected) ??
    listed.find((candidate) => candidate.key === receivedRecoveryKey(redirected ?? "")) ??
    listed[0] ??
    null;
  const select = (next: RecoveryReviewEntry) => {
    setSelected(next.key);
    setConfirmingRemoval(false);
  };

  const received = entry?.kind === "received" ? entry.draft : null;
  const draft = useReceivedDraft(
    module,
    received?.draft_id ?? null,
    JSON.stringify([received?.draft_id, received?.revision, state.previewRevision]),
  );
  const inspection = draft?.inspection ?? null;
  const comparison = draft?.comparison ?? ({ kind: "loading" } as const);
  const decision = inspection ? recoveryDecision(inspection, comparison) : null;
  const previewContext: RecoveryPreviewContext | null = received
    ? {
        scope: module.scope,
        documentId: received.document_id,
        draftId: received.draft_id,
        storeEpoch: state.storeEpoch,
      }
    : null;

  const nextPending = () => pending.find((candidate) => candidate.key !== entry?.key) ?? null;
  const reopenDraft = async (draftId: string) => {
    const current = await module.inspect(draftId);
    await module.resolve(current, "reopen");
    await module.refresh();
  };
  const resolve = async (choice: "restore" | "copy" | "discard" | "reopen") => {
    if (!inspection || busy) return;
    setBusy(true);
    setLastDiscard(null);
    await runWithCleanup(
      async () => {
        const result = await module.resolve(inspection, choice);
        if (choice === "reopen") {
          await module.refresh();
          return;
        }
        const next = nextPending();
        if (choice === "restore") toast.success("Edits restored");
        else if (choice === "copy") toast.success("Saved as a separate copy in your Library");
        else if (next) setLastDiscard({ draftId: result.draft_id, title });
        // A toast outside an open modal is inert, so only a closing review can offer Undo there.
        else
          toast.info("Edits discarded", {
            action: {
              label: "Undo",
              onClick: () => {
                void reopenDraft(result.draft_id)
                  .then(() =>
                    openReview({
                      scope: module.scope,
                      documentId: module.documentId,
                      draftId: result.draft_id,
                    }),
                  )
                  .catch((error: unknown) => toastFailure(RESOLVE_FAILURE_TITLE.reopen, error));
              },
            },
          });
        if (next) select(next);
        else onClose();
        void module.refresh();
      },
      {
        onError: async (error: unknown) => toastFailure(RESOLVE_FAILURE_TITLE[choice], error),
        cleanup: () => setBusy(false),
      },
    );
  };
  const exportBackup = () =>
    runWithCleanup(
      async () => {
        if (entry?.kind === "staged") await module.exportLocal(entry.source.sourceKey);
        else if (received) await module.export(received.draft_id);
        else await exportLocal?.();
      },
      { onError: async (error: unknown) => toastFailure("Couldn’t export a backup", error) },
    );
  const copy = async (markdown: string) => {
    if (await writeTextToClipboard(markdown)) toast.success("Copied");
    else toastFailure("Couldn’t copy these edits");
  };
  const retryLocal = async (source: RecoveryStagingSummary) => {
    setBusy(true);
    await runWithCleanup(() => module.retry(source.sourceKey), {
      onError: async (error: unknown) => toastFailure("Still couldn’t save a recovery copy", error),
      cleanup: () => setBusy(false),
    });
  };
  const removeLocal = async (source: RecoveryStagingSummary) => {
    setBusy(true);
    await runWithCleanup(
      async () => {
        const next = nextPending();
        await module.removeLocal(source);
        setConfirmingRemoval(false);
        if (next) select(next);
        else onClose();
      },
      {
        onError: async (error: unknown) => toastFailure("Couldn’t remove these edits", error),
        cleanup: () => setBusy(false),
      },
    );
  };

  const title = entry ? recoveryEntryTitle(entry) : "Unsaved edits";
  const time = received?.created_at ?? (entry?.kind === "staged" ? entry.source.createdAt : null);
  const sending = entry?.kind === "staged" && state.sending.includes(entry.source.sourceKey);
  const listFailure = state.localError ?? state.error;
  const description = (() => {
    if (entry?.kind === "staged")
      return sending
        ? "Saving a recovery copy…"
        : entry.source.failure
          ? "These edits are safe on this device, but Nodex couldn’t save a recovery copy."
          : "These edits are safe on this device and waiting for a recovery copy.";
    if (received) return draft?.failure ? "Couldn’t read these edits." : decision?.headline;
    if (state.loading) return "Checking for unsaved edits…";
    if (exportLocal)
      return "These edits are only in this window. Export a backup before closing it.";
    return listFailure
      ? "Couldn’t check for unsaved edits."
      : "Nothing to review. No edits were lost.";
  })();
  const detail =
    entry?.kind === "staged" ? entry.source.failure?.message : (draft?.failure ?? decision?.detail);

  const diff = comparison.kind === "diff" ? comparison.diff : null;
  const previewAfter =
    comparison.kind === "diff" || comparison.kind === "document" ? comparison.after : null;
  const exportAction: RecoveryAction = {
    label: "Export backup",
    run: () => void exportBackup(),
  };
  const saveCopyAction: RecoveryAction = {
    label: "Save as a copy",
    run: () => void resolve("copy"),
  };
  const copyAllAction: RecoveryAction | null = previewAfter
    ? { label: "Copy as Markdown", run: () => void copy(previewAfter.markdown) }
    : null;
  const primaryAction = ((): RecoveryAction | null => {
    if (entry?.kind === "staged")
      return sending ? null : { label: "Try again", run: () => void retryLocal(entry.source) };
    if (!entry) return exportLocal ? exportAction : null;
    switch (decision?.primary) {
      case "restore":
        return { label: "Restore edits", run: () => void resolve("restore") };
      case "copy":
        return saveCopyAction;
      case "copy-new":
        return diff
          ? { label: "Copy new content", run: () => void copy(recoveryNewContentMarkdown(diff)) }
          : null;
      case "copy-all":
        return copyAllAction;
      case "discard":
        return { label: "Discard", run: () => void resolve("discard") };
      case "reopen":
        return { label: "Undo discard", run: () => void resolve("reopen") };
      case "export":
        return exportAction;
      default:
        return null;
    }
  })();
  // The menu holds only what the footer does not already show.
  const menuActions = [
    inspection?.can_copy ? saveCopyAction : null,
    copyAllAction,
    entry || exportLocal ? exportAction : null,
    pending.length > 0
      ? {
          label: resolvedRequested ? "Hide resolved" : "Show resolved",
          run: () => setResolvedRequested((value) => !value),
        }
      : null,
  ].filter(
    (action): action is RecoveryAction => action !== null && action.label !== primaryAction?.label,
  );
  // Discarding sits beside the decision it competes with, unless it already is the decision.
  const secondary =
    entry?.kind === "staged" ? (
      <NodexButton
        variant="ghostSecondary"
        size="sm"
        disabled={busy || sending}
        onClick={() => setConfirmingRemoval(true)}
      >
        Remove
      </NodexButton>
    ) : inspection && !inspection.summary.resolution && decision?.primary !== "discard" ? (
      <NodexButton
        variant="ghostSecondary"
        size="sm"
        disabled={busy}
        onClick={() => void resolve("discard")}
      >
        Discard
      </NodexButton>
    ) : null;

  const hasRail = listed.length > 1 || state.hasMore || state.localHasMore;
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent
        initialFocus={bodyRef}
        className={cn(
          "flex max-h-[min(86vh,780px)] bg-token-main-surface-primary backdrop-blur-none",
          hasRail ? "h-[min(86vh,780px)] w-[980px]" : "w-[760px]",
        )}
      >
        {hasRail ? (
          <RecoveryEntryRail
            pending={pending}
            resolved={listResolved ? resolved : []}
            selectedKey={entry?.key ?? null}
            sending={state.sending}
            disabled={busy}
            canLoadMore={state.hasMore || state.localHasMore}
            onLoadMore={() => void module.loadMore()}
            onSelect={select}
          />
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 flex-col gap-0.5 py-4 pr-12 pl-5">
            <div className="flex min-w-0 items-baseline gap-2">
              <NodexDialogTitle className="truncate text-base font-semibold">
                <span className="sr-only">Unsaved edits: </span>
                {title}
              </NodexDialogTitle>
              {time ? (
                <time
                  dateTime={time}
                  className="shrink-0 text-xs text-token-description-foreground tabular-nums"
                >
                  {formatRecoveryTime(time)}
                </time>
              ) : null}
            </div>
            <NodexDialogDescription className="text-sm text-token-text-secondary">
              {description}
            </NodexDialogDescription>
            {detail ? <p className="text-xs text-token-description-foreground">{detail}</p> : null}
          </header>
          {/* Opening lands here, so arrows scroll the comparison and Enter can't resolve by accident. */}
          <div
            ref={bodyRef}
            tabIndex={-1}
            className="min-h-0 flex-1 overflow-y-auto border-t-[0.5px] border-token-border px-2 py-3 outline-none empty:py-0"
          >
            {listFailure ? (
              <p role="alert" className="flex items-center gap-2 px-3 py-1 text-sm">
                <span className="min-w-0 flex-1 text-token-text-secondary">{listFailure}</span>
                <NodexButton variant="ghost" size="xs" onClick={() => void module.refresh()}>
                  Refresh
                </NodexButton>
              </p>
            ) : null}
            {received && previewContext ? (
              <RecoveryComparisonBody
                comparison={comparison}
                failed={Boolean(draft?.failure)}
                context={previewContext}
              />
            ) : null}
          </div>
          <footer className="mt-auto flex shrink-0 items-center gap-2 border-t-[0.5px] border-token-border px-4 py-2.5">
            {confirmingRemoval && entry?.kind === "staged" ? (
              <>
                <p className="min-w-0 flex-1 text-xs text-token-text-secondary">
                  Permanently remove these edits? This can’t be undone. Export a backup first if you
                  might need them.
                </p>
                <NodexButton
                  variant="ghostSecondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmingRemoval(false)}
                >
                  Keep
                </NodexButton>
                <NodexButton
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => void removeLocal(entry.source)}
                >
                  Remove permanently
                </NodexButton>
              </>
            ) : (
              <>
                {secondary}
                <div className="flex min-w-0 flex-1 items-center justify-end gap-1 text-xs text-token-description-foreground">
                  {lastDiscard ? (
                    <>
                      <span role="status" className="min-w-0 truncate">
                        Discarded “{lastDiscard.title}”
                      </span>
                      <NodexButton
                        variant="ghost"
                        size="xs"
                        disabled={busy}
                        onClick={() => {
                          const { draftId } = lastDiscard;
                          setLastDiscard(null);
                          void reopenDraft(draftId)
                            .then(() => setSelected(receivedRecoveryKey(draftId)))
                            .catch((error: unknown) =>
                              toastFailure(RESOLVE_FAILURE_TITLE.reopen, error),
                            );
                        }}
                      >
                        Undo
                      </NodexButton>
                    </>
                  ) : null}
                </div>
                {menuActions.length > 0 ? (
                  <RecoveryMoreMenu actions={menuActions} disabled={busy} />
                ) : null}
                {primaryAction ? (
                  <NodexButton size="sm" disabled={busy} onClick={primaryAction.run}>
                    {primaryAction.label}
                  </NodexButton>
                ) : null}
              </>
            )}
          </footer>
        </div>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function RecoveryComparisonBody({
  comparison,
  failed,
  context,
}: {
  readonly comparison: RecoveryComparison;
  readonly failed: boolean;
  readonly context: RecoveryPreviewContext;
}): ReactNode {
  if (failed) return null;
  switch (comparison.kind) {
    case "loading":
      return (
        <div aria-hidden="true" className="flex flex-col gap-2 px-3 py-1">
          <LoadingPlaceholder className="h-3.5 w-3/4 rounded" />
          <LoadingPlaceholder className="h-3.5 w-full rounded" />
          <LoadingPlaceholder className="h-3.5 w-2/3 rounded" />
        </div>
      );
    case "diff":
      return comparison.diff.rows.length > 0 || comparison.diff.title ? (
        <RecoveryDiff
          diff={comparison.diff}
          merged={comparison.merged}
          files={{ ...comparison.before.files, ...comparison.after.files }}
          context={context}
        />
      ) : null;
    case "document":
      return (
        <div className="px-3">
          <RecoveryDocumentPreview
            content={comparison.after.markdown}
            files={comparison.after.files}
            context={context}
          />
        </div>
      );
    case "canvas":
      return <RecoveryCanvasComparison comparison={comparison} context={context} />;
    case "unavailable":
      return null;
  }
}

/** A scene has no readable difference, so Canvas keeps a direct before and after. */
function RecoveryCanvasComparison({
  comparison,
  context,
}: {
  readonly comparison: Extract<RecoveryComparison, { kind: "canvas" }>;
  readonly context: RecoveryPreviewContext;
}) {
  const [showing, setShowing] = useState<"before" | "after">("after");
  const value = showing === "before" && comparison.before ? comparison.before : comparison.after;
  return (
    <div className="flex h-full min-h-72 flex-col gap-2 px-3">
      {comparison.before ? (
        <div role="group" aria-label="Canvas version" className="flex gap-1">
          {(
            [
              ["after", "These edits"],
              ["before", "Current Canvas"],
            ] as const
          ).map(([version, label]) => (
            <NodexButton
              key={version}
              variant="ghost"
              size="xs"
              aria-pressed={showing === version}
              className={cn(showing === version && "bg-token-foreground/10")}
              onClick={() => setShowing(version)}
            >
              {label}
            </NodexButton>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <RecoveryCanvasPreview value={value} context={context} />
      </div>
    </div>
  );
}

function RecoveryMoreMenu({
  actions,
  disabled,
}: {
  readonly actions: readonly RecoveryAction[];
  readonly disabled: boolean;
}) {
  return (
    <NodexDropdownMenu
      align="end"
      side="top"
      motion="none"
      disabled={disabled}
      triggerTooltipContent="More actions"
      triggerButton={
        <NodexButton variant="ghostSecondary" size="icon-sm" aria-label="More actions">
          <MoreActionsIcon className="icon-sm" />
        </NodexButton>
      }
    >
      {actions.map((action) => (
        <NodexDropdownItem key={action.label} onSelect={action.run}>
          {action.label}
        </NodexDropdownItem>
      ))}
    </NodexDropdownMenu>
  );
}

function RecoveryEntryRail({
  pending,
  resolved,
  selectedKey,
  sending,
  disabled,
  canLoadMore,
  onLoadMore,
  onSelect,
}: {
  readonly pending: readonly RecoveryReviewEntry[];
  readonly resolved: readonly RecoveryReviewEntry[];
  readonly selectedKey: string | null;
  readonly sending: readonly string[];
  readonly disabled: boolean;
  readonly canLoadMore: boolean;
  readonly onLoadMore: () => void;
  readonly onSelect: (entry: RecoveryReviewEntry) => void;
}) {
  const ordered = [...pending, ...resolved];
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = ordered.findIndex((candidate) => candidate.key === selectedKey);
    const next = ordered[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) onSelect(next);
  };
  const row = (entry: RecoveryReviewEntry) => {
    const meta = recoveryEntryMeta(entry, sending);
    return (
      <li key={entry.key}>
        <button
          type="button"
          disabled={disabled}
          aria-current={entry.key === selectedKey || undefined}
          onClick={() => onSelect(entry)}
          className={cn(
            "flex w-full min-w-0 flex-col rounded-lg px-2.5 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border",
            entry.key === selectedKey ? "bg-token-foreground/10" : "hover:bg-token-foreground/5",
            !recoveryEntryIsPending(entry) && "opacity-70",
          )}
        >
          <span className="truncate text-sm text-token-text-primary">
            {recoveryEntryTitle(entry)}
          </span>
          <span
            className={cn(
              "truncate text-xs",
              meta.attention ? "text-danger" : "text-token-description-foreground",
            )}
          >
            {meta.label}
          </span>
        </button>
      </li>
    );
  };
  return (
    <nav
      aria-label="Unsaved edits"
      onKeyDown={onKeyDown}
      className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-r-[0.5px] border-token-border p-2"
    >
      {pending.length > 0 ? <ul className="flex flex-col gap-0.5">{pending.map(row)}</ul> : null}
      {resolved.length > 0 ? (
        <div>
          <h3 className="px-2.5 pb-1 text-xs text-token-description-foreground">Resolved</h3>
          <ul className="flex flex-col gap-0.5">{resolved.map(row)}</ul>
        </div>
      ) : null}
      {canLoadMore ? (
        <NodexButton variant="ghostSecondary" size="xs" className="self-start" onClick={onLoadMore}>
          Load more
        </NodexButton>
      ) : null}
    </nav>
  );
}
