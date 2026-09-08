import { contentAccessIdentityKey } from "../../shared/content-access-context";
import { PAGE_DOCUMENT_TITLE_KEY } from "../../shared/block-documents/page-document";
import type { BlockDocumentSurfaceRuntime } from "./block-document-surface-runtime";
import { resolveBlockDocumentSyncIndicator } from "./block-document-sync-indicator";
import {
  contentEditIssues,
  contentRecoveryIssueId,
  type ContentEditIssue,
  type ContentEditIssueAction,
} from "./content-edit-issues";

/** The retained Document supplies save evidence and actions, including while its tab is hidden. */
export function observeDocumentContentIssues(runtime: BlockDocumentSurfaceRuntime): () => void {
  const { descriptor } = runtime;
  let provider = runtime.getStatus().provider;
  let phaseStartedAt = Date.now();
  let pendingStartedAt = provider.pendingUpdateCount > 0 ? phaseStartedAt : null;
  let hasEverSynced = provider.phase === "synced";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let issues: readonly ContentEditIssue[] = [];
  let signature = "";
  const listeners = new Set<() => void>();
  const source = {
    getIssues: () => issues,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const update = () => {
    clearTimeout(timer);
    timer = undefined;
    const current = runtime.getStatus();
    const next = current.provider;
    const now = Date.now();
    if (next.phase !== provider.phase) phaseStartedAt = now;
    if (next.phase === "synced") hasEverSynced = true;
    if (next.pendingUpdateCount === 0) pendingStartedAt = null;
    else pendingStartedAt ??= now;
    provider = next;
    const model =
      current.phase === "closed" || current.phase === "closing"
        ? null
        : resolveBlockDocumentSyncIndicator({
            // Durable drafts have their own exact identities and recovery owner.
            status: { ...next, recoveredDraftCount: 0 },
            phaseAgeMs: now - phaseStartedAt,
            pendingAgeMs: pendingStartedAt === null ? 0 : now - pendingStartedAt,
            hasEverSynced,
          });
    const actionable =
      model &&
      model.tone !== "neutral" &&
      (model.editingBlocked || (next.pendingUpdateCount > 0 && model.action !== null));
    const title =
      runtime.document.share.get(PAGE_DOCUMENT_TITLE_KEY)?.toString().trim() || "Untitled Page";
    const nextSignature = actionable ? JSON.stringify([model, next.recovery, title]) : "";
    if (signature !== nextSignature) {
      signature = nextSignature;
      const actions: ContentEditIssueAction[] = [];
      if (actionable && model.action?.kind === "review")
        actions.push({
          kind: "review",
          label: "Review edits",
          scope: descriptor,
          documentId: descriptor.documentId,
          exportLocal: runtime.exportRecovery,
        });
      if (actionable && (model.action?.kind === "reload" || next.recovery?.phase === "protected"))
        actions.push({
          kind: "run",
          label: next.recovery?.phase === "protected" ? "Continue editing" : "Reload Page",
          run: runtime.reload,
        });
      if (actionable && model.action?.kind === "retry")
        actions.push({ kind: "run", label: "Retry save", run: runtime.connect });
      issues = actionable
        ? [
            {
              kind: "save",
              id: next.recovery
                ? contentRecoveryIssueId(
                    descriptor,
                    descriptor.storeEpoch,
                    next.recovery.recoveryId,
                  )
                : `${contentAccessIdentityKey(descriptor)}\0${descriptor.storeEpoch}\0document:${descriptor.documentId}:${descriptor.generation}`,
              scope: descriptor,
              location: { target: { kind: "page", pageId: descriptor.ownerBlockId }, label: title },
              title: model.label,
              detail: model.detail ?? "Open this Page to review its unsaved edits.",
              actions,
            },
          ]
        : [];
      listeners.forEach((listener) => listener());
    }
    if (
      current.phase !== "closed" &&
      current.phase !== "closing" &&
      next.pendingUpdateCount > 0 &&
      !actionable
    )
      timer = setTimeout(update, 1000);
  };
  const unsubscribe = runtime.subscribe(update);
  const unregister = contentEditIssues.register(source);
  update();
  return () => {
    clearTimeout(timer);
    unsubscribe();
    unregister();
  };
}
