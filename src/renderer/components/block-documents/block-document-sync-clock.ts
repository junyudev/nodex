import type { NodexYProviderStatus } from "@/lib/nodex-y-provider";

interface SyncClockSnapshot {
  readonly phase: NodexYProviderStatus["phase"];
  readonly phaseStartedAt: number;
  readonly pendingStartedAt: number | null;
  readonly hasEverSynced: boolean;
  readonly now: number;
}

/** Owns wall-clock observations and sparse ticking outside React rendering. */
export function createBlockDocumentSyncClock(
  phase: NodexYProviderStatus["phase"],
  pending: boolean,
  structuralWaitStartedAt: number | null,
) {
  const now = Date.now();
  let snapshot: SyncClockSnapshot = {
    phase,
    phaseStartedAt: now,
    pendingStartedAt: pending ? now : null,
    hasEverSynced: phase === "synced",
    now,
  };
  let structuralWait = structuralWaitStartedAt;
  let interval: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: SyncClockSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const reconcileTimer = () => {
    const ticking =
      listeners.size > 0 &&
      snapshot.phase !== "destroyed" &&
      (snapshot.phase !== "synced" || structuralWait !== null);
    if (!ticking && interval !== null) {
      clearInterval(interval);
      interval = null;
    }
    if (!ticking || interval !== null) return;
    interval = setInterval(() => publish({ ...snapshot, now: Date.now() }), 250);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      reconcileTimer();
      return () => {
        listeners.delete(listener);
        reconcileTimer();
      };
    },
    observe: (
      nextPhase: NodexYProviderStatus["phase"],
      nextPending: boolean,
      nextStructuralWait: number | null,
    ) => {
      const now = Date.now();
      structuralWait = nextStructuralWait;
      publish({
        phase: nextPhase,
        phaseStartedAt: snapshot.phase === nextPhase ? snapshot.phaseStartedAt : now,
        pendingStartedAt: nextPending ? (snapshot.pendingStartedAt ?? now) : null,
        hasEverSynced: snapshot.hasEverSynced || nextPhase === "synced",
        now,
      });
      reconcileTimer();
    },
  };
}
