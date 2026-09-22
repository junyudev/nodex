import type { Thread, ThreadListParams, Turn } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { discoverCodexSubagentDescendants } from "./CodexSubagentDiscovery";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";

type Input = Parameters<typeof discoverCodexSubagentDescendants>[0];
type GatewayThread = ClientRequestResponsesByMethod["thread/list"]["data"][number];
type GatewayTurn = ClientRequestResponsesByMethod["thread/turns/list"]["data"][number];
const child = (id: string, parentThreadId = "root") =>
  ({
    id,
    parentThreadId,
    model: null,
    reasoningEffort: null,
    environments: null,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    preview: id,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: 100,
    updatedAt: 120,
    recencyAt: 120,
    status: { type: "active", activeFlags: [] },
    path: null,
    cwd: "/repo",
    cliVersion: "test",
    originator: null,
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: parentThreadId,
          depth: 1,
          agent_path: `${parentThreadId}/${id}`,
          agent_nickname: id,
          agent_role: "explorer",
        },
      },
    },
    canAcceptDirectInput: true,
    threadSource: "subAgentThreadSpawn",
    agentNickname: id,
    agentRole: "explorer",
    gitInfo: null,
    name: id,
    daybreakEnabled: null,
    turns: [],
  }) satisfies Thread & GatewayThread;
const turnFixture = (id: string) =>
  ({
    id,
    status: "completed",
    items: [],
    itemsView: "full",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  }) satisfies Turn & GatewayTurn;
const spawn = (threadId: string) =>
  ({
    ...turnFixture(`spawn-${threadId}`),
    items: [
      {
        type: "subAgentActivity",
        id: `activity-${threadId}`,
        kind: "started",
        agentThreadId: threadId,
        agentPath: `/root/${threadId}`,
      },
    ],
  }) satisfies Turn & GatewayTurn;
const input = (overrides: Partial<Input> = {}): Input => ({
  rootThreadId: "root",
  rootCreatedAtMs: 100_000,
  listSupported: true,
  ancestorFilter: true,
  observedSpawnedThreadIds: () => [],
  isResident: () => false,
  list: () => Effect.succeed({ data: [], nextCursor: null }),
  read: () => Effect.die("Unexpected metadata repair"),
  turns: () => Effect.die("Unexpected transcript read"),
  ...overrides,
});

it.effect("finishes every metadata page without a discovery pass or overview size limit", () =>
  Effect.gen(function* () {
    const pages = 35;
    const params: ThreadListParams[] = [];
    const result = yield* discoverCodexSubagentDescendants(
      input({
        list: (request) =>
          Effect.sync(() => {
            params.push(request);
            const page = Number(request.cursor ?? 0);
            return {
              data: Array.from({ length: 200 }, (_, index) => child(`child-${page * 200 + index}`)),
              nextCursor: page + 1 === pages ? null : `${page + 1}`,
            };
          }),
      }),
    );
    assert.isTrue(result.complete);
    assert.strictEqual(result.threads.length, 7_000);
    assert.strictEqual(params.length, pages);
    assert.isTrue(
      params.every(
        (p) => p.ancestorThreadId === "root" && p.limit === 200 && p.useStateDbOnly === true,
      ),
    );
  }),
);

it.effect("only falls back from a first terminal state-db page with missing observed spawns", () =>
  Effect.gen(function* () {
    const requests: ThreadListParams[] = [];
    const result = yield* discoverCodexSubagentDescendants(
      input({
        observedSpawnedThreadIds: (parent) => (parent === "root" ? ["missing"] : []),
        list: (params) =>
          Effect.sync(() => {
            requests.push(params);
            return { data: params.useStateDbOnly ? [] : [child("missing")], nextCursor: null };
          }),
      }),
    );
    assert.isTrue(result.complete);
    assert.deepEqual(
      requests.map((p) => p.useStateDbOnly),
      [true, false],
    );
    let emptyRequests = 0;
    yield* discoverCodexSubagentDescendants(
      input({
        ancestorFilter: false,
        list: () =>
          Effect.sync(() => {
            emptyRequests++;
            return { data: [], nextCursor: null };
          }),
      }),
    );
    assert.strictEqual(emptyRequests, 1);
  }),
);

it.effect("repairs a missing observed child after terminal pagination without re-listing", () =>
  Effect.gen(function* () {
    const requests: ThreadListParams[] = [];
    const reads: string[] = [];
    const result = yield* discoverCodexSubagentDescendants(
      input({
        observedSpawnedThreadIds: (parent) => (parent === "root" ? ["missing"] : []),
        list: (params) =>
          Effect.sync(() => {
            requests.push(params);
            return params.cursor === null
              ? { data: [child("listed")], nextCursor: "last" }
              : { data: [], nextCursor: null };
          }),
        read: (id) =>
          Effect.sync(() => {
            reads.push(id);
            return child(id);
          }),
        turns: () => Effect.succeed({ data: [], nextCursor: null }),
      }),
    );
    assert.isTrue(result.complete);
    assert.deepEqual(
      requests.map((p) => [p.cursor, p.useStateDbOnly]),
      [
        [null, true],
        ["last", true],
      ],
    );
    assert.deepEqual(reads, ["missing"]);
    assert.deepEqual(
      result.threads.map((t) => t.id),
      ["listed", "missing"],
    );
  }),
);

