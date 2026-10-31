import { useCallback, useSyncExternalStore } from "react";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import { projectionCursorCovers, type ProjectionCursor } from "../../shared/projection-stream";
import type {
  SessionLinkedPage,
  SessionLinkedPageSummaryInput,
  SessionLinkedPageSummaryResult,
} from "../../shared/types";
import { MAX_SESSION_LINKED_PAGE_IDS } from "../../shared/schemas/project-sessions";
import { readSessionLinkedPageSummaries } from "./page-chat-runtime";
import type {
  ProjectionInvalidationCause,
  ProjectionRegistration,
} from "./projection-invalidation-registry";
import { getRendererProjectionInvalidationRegistry } from "./projection-invalidation-service";
import { resolveRendererTransport } from "./renderer-transport";

export type { SessionLinkedPage } from "../../shared/types";

export interface SessionLinkedPageStore {
  readonly read: (sessionId: string) => SessionLinkedPage | null;
  readonly subscribeSession: (sessionId: string, listener: () => void) => () => void;
}

export interface SessionLinkedPageSource {
  readonly read: (input: SessionLinkedPageSummaryInput) => Promise<SessionLinkedPageSummaryResult>;
  readonly subscribeSessions: (listener: (event: ProjectSessionsChangeEvent) => void) => () => void;
  readonly registerProjection: (registration: ProjectionRegistration) => () => void;
}

interface Entry {
  page: SessionLinkedPage | null;
  cursor: ProjectionCursor | null;
  requiredCursor: ProjectionCursor | null;
  generation: number;
  loading: boolean;
  readonly listeners: Set<() => void>;
}

const samePage = (left: SessionLinkedPage | null, right: SessionLinkedPage | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.pageId === right.pageId &&
    left.pageKey === right.pageKey &&
    left.title === right.title &&
    left.status?.optionId === right.status?.optionId &&
    left.status?.label === right.status?.label);

/**
 * One bounded, keyed projection per renderer. Mounted rows share microtask reads and subscriptions.
 * An invalidation racing a read supersedes its result and schedules a trailing read; no polling.
 */
