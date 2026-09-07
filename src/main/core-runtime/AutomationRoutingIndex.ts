import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { AutomationReadSnapshot, CoreRequestOptions } from "../core-client/types";
import { CoreModules } from "./CoreModules";
import type { CoreRuntimeError } from "./CoreRuntimeError";

const BACKGROUND_CORE_REQUEST = {
  class: "background",
} as const satisfies CoreRequestOptions;

export type AutomationRoutingDefinition = Extract<
  AutomationReadSnapshot["value"],
  { readonly kind: "definitions" }
>["window"]["items"][number];

export type AutomationRoutingRun = Extract<
  AutomationReadSnapshot["value"],
  { readonly kind: "runs" }
>["window"]["items"][number];

export interface AutomationRoutingCommit {
  readonly definitions?: {
    readonly removeIds?: readonly string[];
    readonly upsert?: readonly AutomationRoutingDefinition[];
  };
  readonly runs?: {
    readonly removeThreadIds?: readonly string[];
    readonly upsert?: readonly AutomationRoutingRun[];
  };
}

export class AutomationRoutingIndexError extends Schema.TaggedError<AutomationRoutingIndexError>()(
  "AutomationRoutingIndexError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

interface AutomationRoutingState {
  readonly accepting: boolean;
  readonly activeHeartbeatBySessionId: ReadonlyMap<string, string>;
  readonly completedRefresh: number;
  readonly mutationRevision: number;
  readonly requestedRefresh: number;
  readonly runAutomationByThreadId: ReadonlyMap<string, string>;
}

export class AutomationRoutingIndex extends Context.Service<
  AutomationRoutingIndex,
  {
    /** Applies the routing consequences of one successfully committed Core mutation. */
    readonly commit: (input: AutomationRoutingCommit) => void;
    /** Rebuilds the complete routing projection from canonical Core state. */
    readonly synchronize: Effect.Effect<void, CoreRuntimeError | AutomationRoutingIndexError>;
    readonly activeHeartbeatAutomationId: (sessionId: string) => string | null;
    readonly runAutomationId: (threadId: string) => string | null;
  }
>()("nodex/main/core-runtime/AutomationRoutingIndex") {}

const emptyState = (): AutomationRoutingState => ({
  accepting: true,
  activeHeartbeatBySessionId: new Map(),
  completedRefresh: 0,
  mutationRevision: 0,
  requestedRefresh: 0,
  runAutomationByThreadId: new Map(),
});

const definitionIndex = (
  definitions: readonly AutomationRoutingDefinition[],
): ReadonlyMap<string, string> => {
  const index = new Map<string, string>();
  for (const definition of definitions) {
    if (
      definition.kind !== "heartbeat" ||
      definition.status !== "ACTIVE" ||
      !definition.target_session_id
    ) {
      continue;
    }
    index.set(definition.target_session_id, definition.automation_id);
  }
  return index;
};

const runIndex = (items: readonly AutomationRoutingRun[]): ReadonlyMap<string, string> =>
  new Map(items.map((item) => [item.thread_id, item.automation_id] as const));

const applyCommit = (
  state: AutomationRoutingState,
  input: AutomationRoutingCommit,
): AutomationRoutingState => {
  if (!state.accepting) return state;

  const activeHeartbeatBySessionId = new Map(state.activeHeartbeatBySessionId);
  const runAutomationByThreadId = new Map(state.runAutomationByThreadId);
  const definitionChanges = input.definitions;
  const runChanges = input.runs;

  for (const automationId of definitionChanges?.removeIds ?? []) {
    for (const [sessionId, indexedAutomationId] of activeHeartbeatBySessionId) {
      if (indexedAutomationId === automationId) activeHeartbeatBySessionId.delete(sessionId);
    }
  }
  for (const definition of definitionChanges?.upsert ?? []) {
    for (const [sessionId, automationId] of activeHeartbeatBySessionId) {
      if (automationId === definition.automation_id) activeHeartbeatBySessionId.delete(sessionId);
    }
    if (
      definition.kind === "heartbeat" &&
      definition.status === "ACTIVE" &&
      definition.target_session_id
    ) {
      activeHeartbeatBySessionId.set(definition.target_session_id, definition.automation_id);
    }
  }

  for (const threadId of runChanges?.removeThreadIds ?? []) {
    runAutomationByThreadId.delete(threadId);
  }
  for (const run of runChanges?.upsert ?? []) {
    runAutomationByThreadId.set(run.thread_id, run.automation_id);
  }

  return {
    ...state,
    activeHeartbeatBySessionId,
    mutationRevision: state.mutationRevision + 1,
    runAutomationByThreadId,
  };
};

/**
 * Owns the synchronous Codex routing read model. Core commits update it before
 * returning to application code; causal invalidations rebuild it as recovery.
 * A rebuild that began before a newer commit can never overwrite that commit.
 */
export const live: Layer.Layer<AutomationRoutingIndex, never, CoreModules> = Layer.effect(
  AutomationRoutingIndex,
  Effect.gen(function* () {
    const core = yield* CoreModules;
    const state = MutableRef.make(emptyState());
    const refreshLock = yield* Semaphore.make(1);

    const readDefinitions = Effect.fn("AutomationRoutingIndex.readDefinitions")(function* () {
      const items: AutomationRoutingDefinition[] = [];
      const seenCursors = new Set<string>();
      let after: string | null = null;
      while (true) {
        const snapshot: AutomationReadSnapshot = yield* core.automation.read(
          {
            kind: "definitions",
            include_deleted: false,
            window: { after, first: 200 },
          },
          BACKGROUND_CORE_REQUEST,
        );
        if (snapshot.value.kind !== "definitions") {
          return yield* new AutomationRoutingIndexError({
            operation: "synchronize.definitions",
            cause: new Error("Core returned a non-Definitions Automation read"),
          });
        }
        items.push(...snapshot.value.window.items);
        const next: string | null = snapshot.value.window.next_cursor ?? null;
        if (next === null) return items;
        if (seenCursors.has(next)) {
          return yield* new AutomationRoutingIndexError({
            operation: "synchronize.definitions",
            cause: new Error("Core repeated an Automation Definition cursor"),
          });
        }
        seenCursors.add(next);
        after = next;
      }
    });

    const readRuns = Effect.fn("AutomationRoutingIndex.readRuns")(function* () {
      const items: AutomationRoutingRun[] = [];
      const seenCursors = new Set<string>();
      let after: string | null = null;
      while (true) {
        const snapshot: AutomationReadSnapshot = yield* core.automation.read(
          {
            kind: "runs",
            include_archived: true,
            window: { after, first: 200 },
          },
          BACKGROUND_CORE_REQUEST,
        );
        if (snapshot.value.kind !== "runs") {
          return yield* new AutomationRoutingIndexError({
            operation: "synchronize.runs",
            cause: new Error("Core returned a non-Runs Automation read"),
          });
        }
        items.push(...snapshot.value.window.items);
        const next: string | null = snapshot.value.window.next_cursor ?? null;
        if (next === null) return items;
        if (seenCursors.has(next)) {
          return yield* new AutomationRoutingIndexError({
            operation: "synchronize.runs",
            cause: new Error("Core repeated an Automation Run cursor"),
          });
        }
        seenCursors.add(next);
        after = next;
      }
    });

    const synchronize = Effect.suspend(() => {
      const requested = MutableRef.updateAndGet(state, (current) => ({
        ...current,
        requestedRefresh: current.requestedRefresh + 1,
      })).requestedRefresh;

      const refreshStable: Effect.Effect<void, CoreRuntimeError | AutomationRoutingIndexError> =
        Effect.suspend(() =>
          Effect.gen(function* () {
            const before = MutableRef.get(state);
            if (!before.accepting || before.completedRefresh >= requested) return;
            const mutationRevision = before.mutationRevision;
            const refreshRevision = before.requestedRefresh;
            const [definitions, runs] = yield* Effect.all([readDefinitions(), readRuns()], {
              concurrency: 2,
            });
            let committed = false;
            MutableRef.update(state, (current) => {
              if (!current.accepting || current.mutationRevision !== mutationRevision) {
                return current;
              }
              committed = true;
              return {
                ...current,
                activeHeartbeatBySessionId: definitionIndex(definitions),
                completedRefresh: refreshRevision,
                runAutomationByThreadId: runIndex(runs),
              };
            });
            if (!committed && MutableRef.get(state).accepting) yield* refreshStable;
          }),
        );

      return refreshLock.withPermit(refreshStable);
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        MutableRef.set(state, {
          ...MutableRef.get(state),
          accepting: false,
          activeHeartbeatBySessionId: new Map(),
          runAutomationByThreadId: new Map(),
        });
      }),
    );

    return AutomationRoutingIndex.of({
      activeHeartbeatAutomationId: (sessionId) =>
        MutableRef.get(state).activeHeartbeatBySessionId.get(sessionId) ?? null,
      commit: (input) => MutableRef.update(state, (current) => applyCommit(current, input)),
      runAutomationId: (threadId) =>
        MutableRef.get(state).runAutomationByThreadId.get(threadId) ?? null,
      synchronize,
    });
  }),
);