it.effect("stops cyclic list cursors before topology repair and reports incomplete", () =>
  Effect.gen(function* () {
    const cursors: Array<string | null | undefined> = [];
    const result = yield* discoverCodexSubagentDescendants(
      input({
        observedSpawnedThreadIds: () => ["unresolved"],
        list: (params) =>
          Effect.sync(() => {
            cursors.push(params.cursor);
            return { data: [], nextCursor: params.cursor === "a" ? "b" : "a" };
          }),
      }),
    );
    assert.isFalse(result.complete);
    assert.deepEqual(cursors, [null, "a", "b"]);
  }),
);

it.effect("uses the root creation cutoff and skips unrelated direct-parent rows", () =>
  Effect.gen(function* () {
    const parents: Array<string | null | undefined> = [];
    const result = yield* discoverCodexSubagentDescendants(
      input({
        ancestorFilter: false,
        list: (params) =>
          Effect.sync(() => {
            parents.push(params.parentThreadId);
            return params.parentThreadId === "root"
              ? {
                  data: [
                    child("related"),
                    { ...child("old-unrelated", "different"), createdAt: 99 },
                  ],
                  nextCursor: "older",
                }
              : { data: [], nextCursor: null };
          }),
      }),
    );
    assert.isTrue(result.complete);
    assert.deepEqual(parents, ["root", "related"]);
    assert.deepEqual(
      result.threads.map((t) => t.id),
      ["related"],
    );
  }),
);

it.effect("scans repaired nonresident history to its end and keeps only the latest skeleton", () =>
  Effect.gen(function* () {
    const readIds: string[] = [];
    const topologyIds: string[] = [];
    const result = yield* discoverCodexSubagentDescendants(
      input({
        observedSpawnedThreadIds: (parent) =>
          parent === "root" ? ["repaired", "resident", "inline"] : [],
        isResident: (id) => id === "resident",
        read: (id) =>
          Effect.sync(() => {
            readIds.push(id);
            return {
              ...child(id, id.startsWith("nested") ? "repaired" : "root"),
              historyMode: id === "inline" ? "inline" : "paginated",
            } as Thread;
          }),
        turns: (id, cursor) =>
          Effect.sync(() => {
            topologyIds.push(id);
            if (id !== "repaired") return { data: [], nextCursor: null };
            const page = Number(cursor ?? 0);
            const turn =
              page === 0
                ? spawn("nested-first")
                : page === 204
                  ? spawn("nested-last")
                  : turnFixture(`turn-${page}`);
            return { data: [turn], nextCursor: page === 204 ? null : `${page + 1}` };
          }),
      }),
    );
    assert.isTrue(result.complete);
    assert.deepEqual([...readIds].sort(), [
      "inline",
      "nested-first",
      "nested-last",
      "repaired",
      "resident",
    ]);
    assert.strictEqual(topologyIds.filter((id) => id === "repaired").length, 205);
    assert.notInclude(topologyIds, "root");
    assert.notInclude(topologyIds, "resident");
    assert.notInclude(topologyIds, "inline");
    const repaired = result.threads.find((t) => t.id === "repaired")!;
    assert.strictEqual(repaired.turns.length, 1);
    assert.strictEqual(repaired.turns[0]?.id, "spawn-nested-last");
    assert.strictEqual(repaired.turns[0]?.itemsView, "notLoaded");
    assert.deepEqual(repaired.turns[0]?.items, []);
  }),
);

it.effect("keeps metadata but marks a cyclic or failed child topology incomplete", () =>
  Effect.gen(function* () {
    for (const failure of ["cursor", "request"] as const) {
      const result = yield* discoverCodexSubagentDescendants(
        input({
          observedSpawnedThreadIds: (parent) => (parent === "root" ? ["repaired"] : []),
          read: (id) => Effect.succeed(child(id)),
          turns: () =>
            failure === "cursor"
              ? Effect.succeed({ data: [], nextCursor: "repeat" })
              : Effect.fail(
                  codexRuntimeError({ operation: "request", reason: "request", retryable: true }),
                ),
        }),
      );
      assert.isFalse(result.complete);
      assert.deepEqual(
        result.threads.map((t) => t.id),
        ["repaired"],
      );
    }
  }),
);

it.effect("keeps durable-only hosts incomplete while repairing observed identities", () =>
  Effect.gen(function* () {
    const result = yield* discoverCodexSubagentDescendants(
      input({
        listSupported: false,
        list: () => Effect.die("Durable-only host must not list"),
        observedSpawnedThreadIds: (parent) => (parent === "root" ? ["child"] : []),
        isResident: () => true,
        read: (id) => Effect.succeed(child(id)),
      }),
    );
    assert.isFalse(result.complete);
    assert.deepEqual(
      result.threads.map((t) => t.id),
      ["child"],
    );
  }),
);
