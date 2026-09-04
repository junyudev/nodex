import { useDocumentRecovery } from "@/features/document-recovery/recovery-entry";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  resolveBlockDocumentSyncIndicator,
  type BlockDocumentSyncIndicatorModel,
} from "@/lib/block-document-sync-indicator";
import type { BlockDocumentSurfaceRuntime } from "@/lib/block-document-surface-runtime";
import type { NodexYProviderStatus } from "@/lib/nodex-y-provider";

interface SyncTimingState {
  phase: NodexYProviderStatus["phase"];
  phaseStartedAt: number;
  pendingStartedAt: number | null;
  hasEverSynced: boolean;
}

export interface BlockDocumentSyncStatusProps {
  readonly runtime: BlockDocumentSurfaceRuntime;
  readonly status: NodexYProviderStatus;
}

const readNow = (): number => Date.now();

const toneClassName = (model: BlockDocumentSyncIndicatorModel): string => {
  if (model.tone === "danger") return "text-(--destructive)";
  if (model.tone === "warning") return "text-(--orange-text)";
  return "text-(--foreground-tertiary)";
};

/** Sparse status chrome: the normal durable ACK path renders nothing. */
export function BlockDocumentSyncStatus({ runtime, status }: BlockDocumentSyncStatusProps) {
  const surface = useSyncExternalStore(runtime.subscribe, runtime.getStatus);
  const recovery = useDocumentRecovery(
    { libraryId: surface.descriptor.libraryId, accessContext: surface.descriptor.accessContext },
    surface.descriptor.documentId,
  );
  useEffect(() => {
    void recovery.module.refresh();
  }, [recovery.module, status.recoveredDraftCount, status.recovery?.recoveryId]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [, setClock] = useState(0);
  const timingRef = useRef<SyncTimingState>({
    phase: status.phase,
    phaseStartedAt: readNow(),
    pendingStartedAt: status.pendingUpdateCount > 0 ? readNow() : null,
    hasEverSynced: status.phase === "synced",
  });
  const timing = timingRef.current;
  const now = readNow();

  if (timing.phase !== status.phase) {
    timing.phase = status.phase;
    timing.phaseStartedAt = now;
  }
  if (status.phase === "synced") timing.hasEverSynced = true;
  if (status.pendingUpdateCount > 0 && timing.pendingStartedAt === null) {
    timing.pendingStartedAt = now;
  }
  if (status.pendingUpdateCount === 0) timing.pendingStartedAt = null;

  useEffect(() => {
    if (
      (status.phase === "synced" && surface.structuralWaitStartedAt === null) ||
      status.phase === "destroyed"
    )
      return;
    const interval = globalThis.setInterval(() => {
      setClock((current) => current + 1);
    }, 250);
    return () => globalThis.clearInterval(interval);
  }, [status.phase, surface.structuralWaitStartedAt]);

  const model = resolveBlockDocumentSyncIndicator({
    status: {
      ...status,
      recoveredDraftCount:
        recovery.state.pendingCount || (recovery.state.error ? status.recoveredDraftCount : 0),
    },
    phaseAgeMs: Math.max(0, now - timing.phaseStartedAt),
    pendingAgeMs: timing.pendingStartedAt === null ? 0 : Math.max(0, now - timing.pendingStartedAt),
    hasEverSynced: timing.hasEverSynced,
    structuralWaitAgeMs:
      surface.structuralWaitStartedAt === null
        ? undefined
        : Math.max(0, now - surface.structuralWaitStartedAt),
  });
  if (!model) return null;

  const reportFailure = (error: unknown): void =>
    setActionError(error instanceof Error ? error.message : String(error));
  const retry = (): void => {
    setActionError(null);
    if (model.action?.kind === "review") {
      recovery.review(() => runtime.exportRecovery());
      return;
    }
    if (model.action?.kind === "cancel") {
      runtime.cancelStructuralWaits();
      return;
    }
    if (model.action?.kind === "reload") {
      void runtime.reload().catch(reportFailure);
      return;
    }
    void runtime.connect().catch(reportFailure);
  };

  return (
    <div
      role="status"
      aria-live={model.announce}
      className={cn("flex min-h-5 items-center justify-end gap-2 text-xs", toneClassName(model))}
      data-block-document-sync-phase={model.phase}
    >
      <NodexTooltip tooltipContent={actionError ?? model.detail ?? undefined} side="top">
        <span>{model.label}</span>
      </NodexTooltip>
      {status.recovery?.phase === "protected" && model.action?.kind === "review" ? (
        <button
          type="button"
          className="font-medium text-(--foreground-secondary) hover:text-(--foreground)"
          onClick={() => {
            void runtime.reload().catch(reportFailure);
          }}
        >
          Continue editing
        </button>
      ) : null}
      {model.action ? (
        <button
          type="button"
          className="font-medium text-(--foreground-secondary) hover:text-(--foreground)"
          onClick={retry}
        >
          {model.action.label}
        </button>
      ) : null}
    </div>
  );
}
