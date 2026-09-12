import {
  recoveryReviewEntries,
  receivedRecoveryKey,
  stagedRecoveryKey,
} from "@/lib/document-recovery-entries";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  RecoveryChoice,
  RecoveryDraftInspection,
  RecoveryPreviewResult,
} from "../../../shared/block-documents/document-recovery";
import type { DocumentRecovery } from "@/lib/document-recovery";
import type { ModalCloseProps } from "@/lib/modal-registry";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
  NodexDialogDescription,
  NodexDialogBody,
  NodexDialogFooter,
  NodexDialogAction,
} from "@/components/ui/dialog";
import { RecoveryPreview } from "./recovery-preview";
import { contentAccessIdentityKey } from "../../../shared/content-access-context";

type RecoveryReviewProps = ModalCloseProps & {
  module: DocumentRecovery;
  exportLocal?: () => Promise<void>;
  initialDraftId?: string;
  initialSourceKey?: string;
};

export function RecoveryReview(props: RecoveryReviewProps) {
  return (
    <RecoveryReviewContent
      key={`${contentAccessIdentityKey(props.module.scope)}\0${props.module.documentId ?? "library"}\0${props.initialSourceKey ?? props.initialDraftId ?? "list"}`}
      {...props}
    />
  );
}

function RecoveryReviewContent({
  module,
  onClose,
  exportLocal,
  initialDraftId,
  initialSourceKey,
}: RecoveryReviewProps) {
  const state = useSyncExternalStore(module.subscribe, module.getSnapshot);
  const [selected, setSelected] = useState<string | null>(
    initialSourceKey
      ? stagedRecoveryKey(initialSourceKey)
      : initialDraftId
        ? receivedRecoveryKey(initialDraftId)
        : null,
  );
  const [inspection, setInspection] = useState<RecoveryDraftInspection | null>(null);
  const [view, setView] = useState<"retained" | "restored" | "current">("restored");
  const [preview, setPreview] = useState<RecoveryPreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const request = useRef(0);
  useEffect(() => module.connect(), [module]);
  useEffect(() => {
    void module.setIncludeResolved(showResolved);
  }, [module, showResolved]);
  const entries = recoveryReviewEntries(state).filter(
    (entry) => entry.kind === "staged" || showResolved || !entry.draft.resolution,
  );
  const redirected = Object.entries(state.acceptedLocal).find(
    ([key]) => stagedRecoveryKey(key) === selected,
  )?.[1];
  const selectedEntry =
    entries.find((entry) => entry.key === selected) ??
    entries.find((entry) => entry.key === receivedRecoveryKey(redirected ?? "")) ??
    entries[0] ??
    null;
  const local = selectedEntry?.kind === "staged" ? selectedEntry.source : null;
  const draftId = selectedEntry?.kind === "received" ? selectedEntry.draft.draft_id : null;
  const revision = selectedEntry?.kind === "received" ? selectedEntry.draft.revision : undefined;
  useEffect(() => {
    const version = ++request.current;
    setInspection((previous) => (previous?.summary.draft_id === draftId ? previous : null));
    if (!draftId) return;
    void module
      .inspect(draftId)
      .then((value) => {
        if (request.current !== version) return;
        setInspection(value);
        setError(null);
        setConfirmDiscard(false);
        setView((previous) =>
          previous === "current" && value.current
            ? "current"
            : value.can_restore && value.restored
              ? "restored"
              : "retained",
        );
      })
      .catch((error: unknown) => {
        if (request.current === version)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      request.current += 1;
    };
  }, [module, draftId, revision, state.previewRevision]);
  const current = inspection?.summary.draft_id === draftId ? inspection : null;
  useEffect(() => {
    let active = true;
    setPreview(null);
    if (!current) return;
    void module
      .preview(current, view)
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((error: unknown) => {
        if (active)
          setPreview({
            kind: "unavailable",
            explanation: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      active = false;
    };
  }, [module, current, view, state.previewRevision]);
  const run = async (choice: RecoveryChoice) => {
    if (!current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await module.resolve(current, choice);
      setInspection({ ...current, summary: result, can_restore: false, can_copy: false });
      setConfirmDiscard(false);
      setShowResolved(true);
      setSelected(receivedRecoveryKey(result.draft_id));
      await module.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const exportDraft = async () => {
    try {
      if (local) await module.exportLocal(local.sourceKey);
      else if (draftId) await module.export(draftId);
      else await exportLocal?.();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const resolution = current?.summary.resolution;
  const resolvedMessage =
    resolution === "discarded"
      ? "Draft discarded. Your current document is unchanged."
      : resolution === "copied"
        ? "Saved as a separate copy in your Library."
        : resolution === "restored"
          ? "Edits restored and saved."
          : resolution === "already_saved"
            ? "These edits were already saved. No action is needed."
            : null;
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="large" className="flex max-h-[85vh] flex-col" showCloseButton>
        <NodexDialogFrame className="min-h-0">
          <NodexDialogHeader className="pr-6">
            <NodexDialogTitle>Unsaved edits</NodexDialogTitle>
            <NodexDialogDescription>
              Review retained edits, then choose how to keep them.
            </NodexDialogDescription>
          </NodexDialogHeader>
          <div className="flex items-center gap-3 border-b border-token-border py-2 text-xs">
            <select
              aria-label="Retained draft"
              className="min-w-0 flex-1 bg-transparent text-token-text-secondary"
              value={selectedEntry?.key ?? ""}
              onChange={(event) => setSelected(event.target.value)}
              disabled={busy}
            >
              {entries.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.kind === "staged"
                    ? `${entry.source.sourceKind === "canvas" ? "Canvas edits" : "Document edits"} · ${state.sending.includes(entry.source.sourceKey) ? "Sending" : entry.source.failure ? "Needs attention" : "On this device"}${entry.source.createdAt ? ` · ${new Date(entry.source.createdAt).toLocaleString()}` : ""}`
                    : `${entry.draft.source_title || "Retained document"} · ${new Date(entry.draft.created_at).toLocaleString()}${entry.draft.resolution ? " · Handled" : " · Received"}`}
                </option>
              ))}
            </select>
            <label className="flex shrink-0 items-center gap-1.5 text-token-description-foreground">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(event) => setShowResolved(event.target.checked)}
              />
              Recently handled
            </label>
            {state.hasMore || state.localHasMore ? (
              <button type="button" onClick={() => void module.loadMore()}>
                More
              </button>
            ) : null}
          </div>
          <NodexDialogBody className="min-h-64 overflow-y-auto">
            {error || state.error || state.localError ? (
              <div
                role="alert"
                className="mb-4 flex items-center gap-3 text-sm text-token-text-secondary"
              >
                <span>{error ?? state.localError ?? state.error}</span>
                <button
                  type="button"
                  className="shrink-0 underline"
                  onClick={() => {
                    void module.refresh();
                  }}
                >
                  Refresh
                </button>
              </div>
            ) : null}
            {resolvedMessage ? (
              <p role="status" className="mb-4 text-sm text-token-text-secondary">
                {resolvedMessage}
              </p>
            ) : null}
            {current?.explanation && !resolution ? (
              <p className="mb-4 text-sm text-token-description-foreground">
                {current.explanation}
              </p>
            ) : null}
            {local ? (
              <div className="space-y-3 text-sm text-token-text-secondary">
                <p role="status">
                  {state.sending.includes(local.sourceKey)
                    ? "Sending retained edits"
                    : local.failure
                      ? "Needs attention · Retained on this device"
                      : "Retained on this device"}
                </p>
                <p>
                  {local.failure?.message ??
                    "These edits are preserved locally and are waiting for Core to confirm receipt."}
                </p>
                <p className="text-xs text-token-description-foreground">
                  You can export this package even while Core is unavailable. Later keeps the
                  original local copy.
                </p>
                <details className="text-xs text-token-description-foreground">
                  <summary>Details</summary>
                  <p className="mt-2 break-all">{local.draftId ?? local.sourceKey}</p>
                  {local.byteLength !== null ? (
                    <p>{local.byteLength.toLocaleString()} bytes retained</p>
                  ) : null}
                  {local.failure?.actual != null && local.failure.limit != null ? (
                    <p>
                      Observed: {local.failure.actual.toLocaleString()} · Limit:{" "}
                      {local.failure.limit.toLocaleString()}
                    </p>
                  ) : null}
                  {!local.scope ? <p>The source Library has not yet been verified.</p> : null}
                </details>
              </div>
            ) : current ? (
              <>
                <div className="mb-5 flex gap-1" role="group" aria-label="Preview version">
                  {(
                    [
                      ["current", "Current content"],
                      [
                        current.can_restore ? "restored" : "retained",
                        current.can_restore ? "After restoring" : "Retained draft",
                      ],
                    ] as const
                  ).map(([key, label]) => (
                    <NodexDialogAction
                      key={key}
                      size="compact"
                      aria-pressed={view === key}
                      tone={view === key ? "primary" : "ghost"}
                      onClick={() => setView(key)}
                    >
                      {label}
                    </NodexDialogAction>
                  ))}
                </div>
                {preview && preview.kind !== "complete" ? (
                  <p role="status" className="mb-3 text-sm text-token-description-foreground">
                    {preview.explanation}
                  </p>
                ) : null}
                <RecoveryPreview
                  value={preview?.kind === "complete" ? preview.preview : null}
                  scope={module.scope}
                  storeEpoch={state.storeEpoch}
                  documentId={current.summary.document_id}
                  draftId={current.summary.draft_id}
                />
                <details className="mt-6 text-xs text-token-description-foreground">
                  <summary className="cursor-pointer">Details</summary>
                  <p className="mt-2 break-all">
                    Draft {current.summary.draft_id} ·{" "}
                    {current.summary.byte_length.toLocaleString()} bytes retained
                  </p>
                  <p>
                    Handled drafts remain available for 30 days. Exporting keeps this draft
                    available for review.
                  </p>
                </details>
              </>
            ) : (
              <p className="text-sm text-token-description-foreground">
                {state.loading || draftId
                  ? "Loading retained edits…"
                  : "No unsaved drafts need attention."}
              </p>
            )}
          </NodexDialogBody>
          <NodexDialogFooter className="flex-wrap">
            <NodexDialogAction
              size="compact"
              onClick={() => void exportDraft()}
              disabled={busy || (!local && !draftId && !exportLocal)}
            >
              Export
            </NodexDialogAction>
            {local ? (
              <NodexDialogAction
                size="compact"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void module
                    .retry(local.sourceKey)
                    .catch((error: unknown) =>
                      setError(error instanceof Error ? error.message : String(error)),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Retry receipt
              </NodexDialogAction>
            ) : null}
            {!resolution && current ? (
              <NodexDialogAction
                size="compact"
                tone="danger"
                disabled={busy}
                onClick={() => setConfirmDiscard(true)}
              >
                Discard draft
              </NodexDialogAction>
            ) : null}
            {resolution === "discarded" ? (
              <NodexDialogAction size="compact" disabled={busy} onClick={() => void run("reopen")}>
                Undo discard
              </NodexDialogAction>
            ) : null}
            <div className="flex-1" />
            {confirmDiscard ? (
              <>
                <span className="text-xs text-token-text-secondary">Discard only this draft?</span>
                <NodexDialogAction size="compact" onClick={() => setConfirmDiscard(false)}>
                  Keep
                </NodexDialogAction>
                <NodexDialogAction
                  size="compact"
                  tone="danger"
                  disabled={busy}
                  onClick={() => void run("discard")}
                >
                  Discard
                </NodexDialogAction>
              </>
            ) : (
              <>
                <NodexDialogAction size="compact" onClick={onClose}>
                  {resolution ? "Done" : "Later"}
                </NodexDialogAction>
                {current?.can_restore ? (
                  <NodexDialogAction
                    size="compact"
                    tone="primary"
                    disabled={busy}
                    onClick={() => void run("restore")}
                  >
                    {busy ? "Restoring…" : "Restore edits"}
                  </NodexDialogAction>
                ) : current?.can_copy ? (
                  <NodexDialogAction
                    size="compact"
                    tone="primary"
                    disabled={busy}
                    onClick={() => void run("copy")}
                  >
                    {busy ? "Saving…" : "Save as a copy"}
                  </NodexDialogAction>
                ) : null}
              </>
            )}
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}
