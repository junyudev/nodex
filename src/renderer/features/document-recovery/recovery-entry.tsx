import { lazy, useEffect, useSyncExternalStore } from "react";
import type { DocumentRecoveryScope } from "../../../shared/block-documents/document-recovery";
import { getDocumentRecovery } from "@/lib/document-recovery";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";

const RecoveryReview = lazy(() =>
  import("./recovery-review").then((module) => ({ default: module.RecoveryReview })),
);
export function useDocumentRecovery(scope: DocumentRecoveryScope, documentId: string | null) {
  const module = getDocumentRecovery(scope, documentId);
  const state = useSyncExternalStore(module.subscribe, module.getSnapshot);
  const appHandle = useScopeHandle(appScope);
  useEffect(() => module.connect(), [module]);
  return {
    module,
    state,
    review: (exportLocal?: () => Promise<void>) =>
      openModal(appHandle, RecoveryReview, { module, exportLocal }),
  };
}

export function RecoveryEntry({
  scope,
  documentId = null,
  alwaysVisible = false,
  refreshKey,
  exportLocal,
}: {
  scope: DocumentRecoveryScope;
  documentId?: string | null;
  alwaysVisible?: boolean;
  refreshKey?: string;
  exportLocal?: () => Promise<void>;
}) {
  const recovery = useDocumentRecovery(scope, documentId);
  useEffect(() => {
    if (refreshKey) void recovery.module.refresh();
  }, [recovery.module, refreshKey]);
  const pending = recovery.state.pendingCount;
  if (!alwaysVisible && pending === 0 && !recovery.state.error) return null;
  return (
    <button
      type="button"
      className="no-drag inline-flex items-center gap-1.5 text-xs text-token-text-secondary hover:text-token-text-primary"
      onClick={() => recovery.review(exportLocal)}
    >
      {pending > 0
        ? `Unsaved edits${pending > 1 ? ` (${pending})` : ""}`
        : recovery.state.error
          ? "Couldn’t load drafts"
          : "Unsaved edits"}
      <span aria-hidden="true">·</span>
      <span className="font-medium">Review</span>
    </button>
  );
}
