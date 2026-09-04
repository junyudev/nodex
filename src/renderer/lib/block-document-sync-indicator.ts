import type { NodexYProviderPhase, NodexYProviderStatus } from "./nodex-y-provider";

export interface BlockDocumentSyncIndicatorThresholds {
  /** Suppresses the normal durable-ACK round trip. */
  readonly savingDelayMs: number;
  /** Escalates a pending durable write to an actionable state. */
  readonly longPendingMs: number;
  /** Prevents a momentary transport reconnect from flashing offline chrome. */
  readonly offlineDelayMs: number;
  /** Prevents a quick post-connect state-vector handshake from flashing. */
  readonly reconnectDelayMs: number;
}

export const DEFAULT_BLOCK_DOCUMENT_SYNC_INDICATOR_THRESHOLDS = {
  savingDelayMs: 700,
  longPendingMs: 8_000,
  offlineDelayMs: 1_000,
  reconnectDelayMs: 1_500,
} as const satisfies BlockDocumentSyncIndicatorThresholds;

export type BlockDocumentSyncIndicatorTone = "neutral" | "warning" | "danger";

export type BlockDocumentSyncIndicatorAction =
  | { readonly kind: "review"; readonly label: "Review" | "Review edits" }
  | { readonly kind: "cancel"; readonly label: "Cancel" }
  | { readonly kind: "retry"; readonly label: "Retry" }
  | { readonly kind: "reload"; readonly label: "Reload Page" };

export interface BlockDocumentSyncIndicatorModel {
  readonly phase: NodexYProviderPhase;
  readonly label: string;
  readonly detail: string | null;
  readonly tone: BlockDocumentSyncIndicatorTone;
  readonly action: BlockDocumentSyncIndicatorAction | null;
  /** Fatal/reset providers ignore subsequent Y.Doc updates, so the UI must freeze. */
  readonly editingBlocked: boolean;
  readonly pendingUpdateCount: number;
  readonly announce: "polite" | "assertive";
}

export interface ResolveBlockDocumentSyncIndicatorInput {
  readonly structuralWaitAgeMs?: number;
  readonly status: NodexYProviderStatus;
  /** Time since the current provider phase began. */
  readonly phaseAgeMs: number;
  /** Time since the first still-unacknowledged local update, if any. */
  readonly pendingAgeMs?: number;
  /** Initial connection is represented by the surface loader, not toolbar chrome. */
  readonly hasEverSynced: boolean;
  readonly thresholds?: Partial<BlockDocumentSyncIndicatorThresholds>;
}

export class BlockDocumentSyncIndicatorError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "BlockDocumentSyncIndicatorError";
  }
}

const readDuration = (value: number, field: string): number => {
  if (Number.isFinite(value) && value >= 0) return value;
  throw new BlockDocumentSyncIndicatorError(`${field} must be non-negative`);
};

const readThresholds = (
  input: Partial<BlockDocumentSyncIndicatorThresholds> | undefined,
): BlockDocumentSyncIndicatorThresholds => {
  const thresholds = {
    ...DEFAULT_BLOCK_DOCUMENT_SYNC_INDICATOR_THRESHOLDS,
    ...input,
  };
  const savingDelayMs = readDuration(thresholds.savingDelayMs, "savingDelayMs");
  const longPendingMs = readDuration(thresholds.longPendingMs, "longPendingMs");
  if (longPendingMs < savingDelayMs) {
    throw new BlockDocumentSyncIndicatorError(
      "longPendingMs must not be shorter than savingDelayMs",
    );
  }
  return {
    savingDelayMs,
    longPendingMs,
    offlineDelayMs: readDuration(thresholds.offlineDelayMs, "offlineDelayMs"),
    reconnectDelayMs: readDuration(thresholds.reconnectDelayMs, "reconnectDelayMs"),
  };
};

const retryAction = {
  kind: "retry",
  label: "Retry",
} as const satisfies BlockDocumentSyncIndicatorAction;

const reloadAction = {
  kind: "reload",
  label: "Reload Page",
} as const satisfies BlockDocumentSyncIndicatorAction;

const recoveryAction = (status: NodexYProviderStatus): BlockDocumentSyncIndicatorAction | null => {
  if (status.error?.code === "unauthorized") return null;
  if (status.recovery) return { kind: "review", label: "Review" };
  return reloadAction;
};
const recoveryDetail = (status: NodexYProviderStatus): string =>
  status.recovery?.phase === "protected"
    ? "These edits are kept on this device. Review them or reopen the saved document to continue editing."
    : "Unsaved edits are only in this window. Export recovery before closing it.";

const resetIndicator = (status: NodexYProviderStatus): BlockDocumentSyncIndicatorModel => ({
  phase: status.phase,
  label: "Reload required",
  detail: status.recovery
    ? recoveryDetail(status)
    : "The local store or this Page document changed. Reload before continuing to edit.",
  tone: "danger",
  action: recoveryAction(status),
  editingBlocked: true,
  pendingUpdateCount: status.pendingUpdateCount,
  announce: "assertive",
});

