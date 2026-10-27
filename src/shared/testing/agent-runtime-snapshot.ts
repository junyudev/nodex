import type { AgentSnapshot } from "@nodex/agent-runtime/contracts";

type Projection = AgentSnapshot["projection"];
type Thread = Projection["thread"];

/** What a test changes in a Runtime conversation; everything else keeps the fixture's values. */
export interface AgentRuntimeSnapshotOverrides {
  readonly thread?: Partial<Thread>;
  readonly projection?: Partial<Omit<Projection, "thread">>;
  readonly snapshot?: Partial<Omit<AgentSnapshot, "kind" | "projection">>;
}

/**
 * A complete Runtime conversation snapshot as the renderer receives it: one idle root chat with
 * no history. It is typed against the wire contract rather than cast to it, so when the Runtime
 * adds a field this is the one place typecheck asks to fill in, instead of a test failing at run
 * time on a fixture that never had it.
 */
export function agentRuntimeSnapshotFixture(
  overrides: AgentRuntimeSnapshotOverrides = {},
): AgentSnapshot {
  const thread: Thread = {
    createdBy: "user",
    creationSource: "server",
    id: "engine-thread",
    projectId: "project",
    title: "Task",
    providerInstanceId: overrides.thread?.modelSelection?.instanceId ?? "codex",
    modelSelection: { instanceId: "codex", model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/workspace",
    activeProviderThreadId: null,
    forkedFrom: null,
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    lineage: {
      rootThreadId: overrides.thread?.id ?? "engine-thread",
      parentThreadId: null,
      relationshipToParent: null,
    },
    ...overrides.thread,
  };
  return {
    kind: "snapshot",
    snapshotSequence: 1,
    historyCursor: null,
    hasMoreHistory: false,
    latestLocalTurnOrdinal: null,
    payloadBudgetExceeded: false,
    ...overrides.snapshot,
    projection: {
      thread,
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: "2026-10-14T00:00:00Z",
      ...overrides.projection,
    },
  };
}

type RowKey = {
  [K in keyof Projection]: Projection[K] extends readonly unknown[] ? K : never;
}[keyof Projection];
type Row<K extends RowKey> = Projection[K][number];

/**
 * One projection row carrying only the fields a test exercises. The rest is left unset on
 * purpose, and the cast is confined to that row, so the snapshot around it stays checked.
 */
export const agentRuntimeRow = <K extends RowKey>(_list: K, row: Partial<Row<K>>): Row<K> =>
  row as Row<K>;