export function createSessionLinkedPageStore(
  source: SessionLinkedPageSource,
): SessionLinkedPageStore {
  const entries = new Map<string, Entry>();
  const pending = new Set<string>();
  let scheduled = false;
  let stopSessions: (() => void) | null = null;
  let stopProjection: (() => void) | null = null;
  let libraryId: string | null = null;

  const notify = (entry: Entry) => {
    for (const listener of [...entry.listeners]) listener();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  };
  const invalidate = (sessionIds: Iterable<string> = entries.keys(), clear = false) => {
    for (const sessionId of sessionIds) {
      const entry = entries.get(sessionId);
      if (!entry?.listeners.size) continue;
      entry.generation += 1;
      pending.add(sessionId);
      if (!clear) continue;
      entry.cursor = null;
      if (entry.page === null) continue;
      entry.page = null;
      notify(entry);
    }
    schedule();
  };
  const cursor = (): ProjectionCursor | null => {
    let common: ProjectionCursor | null = null;
    for (const entry of entries.values()) {
      if (!entry.listeners.size) continue;
      if (!entry.cursor) return null;
      if (common && common.storeEpoch !== entry.cursor.storeEpoch) return null;
      if (!common || entry.cursor.commitSeq < common.commitSeq) common = entry.cursor;
    }
    return common;
  };
  const invalidateProjection = (cause: ProjectionInvalidationCause) => {
    for (const [sessionId, entry] of entries) {
      entry.requiredCursor = cause.stream;
      if (entry.loading || projectionCursorCovers(entry.cursor, cause.stream)) continue;
      pending.add(sessionId);
    }
    schedule();
  };
  const observeProjection = (nextLibraryId: string) => {
    if (libraryId === nextLibraryId && stopProjection) return;
    stopProjection?.();
    libraryId = nextLibraryId;
    stopProjection = source.registerProjection({
      scope: { kind: "library", libraryId: nextLibraryId },
      consumerKey: "session-linked-pages",
      // Membership, key namespace and option-registry changes can affect previously absent
      // results too. A bounded sidebar batch observes the existing Library aggregate effects.
      getDependencies: () => ({ aggregate: true }),
      getCursor: cursor,
      fence: (cause) => {
        for (const entry of entries.values()) {
          entry.requiredCursor = cause.stream;
          if (cause.kind === "checkpoint" && projectionCursorCovers(entry.cursor, cause.stream))
            continue;
          entry.cursor = null;
          if (entry.page === null) continue;
          entry.page = null;
          notify(entry);
        }
      },
      invalidate: invalidateProjection,
    });
  };
  const readBatch = async (
    batch: Array<{ sessionId: string; entry: Entry; generation: number }>,
  ) => {
    try {
      const result = await source.read({ sessionIds: batch.map(({ sessionId }) => sessionId) });
      const pages = new Map(result.summaries.map((summary) => [summary.sessionId, summary.page]));
      for (const { sessionId, entry, generation } of batch) {
        if (entries.get(sessionId) !== entry || generation !== entry.generation) continue;
        const observed = { storeEpoch: result.storeEpoch, commitSeq: result.projectionRevision };
        if (entry.requiredCursor && !projectionCursorCovers(observed, entry.requiredCursor)) {
          pending.add(sessionId);
          continue;
        }
        entry.cursor = observed;
        const next = pages.get(sessionId) ?? null;
        if (samePage(entry.page, next)) continue;
        entry.page = next;
        notify(entry);
      }
      if (entries.size > 0) observeProjection(result.libraryId);
    } catch {
      // Keep the last committed value. The next change or remount retries an unavailable read.
    } finally {
      for (const { entry } of batch) entry.loading = false;
      if (pending.size > 0) schedule();
    }
  };
  function flush() {
    scheduled = false;
    const ready: Array<{ sessionId: string; entry: Entry; generation: number }> = [];
    for (const sessionId of pending) {
      const entry = entries.get(sessionId);
      if (entry?.loading) continue;
      pending.delete(sessionId);
      if (!entry?.listeners.size) continue;
      entry.loading = true;
      ready.push({ sessionId, entry, generation: entry.generation });
    }
    for (let start = 0; start < ready.length; start += MAX_SESSION_LINKED_PAGE_IDS) {
      void readBatch(ready.slice(start, start + MAX_SESSION_LINKED_PAGE_IDS));
    }
  }

  return {
    read: (sessionId) => entries.get(sessionId)?.page ?? null,
    subscribeSession: (sessionId, listener) => {
      const entry = entries.get(sessionId) ?? {
        page: null,
        cursor: null,
        requiredCursor: null,
        generation: 0,
        loading: false,
        listeners: new Set(),
      };
      entries.set(sessionId, entry);
      entry.listeners.add(listener);
      stopSessions ??= source.subscribeSessions((event) => {
        invalidate(
          event.detailInvalidation.kind === "all"
            ? entries.keys()
            : event.detailInvalidation.sessionIds,
          event.changeType === "archive" || event.changeType === "delete",
        );
      });
      if (!entry.cursor && !entry.loading) {
        pending.add(sessionId);
        schedule();
      }
      return () => {
        entry.listeners.delete(listener);
        // StrictMode and another lane may resubscribe in the same commit.
        queueMicrotask(() => {
          if (entry.listeners.size > 0) return;
          if (entries.get(sessionId) === entry) entries.delete(sessionId);
          pending.delete(sessionId);
          if (entries.size > 0) return;
          stopSessions?.();
          stopProjection?.();
          stopSessions = null;
          stopProjection = null;
          libraryId = null;
        });
      };
    },
  };
}

export const sessionLinkedPageStore = createSessionLinkedPageStore({
  read: readSessionLinkedPageSummaries,
  subscribeSessions: (listener) =>
    resolveRendererTransport().subscribeProjectSessionChanges(listener),
  registerProjection: (registration) =>
    getRendererProjectionInvalidationRegistry().register(registration),
});

/** The earliest-linked live Page, or null when no Page is eligible or the read is pending. */
export function useSessionLinkedPage(
  sessionId: string | null,
  store: SessionLinkedPageStore = sessionLinkedPageStore,
): SessionLinkedPage | null {
  const subscribe = useCallback(
    (listener: () => void) => (sessionId ? store.subscribeSession(sessionId, listener) : () => {}),
    [sessionId, store],
  );
  return useSyncExternalStore(subscribe, () => (sessionId ? store.read(sessionId) : null));
}