const fatalIndicator = (status: NodexYProviderStatus): BlockDocumentSyncIndicatorModel => ({
  phase: status.phase,
  label: "Couldn’t save changes",
  detail: status.recovery
    ? `${status.error?.message ?? "Couldn’t save changes."} ${recoveryDetail(status)}`
    : (status.error?.message ?? "This Page document can no longer be saved."),
  tone: "danger",
  action: status.error?.retryable ? retryAction : recoveryAction(status),
  editingBlocked: !status.error?.retryable,
  pendingUpdateCount: status.pendingUpdateCount,
  announce: "assertive",
});

const offlineIndicator = (status: NodexYProviderStatus): BlockDocumentSyncIndicatorModel => ({
  phase: status.phase,
  label: "Offline",
  detail:
    status.pendingUpdateCount > 0
      ? status.checkpoint.localVersion !== undefined &&
        status.checkpoint.protectedVersion !== undefined &&
        status.checkpoint.protectedVersion >= status.checkpoint.localVersion &&
        status.checkpoint.phase === "ready"
        ? "Changes are kept on this device. Sync will resume after reconnecting."
        : "Latest changes are only in this window. Keep it open while local recovery is being saved."
      : "Reconnect to continue syncing this Page.",
  tone: "warning",
  action: retryAction,
  editingBlocked: false,
  pendingUpdateCount: status.pendingUpdateCount,
  announce: "polite",
});

/**
 * Maps provider state into sparse Page Stage chrome. The normal path returns
 * null so fast durable acknowledgements never flash “Saving…”. A surrounding
 * hook owns phase/pending timestamps; this helper owns only product policy.
 */
export const resolveBlockDocumentSyncIndicator = ({
  status,
  phaseAgeMs,
  pendingAgeMs = phaseAgeMs,
  hasEverSynced,
  structuralWaitAgeMs,
  thresholds: thresholdOverrides,
}: ResolveBlockDocumentSyncIndicatorInput): BlockDocumentSyncIndicatorModel | null => {
  const phaseAge = readDuration(phaseAgeMs, "phaseAgeMs");
  const pendingAge = readDuration(pendingAgeMs, "pendingAgeMs");
  const thresholds = readThresholds(thresholdOverrides);

  if (status.phase === "reset-required" || status.error?.resetRequired) {
    return resetIndicator(status);
  }
  if (status.phase === "error") {
    return fatalIndicator(status);
  }
  if (status.phase === "destroyed") return null;
  if (
    structuralWaitAgeMs !== undefined &&
    readDuration(structuralWaitAgeMs, "structuralWaitAgeMs") >= thresholds.savingDelayMs
  ) {
    return {
      phase: status.phase,
      label: "Waiting for save…",
      detail:
        "The structural edit will continue after changes are saved. You can cancel this operation.",
      tone: "neutral",
      action: { kind: "cancel", label: "Cancel" },
      editingBlocked: false,
      pendingUpdateCount: status.pendingUpdateCount,
      announce: "polite",
    };
  }
  if (status.phase === "synced") {
    if ((status.recoveredDraftCount ?? 0) > 0)
      return {
        phase: status.phase,
        label: "Unsaved edits",
        detail:
          "Some earlier edits were not saved. Review them while the current document continues syncing.",
        tone: "warning",
        action: { kind: "review", label: "Review" },
        editingBlocked: false,
        pendingUpdateCount: 0,
        announce: "polite",
      };
    return null;
  }

  if (status.phase === "saving") {
    if (pendingAge < thresholds.savingDelayMs) return null;
    if (pendingAge < thresholds.longPendingMs) {
      return {
        phase: status.phase,
        label: "Saving…",
        detail: null,
        tone: "neutral",
        action: null,
        editingBlocked: false,
        pendingUpdateCount: status.pendingUpdateCount,
        announce: "polite",
      };
    }
    return {
      phase: status.phase,
      label: "Still saving…",
      detail: status.error?.message ?? "The durable save is taking longer than expected.",
      tone: "warning",
      action: retryAction,
      editingBlocked: false,
      pendingUpdateCount: status.pendingUpdateCount,
      announce: "polite",
    };
  }

  if (status.phase === "offline") {
    if (phaseAge < thresholds.offlineDelayMs) return null;
    return offlineIndicator(status);
  }

  if (status.phase === "idle") {
    if (!hasEverSynced || status.pendingUpdateCount === 0) return null;
    if (phaseAge < thresholds.offlineDelayMs) return null;
    return offlineIndicator(status);
  }

  if (status.phase === "connecting") {
    if (!hasEverSynced || phaseAge < thresholds.reconnectDelayMs) return null;
    return {
      phase: status.phase,
      label: "Reconnecting…",
      detail: status.error?.message ?? null,
      tone: "warning",
      action: phaseAge >= thresholds.longPendingMs ? retryAction : null,
      editingBlocked: false,
      pendingUpdateCount: status.pendingUpdateCount,
      announce: "polite",
    };
  }

  return null;
};
