import type { CodexConversationSnapshot } from "../../../shared/types";
import type { CodexConversationHistoryPageRequest } from "../../../shared/codex-conversation-history-page";
import { residentConversationTurns } from "../../../shared/codex-conversation-state/codex-turn-mutation";
import { createCodexHistoryBoundaryRef } from "../../../shared/codex-conversation-state/codex-history-topology";
import { CodexHistoryCursorStalled } from "../../../shared/codex-conversation-state/codex-history-cursor-stalled";

export type PendingArtifactRecoveryStatus =
  | "idle"
  | "loading"
  | "exhausted"
  | "unresolved"
  | "failed";
export type PendingArtifactRecoveryMode = "automatic" | "retry";

export interface PendingArtifactRecoveryRead {
  readonly missingReceiptIds: readonly string[];
  readonly olderPage: CodexConversationHistoryPageRequest | null;
}

/** Receipt identity is independent of the referenced item's own generation state. */
export function readPendingArtifactRecovery(
  conversation: Pick<
    CodexConversationSnapshot,
    "canonicalState" | "conversationEntityGeneration" | "historyMutationRevision"
  > | null,
): PendingArtifactRecoveryRead | null {
  const state = conversation?.canonicalState;
  if (!conversation || !state?.itemTimeline) return null;
  const promotions = state.itemTimeline.entries.flatMap((entry) =>
    entry.type === "realtime" && entry.item.type === "bemItemPromoted" ? [entry.item] : [],
  );
  if (promotions.length === 0) return { missingReceiptIds: [], olderPage: null };
  const residentItems = new Set(
    residentConversationTurns(state).flatMap((turn) =>
      turn.items.map((item) => JSON.stringify([turn.turnId, item.id])),
    ),
  );
  const missingReceiptIds = promotions.flatMap((receipt) =>
    residentItems.has(JSON.stringify([receipt.turnId, receipt.itemId])) ? [] : [receipt.id],
  );
  const history = state.turnHistory?.history;
  const island = history?.islands[0];
  const boundary = island?.olderBoundary;
  const olderPage: CodexConversationHistoryPageRequest | null =
    history && island && boundary?.status === "available" && boundary.handle.source === "timeline"
      ? {
          threadId: state.id,
          expectedConversationGeneration: conversation.conversationEntityGeneration ?? 0,
          expectedHistoryMutationRevision: conversation.historyMutationRevision ?? 0,
          target: {
            kind: "turnBoundary",
            boundary: createCodexHistoryBoundaryRef(
              history.generation,
              island.id,
              "older",
              boundary,
            ),
          },
        }
      : null;
  return { missingReceiptIds, olderPage };
}

function olderCursor(snapshot: PendingArtifactRecoveryRead): string | null {
  const target = snapshot.olderPage?.target;
  return target?.kind === "turnBoundary" ? target.boundary.handle.cursor : null;
}

function settledStatus(snapshot: PendingArtifactRecoveryRead): PendingArtifactRecoveryStatus {
  if (snapshot.missingReceiptIds.length === 0) return "idle";
  if (snapshot.olderPage === null) return "exhausted";
  return "unresolved";
}

/** A conversation owns bounded recovery; automatic signals coalesce without replaying seen receipts. */
export function createPendingArtifactRecovery(port: {
  readonly read: () =>
    | PendingArtifactRecoveryRead
    | null
    | Promise<PendingArtifactRecoveryRead | null>;
  readonly supportsTimeline: () => boolean | Promise<boolean>;
  readonly loadOlder: (
    request: CodexConversationHistoryPageRequest,
  ) => Promise<{ readonly status: "applied" | "stale" }>;
}) {
  let status: PendingArtifactRecoveryStatus = "idle";
  let flight: Promise<void> | null = null;
  let replayAutomatic = false;
  let disposed = false;
  const seenReceipts = new Set<string>();
  const listeners = new Set<() => void>();
  const load = async (request: CodexConversationHistoryPageRequest): Promise<boolean> => {
    try {
      return (await port.loadOlder(request)).status === "applied";
    } catch (cause) {
      if (cause instanceof CodexHistoryCursorStalled) return false;
      throw cause;
    }
  };
  const publish = (next: PendingArtifactRecoveryStatus) => {
    if (disposed || status === next) return;
    status = next;
    listeners.forEach((listener) => listener());
  };
  const hydrate = (mode: PendingArtifactRecoveryMode = "automatic"): Promise<void> => {
    if (flight || disposed) {
      replayAutomatic ||= mode === "automatic";
      return flight ?? Promise.resolve();
    }
    flight = (async () => {
      try {
        let snapshot = await port.read();
        if (disposed || !snapshot) return;
        const targets = new Set(
          snapshot.missingReceiptIds.filter((id) => mode === "retry" || !seenReceipts.has(id)),
        );
        snapshot.missingReceiptIds.forEach((id) => seenReceipts.add(id));
        if (targets.size === 0) {
          if (snapshot.missingReceiptIds.length === 0) publish("idle");
          return;
        }
        publish("loading");
        for (let page = 0; page < 2 && snapshot.olderPage; page++) {
          if (!(await port.supportsTimeline()) || disposed) break;
          const cursor = olderCursor(snapshot);
          const applied = await load(snapshot.olderPage);
          snapshot = await port.read();
          if (disposed || !snapshot) return;
          snapshot.missingReceiptIds.forEach((id) => seenReceipts.add(id));
          if (
            !applied ||
            !snapshot.missingReceiptIds.some((id) => targets.has(id)) ||
            olderCursor(snapshot) === cursor
          )
            break;
        }
        publish(settledStatus(snapshot));
      } catch {
        publish("failed");
      }
    })().finally(() => {
      flight = null;
      if (!replayAutomatic || disposed) return;
      replayAutomatic = false;
      void hydrate("automatic");
    });
    return flight;
  };
  return {
    getStatus: () => status,
    subscribe: (listener: () => void) => {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hydrate,
    dispose: () => {
      disposed = true;
      listeners.clear();
    },
  };
}

export type PendingArtifactRecovery = ReturnType<typeof createPendingArtifactRecovery>;
