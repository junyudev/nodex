import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  RecoveryChoice,
  RecoveryDraftInspection,
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

export function RecoveryReview({
  module,
  onClose,
  exportLocal,
}: ModalCloseProps & { module: DocumentRecovery; exportLocal?: () => Promise<void> }) {
  const state = useSyncExternalStore(module.subscribe, module.getSnapshot);
  const [selected, setSelected] = useState<string | null>(null);
  const [inspection, setInspection] = useState<RecoveryDraftInspection | null>(null);
  const [view, setView] = useState<"retained" | "restored" | "current">("restored");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const request = useRef(0);
  useEffect(() => module.connect(), [module]);
  useEffect(() => {
    void module.setIncludeResolved(showResolved);
  }, [module, showResolved]);
  const drafts = state.drafts.filter((draft) => showResolved || !draft.resolution);
  const draftId = selected ?? drafts[0]?.draft_id ?? null;
  const revision = state.drafts.find((draft) => draft.draft_id === draftId)?.revision;
  useEffect(() => {
    const version = ++request.current;
    setInspection(null);
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
  const run = async (choice: RecoveryChoice) => {
    if (!current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await module.resolve(current, choice);
      setInspection({ ...current, summary: result, can_restore: false, can_copy: false });
      setConfirmDiscard(false);
      setShowResolved(true);
      setSelected(result.draft_id);
      await module.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const exportDraft = async () => {
    try {
      if (draftId) await module.export(draftId);
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
              value={draftId ?? ""}
              onChange={(event) => setSelected(event.target.value)}
              disabled={busy}
            >
              {drafts.map((draft) => (
                <option key={draft.draft_id} value={draft.draft_id}>
                  {draft.source_title || "Retained document"} ·{" "}
                  {new Date(draft.created_at).toLocaleString()}
                  {draft.resolution ? " · Handled" : ""}
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
            {state.hasMore ? (
              <button type="button" onClick={() => void module.loadMore()}>
                More
              </button>
            ) : null}
          </div>
          <NodexDialogBody className="min-h-64 overflow-y-auto">
            {error || state.error ? (
              <div
                role="alert"
                className="mb-4 flex items-center gap-3 text-sm text-token-text-secondary"
              >
                <span>{error ?? state.error}</span>
                <button
                  type="button"
                  className="shrink-0 underline"
                  onClick={() => {
                    void module.refresh();
                    if (draftId)
                      void module
                        .inspect(draftId)
                        .then((value) => {
                          setInspection(value);
                          setError(null);
                        })
                        .catch((error: unknown) => setError(String(error)));
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
            {current ? (
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
                <RecoveryPreview
                  value={current[view]}
                  scope={module.scope}
                  storeEpoch={state.storeEpoch}
                  documentId={current.capture.document_id}
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
              disabled={!draftId && !exportLocal}
            >
              Export
            </NodexDialogAction>
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
