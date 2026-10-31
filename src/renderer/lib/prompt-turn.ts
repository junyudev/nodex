import { useCallback, useSyncExternalStore } from "react";
import {
  PROMPT_TURN_READ_LIMIT,
  UNKNOWN_PROMPT_TURN,
  type PromptTurn,
  type PromptTurnEntry,
  type PromptTurnsInput,
  type PromptTurnTarget,
} from "../../shared/prompt-turn";
import type { AgentRuntimeSessionEvent } from "../../shared/agent-runtime-api";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { resolveRendererTransport } from "./renderer-transport";

export type { PromptTurn, PromptTurnPhase, PromptTurnTarget } from "../../shared/prompt-turn";

export interface PromptTurnSource {
  readonly read: (input: PromptTurnsInput) => Promise<readonly PromptTurnEntry[]>;
  readonly subscribe: (
    sessionId: string,
    listener: (event: AgentRuntimeSessionEvent) => void,
  ) => Promise<() => void>;
}

interface Entry {
  value: PromptTurn;
  dirty: boolean;
  readonly listeners: Set<() => void>;
}
interface Session {
  readonly entries: Map<string, Entry>;
  release: (() => void) | null;
  scheduled: boolean;
  reading: boolean;
}

export interface PromptTurnStore {
  readonly read: (target: PromptTurnTarget) => PromptTurn;
  readonly subscribe: (target: PromptTurnTarget, listener: () => void) => () => void;
}

/** One metadata subscription per observed chat; addressed reads coalesce in batches of at most 100. */
export function createPromptTurnStore(source: PromptTurnSource): PromptTurnStore {
  const sessions = new Map<string, Session>();
  const current = (id: string, session: Session) => sessions.get(id) === session;
  const publish = (entry: Entry, value: PromptTurn) => {
    if (
      entry.value.phase === value.phase &&
      entry.value.reply === value.reply &&
      entry.value.runId === value.runId
    )
      return;
    entry.value = value;
    for (const listener of [...entry.listeners]) listener();
  };
  const refresh = async (sessionId: string, session: Session) => {
    if (!current(sessionId, session) || session.reading) return;
    session.scheduled = false;
    session.reading = true;
    try {
      while (current(sessionId, session)) {
        const batch = [...session.entries]
          .filter(([, entry]) => entry.dirty)
          .slice(0, PROMPT_TURN_READ_LIMIT);
        if (batch.length === 0) break;
        for (const [, entry] of batch) entry.dirty = false;
        const values = await source
          .read({ sessionId, messageIds: batch.map(([id]) => id) })
          .catch(() => []);
        if (!current(sessionId, session)) return;
        const byId = new Map(values.map((entry) => [entry.messageId, entry]));
        for (const [id, entry] of batch) {
          if (session.entries.get(id) !== entry || entry.dirty) continue;
          publish(entry, byId.get(id) ?? UNKNOWN_PROMPT_TURN);
        }
      }
    } finally {
      session.reading = false;
    }
  };
  const schedule = (sessionId: string, session: Session) => {
    if (session.scheduled || session.reading) return;
    session.scheduled = true;
    queueMicrotask(() => void refresh(sessionId, session));
  };
  const attach = (sessionId: string, session: Session) => {
    void source
      .subscribe(sessionId, (event) => {
        if (!current(sessionId, session)) return;
        const change = event.type === "event" ? event.event.event : null;
        const runId =
          change?.type === "run.updated" || change?.type === "run.created"
            ? change.payload.id
            : change?.runId;
        for (const entry of session.entries.values()) {
          if (runId && entry.value.runId && entry.value.runId !== runId) continue;
          entry.dirty = true;
        }
        schedule(sessionId, session);
      })
      .then((release) => {
        if (!current(sessionId, session)) return release();
        session.release = release;
        // Reconcile anything committed before observation was admitted.
        for (const entry of session.entries.values()) entry.dirty = true;
        schedule(sessionId, session);
      })
      .catch(() => {});
  };
  return {
    read: ({ sessionId, messageId }) =>
      sessions.get(sessionId)?.entries.get(messageId)?.value ?? UNKNOWN_PROMPT_TURN,
    subscribe: ({ sessionId, messageId }, listener) => {
      if (!sessionId || !messageId) return () => {};
      let session = sessions.get(sessionId);
      if (!session) {
        session = { entries: new Map(), release: null, scheduled: false, reading: false };
        sessions.set(sessionId, session);
        attach(sessionId, session);
      }
      const entry = session.entries.get(messageId) ?? {
        value: UNKNOWN_PROMPT_TURN,
        dirty: true,
        listeners: new Set<() => void>(),
      };
      session.entries.set(messageId, entry);
      entry.listeners.add(listener);
      schedule(sessionId, session);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0) return;
        session.entries.delete(messageId);
        if (session.entries.size > 0) return;
        sessions.delete(sessionId);
        session.release?.();
      };
    },
  };
}

export const promptTurnStore = createPromptTurnStore({
  read: (input) => agentRuntimeRuntime.promptTurns(input),
  subscribe: async (sessionId, listener) => {
    let release: (() => void) | null = null;
    let disposed = false;
    let generation = 0;
    const connect = async () => {
      const attempt = ++generation;
      release?.();
      release = null;
      const next = await agentRuntimeRuntime.subscribe(
        {
          sessionId,
          eventTypes: [
            "run.created",
            "run.updated",
            "run.execution-retired",
            "thread.archived",
            "thread.unarchived",
            "thread.deleted",
          ],
        },
        listener,
      );
      if (disposed || generation !== attempt) return next();
      release = next;
      listener({ type: "reset-required", sessionId, threadId: "", reason: "runtime-restarted" });
    };
    const stopConnection = resolveRendererTransport().subscribeAgentRuntimeConnectionChanges?.(
      (state) => {
        if (state.status === "ready") void connect().catch(() => {});
      },
    );
    void connect().catch(() => {});
    return () => {
      disposed = true;
      generation += 1;
      release?.();
      stopConnection?.();
    };
  },
});

/** Missing/legacy message anchors are unknown and acquire no runtime resources. */
export function usePromptTurn(
  { sessionId, messageId }: PromptTurnTarget,
  store: PromptTurnStore = promptTurnStore,
): PromptTurn {
  return useSyncExternalStore(
    useCallback(
      (listener) => store.subscribe({ sessionId, messageId }, listener),
      [sessionId, messageId, store],
    ),
    () => store.read({ sessionId, messageId }),
  );
}
