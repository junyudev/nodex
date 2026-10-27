import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexMainConversationManagers } from "../codex-application/CodexMainConversationManagers";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { CodexNativeThreadLookup } from "../codex-application/CodexNativeThreadLookup";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { make, type SessionHistoryInput } from "./SessionObservation";

const input: SessionHistoryInput = { sessionId: "session:a", limit: 1, maxCharsPerItem: 2000 };
const provenance = {
  profile_id: "profile:a",
  authority: {
    thread_id: "thread:caller",
    turn_id: "turn:caller",
    root_thread_id: "thread:caller",
    actor_project_id: "project:caller",
    library_id: "library:a",
    store_epoch: "epoch:a",
    scope: "project",
    source: "project_turn",
  },
} as const;
const at = "2026-10-27T00:00:00.000Z";
const item: AgentTurnItem = {
  id: "item:a",
  threadId: "root:a",
  runId: "run:a",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: at,
  updatedAt: at,
  type: "assistant_message",
  messageId: "message:a",
  text: "Private 😀 transcript",
  streaming: false,
};

type Kind = "runtime" | "native" | "acp" | "draft";
const fixture = (kind: Kind = "runtime") => {
  const calls: string[] = [];
  const state = {
    kind,
    denied: false,
    root: "root:a",
    projectId: "project:target",
    text: item.text,
    executionThread: undefined as string | undefined,
    executionRequests: [] as unknown[],
    provider: "custom-agent-route",
    status: "idle",
    activeRunId: null as string | null,
    latestRunId: "run:a",
    pending: null as { kind: string } | null,
    canonicalStatus: "idle" as "idle" | "active",
    turnStatus: "completed" as "completed" | "inProgress",
    turnId: "turn:a",
    pendingStart: false,
    pendingMethod: "turn/start" as "turn/start" | "turn/steer",
    nativeHasTurn: true,
    causal: false,
    acknowledgements: [] as unknown[],
    afterContent: () => {},
    afterProgress: () => {},
  };
  const content = (format: "text" | "json", offset: number, maxChars: number) => {
    const text = format === "json" ? JSON.stringify(item) : state.text;
    const end = Math.min(offset + maxChars, text.length);
    return {
      reference: {
        itemId: item.id,
        sourceThreadId: item.threadId,
        runId: item.runId,
        type: item.type,
        status: item.status,
        visibility: "local" as const,
        messageId: item.messageId,
        createdBy: "agent",
        creationSource: "mcp",
        senderThreadId: null,
        title: item.title,
        updatedAt: item.updatedAt,
      },
      itemId: item.id,
      sourceThreadId: item.threadId,
      runId: item.runId,
      type: item.type,
      status: item.status,
      updatedAt: item.updatedAt,
      format,
      text: text.slice(offset, end),
      textOffset: offset,
      totalChars: text.length,
      nextTextOffset: end < text.length ? end : null,
      contentVersion: createHash("sha256").update(text).digest("base64url"),
    };
  };
  const owner = make.pipe(
    Effect.provideService(CodexMainConversationManagers, {
      get: () => Effect.die("History does not search native catalogs"),
    } as never),
    Effect.provideService(ExecutionHostRuntime, { activeSshHosts: { value: new Map() } } as never),
    Effect.provideService(CoreModules, {
      workspace: {
        read: (request: unknown, _options: unknown, projectId: string) =>
          Effect.gen(function* () {
            calls.push("authorize");
            assert.deepEqual(request, {
              kind: "agent_session",
              session_id: input.sessionId,
              provenance: state.causal
                ? {
                    ...provenance,
                    authority: {
                      ...provenance.authority,
                      runtime: { runtime_id: "runtime:a", session_id: "caller", turn_kind: "run" },
                    },
                  }
                : provenance,
            });
            assert.equal(projectId, "project:caller");
            if (state.denied) return yield* Effect.fail(new Error("Access denied"));
            return {
              value: {
                kind: "agent_session",
                session: {
                  id: input.sessionId,
                  project_id: state.projectId,
                  display_title: "Target",
                  archived: false,
                  pinned: false,
                  execution_ref:
                    state.kind === "runtime"
                      ? { runtime_id: "runtime:a", thread_id: state.root }
                      : null,
                },
                thread:
                  state.kind === "native" || state.kind === "acp"
                    ? {
                        thread_id: "native:a",
                        execution_host_id: "host:a",
                        updated_at: at,
                        backend_binding: { kind: state.kind === "native" ? "codex" : "acp" },
                        status: { status_type: "idle", active_flags: [] },
                      }
                    : null,
              },
            };
          }),
      },
    } as never),
    Effect.provideService(AgentRuntimeApplication, {
      inspect: (target: unknown) =>
        Effect.gen(function* () {
          calls.push("runtime:inspect");
          assert.deepEqual(target, {
            sessionId: input.sessionId,
            ...(state.executionThread ? { threadId: state.executionThread } : {}),
          });
          assert.deepEqual(
            yield* CoreApplicationAgent,
            state.causal
              ? {
                  ...provenance,
                  authority: {
                    ...provenance.authority,
                    runtime: { runtime_id: "runtime:a", session_id: "caller", turn_kind: "run" },
                  },
                }
              : provenance,
          );
          return {
            threadId: state.executionThread ?? state.root,
            thread: {
              providerInstanceId: state.provider,
              providerDriver: "claude",
              modelSelection: { instanceId: state.provider, model: "model:a" },
              status: state.status,
              activeRunId: state.activeRunId,
              latestRunId: state.latestRunId,
              pendingRuntimeRequest: state.pending,
              updatedAt: at,
            },
          };
        }),
      execution: (request: { runId?: string | null }) =>
        Effect.sync(() => {
          calls.push("runtime:execution");
          state.executionRequests.push(request);
          const selectedRunId = request.runId === undefined ? state.latestRunId : request.runId;
          return {
            selectedRunId,
            runId: selectedRunId,
            status: selectedRunId === null ? null : state.activeRunId ? "running" : "completed",
            continuationPending: false,
            activeFlags: state.pending ? [state.pending.kind] : [],
            revision: JSON.stringify([selectedRunId, state.activeRunId, state.pending]),
          };
        }),
      timeline: (request: unknown) =>
        Effect.sync(() => {
          calls.push("runtime:timeline");
          assert.deepEqual(request, {
            sessionId: input.sessionId,
            ...(state.executionThread ? { threadId: state.executionThread } : {}),
            view: "messages",
            order: "newest_first",
            limit: 1,
          });
          return {
            items: [
              {
                position: 0,
                visibility: "local",
                sourceThreadId: item.threadId,
                sourceItemId: item.id,
                item: {
                  id: item.id,
                  runId: item.runId,
                  type: item.type,
                  status: item.status,
                  updatedAt: item.updatedAt,
                },
              },
            ],
            totalItems: 1,
            hasMore: false,
          };
        }),
      acknowledgeRead: (request: unknown) =>
        Effect.sync(() => {
          state.acknowledgements.push(request);
          return { acknowledged: 1 };
        }),
      itemContent: (request: { format: "text" | "json"; textOffset: number; maxChars: number }) =>
        Effect.sync(() => {
          calls.push("runtime:content");
          state.afterContent();
          return content(request.format, request.textOffset, request.maxChars);
        }),
      progress: () =>
        Effect.sync(() => {
          calls.push("runtime:progress");
          state.afterProgress();
          return {
            latestReply: content("text", 0, 1024),
            latestActivity: {
              itemId: "tool:a",
              sourceThreadId: "root:a",
              runId: "run:a",
              type: "file_change",
              status: "completed",
              updatedAt: at,
            },
          };
        }),
      sessionMetadata: () => Effect.succeed([]),
      readDetails: () =>
        Effect.succeed({ runCount: 0, pendingRequestCount: 0, recentRuns: [], nextOrdinal: null }),
      sessionCatalog: () => Effect.die("Discovery has its own bounded query tests"),
      read: () => Effect.die("Observations must not open UI snapshots"),
      history: () => Effect.die("Observations must not group whole turns"),
    } as never),
    Effect.provideService(CodexNativeThreadLookup, {
      resolve: (threadId: string, hostId: string) =>
        Effect.sync(() => {
          calls.push("native:lookup");
          assert.equal(threadId, "native:a");
          assert.equal(hostId, "host:a");
          return {
            hostId,
            manager: { generation: 1, assertCurrent: () => {} },
            thread: { id: threadId, status: { type: "idle" }, updatedAt: 1 },
          };
        }),
    } as never),
    Effect.provideService(CodexGateway, {
      requestOnHost: (hostId: string, method: string, params: { sortDirection: string }) =>
        Effect.sync(() => {
          if (method === "thread/turns/list") {
            calls.push("native:turns");
            return {
              data: state.nativeHasTurn
                ? [
                    {
                      id: state.turnId,
                      status: state.turnStatus,
                      error: null,
                      startedAt: 1,
                      completedAt: state.turnStatus === "completed" ? 2 : null,
                    },
                  ]
                : [],
              nextCursor: null,
            };
          }
          calls.push(`native:${params.sortDirection}`);
          assert.equal(hostId, "host:a");
          assert.equal(method, "thread/items/list");
          return {
            data: [
              {
                turnId: "native:turn",
                item: {
                  type: "agentMessage",
                  id: "native:item",
                  text: "Native reply",
                  phase: null,
                  memoryCitation: null,
                  delivery: null,
                  questions: null,
                },
                startedAtMs: null,
                completedAtMs: null,
              },
            ],
            nextCursor: null,
            backwardsCursor: "native:inclusive",
          };
        }),
    } as never),
    Effect.provideService(CodexThreadDirectory, {
      resolve: (request: unknown) =>
        Effect.sync(() => {
          calls.push("native:metadata");
          assert.deepEqual(request, { threadId: "native:a", fidelity: "durable" });
          return {
            canonical: {
              threadRuntimeStatus: { type: state.canonicalStatus, activeFlags: [] },
              turns: state.nativeHasTurn
                ? [{ turnId: state.turnId, status: state.turnStatus }]
                : [],
              unconfirmedTurnSubmissions: state.pendingStart
                ? [
                    {
                      requestId: "request:starting",
                      clientUserMessageId: "message:new",
                      method: state.pendingMethod,
                      stage: "outcome-unknown",
                    },
                  ]
                : [],
            },
            snapshot: {
              statusType: "idle",
              statusActiveFlags: [],
              turns: [{ turnId: state.turnId, status: state.turnStatus }],
              requests: [],
            },
          };
        }),
    } as never),
  );
  return { owner, calls, state };
};

it.effect(
  "inspects Runtime control state without reading any transcript and authorizes before backend access",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const owner = yield* f.owner;
      const result = yield* owner.inspect(input.sessionId, provenance);
      assert.equal(result.backend, "claude");
      assert.deepEqual(result.agent, {
        providerInstanceId: "custom-agent-route",
        model: "model:a",
      });
      assert.equal(result.disposition, "complete");
      assert.deepEqual(f.calls, ["authorize", "runtime:inspect", "runtime:execution", "authorize"]);
      f.state.denied = true;
      const before = f.calls.length;
      assert.equal(
        (yield* owner.read(input, provenance).pipe(Effect.flip)).reason,
        "authorization",
      );
      assert.deepEqual(f.calls.slice(before), ["authorize"]);
    }),
);

it.effect("routes history by the target binding for Runtime and native Codex Sessions", () =>
  Effect.gen(function* () {
    const runtime = fixture("runtime");
    const runtimeOwner = yield* runtime.owner;
    const result = yield* runtimeOwner.read(input, provenance);
    assert.equal(result.threadId, "root:a");
    assert.equal(result.projectId, "project:target");
    assert.equal(result.history.availability, "available");
    if (result.history.availability === "available")
      assert.deepEqual(result.history.items[0]?.content, {
        format: "text",
        text: item.text,
        offset: 0,
        totalChars: item.text.length,
        nextCursor: null,
      });
    assert.deepEqual(runtime.calls, [
      "authorize",
      "runtime:inspect",
      "runtime:timeline",
      "runtime:content",
      "authorize",
    ]);
    const native = fixture("native");
    const nativeOwner = yield* native.owner;
    const nativeResult = yield* nativeOwner.read(input, provenance);
    assert.equal(nativeResult.backend, "codex");
    assert.equal(nativeResult.threadId, "native:a");
    assert.deepEqual(native.calls, [
      "authorize",
      "native:lookup",
      "native:lookup",
      "native:turns",
      "native:desc",
      "authorize",
    ]);
  }),
);

it.effect("discards content after execution rebinding or revoked access", () =>
  Effect.gen(function* () {
    for (const change of ["binding", "access"] as const) {
      const f = fixture();
      f.state.afterContent = () => {
        if (change === "binding") f.state.root = "root:replacement";
        else f.state.denied = true;
      };
      const owner = yield* f.owner;
      const error = yield* owner.read(input, provenance).pipe(Effect.flip);
      assert.equal(error.reason, change === "binding" ? "authority_changed" : "authorization");
      assert.equal(f.calls.at(-1), "authorize");
    }
  }),
);

it.effect(
  "distinguishes empty drafts and unavailable unbound histories without creating a backend",
  () =>
    Effect.gen(function* () {
      for (const kind of ["draft", "acp"] as const) {
        const f = fixture(kind);
        const owner = yield* f.owner;
        const result = yield* owner.read(input, provenance);
        assert.deepEqual(
          result.history,
          kind === "draft"
            ? { availability: "empty", items: [] }
            : { availability: "unavailable", reason: "backend_not_loaded", items: [] },
        );
        const inspected = yield* owner.inspect(input.sessionId, provenance);
        assert.equal(inspected.disposition, kind === "draft" ? "complete" : "unavailable");
        assert.isTrue(f.calls.every((call) => call === "authorize"));
      }
    }),
);

it.effect(
  "keeps inspection cursors stable and distinguishes new Runtime Runs and pending requests",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const owner = yield* f.owner;
      const first = yield* owner.inspect(input.sessionId, provenance);
      assert.equal((yield* owner.inspect(input.sessionId, provenance)).cursor, first.cursor);
      f.state.latestRunId = "run:next";
      f.state.activeRunId = "run:next";
      const running = yield* owner.inspect(input.sessionId, provenance);
      assert.equal(running.disposition, "running");
      assert.notEqual(running.cursor, first.cursor);
      f.state.pending = { kind: "user_input" };
      const attention = yield* owner.inspect(input.sessionId, provenance);
      assert.equal(attention.disposition, "needs_attention");
      assert.notEqual(attention.cursor, running.cursor);
    }),
);

it.effect("uses native canonical Turn completion while runtime status becomes idle", () =>
  Effect.gen(function* () {
    const f = fixture("native");
    f.state.canonicalStatus = "active";
    f.state.turnStatus = "inProgress";
    const owner = yield* f.owner;
    const active = yield* owner.inspect(input.sessionId, provenance);
    assert.equal(active.disposition, "running");
    f.state.canonicalStatus = "idle";
    const settling = yield* owner.inspect(input.sessionId, provenance);
    assert.equal(settling.status, "inProgress");
    assert.equal(settling.disposition, "running");
    assert.equal(settling.cursor, active.cursor);
    f.state.turnStatus = "completed";
    const completed = yield* owner.inspect(input.sessionId, provenance);
    assert.equal(completed.disposition, "complete");
    assert.notEqual(completed.cursor, settling.cursor);
    assert.isTrue(f.calls.includes("native:turns"));
  }),
);

it.effect("returns compact progress without history and reauthorizes it before delivery", () =>
  Effect.gen(function* () {
    const f = fixture();
    const owner = yield* f.owner;
    const progress = yield* owner.progress(input.sessionId, provenance);
    assert.equal(progress.availability, "available");
    assert.equal(progress.coverage, "complete");
    assert.equal(progress.latestMessage?.content.format, "text");
    assert.deepEqual(progress.latestTool, {
      id: "tool:a",
      runId: "run:a",
      type: "file_change",
      status: "completed",
    });
    assert.deepEqual(f.calls, ["authorize", "runtime:inspect", "runtime:progress", "authorize"]);
    f.state.afterProgress = () => {
      f.state.denied = true;
    };
    assert.equal(
      (yield* owner.progress(input.sessionId, provenance).pipe(Effect.flip)).reason,
      "authorization",
    );
  }),
);

it.effect(
  "keeps accepted native starts running until the new Turn is published, while explicit old Turns stay complete",
  () =>
    Effect.gen(function* () {
      for (const hasOldTurn of [true, false]) {
        const f = fixture("native");
        f.state.nativeHasTurn = hasOldTurn;
        f.state.pendingStart = true;
        const owner = yield* f.owner;
        const starting = yield* owner.inspect(input.sessionId, provenance);
        assert.equal(starting.disposition, "running");
        assert.equal(starting.status, "starting");
        assert.equal(starting.runId, null);
        assert.isTrue(starting.selectionPending);
        if (hasOldTurn) {
          const old = yield* owner.inspect(input.sessionId, provenance, "turn:a");
          assert.equal(old.disposition, "complete");
          assert.equal(old.runId, "turn:a");
          assert.isUndefined(old.selectionPending);
        }
        f.state.pendingStart = false;
        f.state.nativeHasTurn = true;
        f.state.turnId = "turn:new";
        f.state.turnStatus = "inProgress";
        const published = yield* owner.inspect(input.sessionId, provenance);
        assert.equal(published.disposition, "running");
        assert.equal(published.selectedRunId, "turn:new");
        assert.isUndefined(published.selectionPending);
      }
    }),
);

it.effect("keeps a native steering admission attached to its existing Turn", () =>
  Effect.gen(function* () {
    const f = fixture("native");
    f.state.pendingStart = true;
    f.state.pendingMethod = "turn/steer";
    f.state.turnStatus = "inProgress";
    const owner = yield* f.owner;
    const active = yield* owner.inspect(input.sessionId, provenance);
    assert.equal(active.selectedRunId, "turn:a");
    assert.equal(active.disposition, "running");
    assert.isUndefined(active.selectionPending);
    f.state.turnStatus = "completed";
    const completed = yield* owner.inspect(input.sessionId, provenance, active.selectedRunId);
    assert.equal(completed.selectedRunId, "turn:a");
    assert.equal(completed.disposition, "complete");
    assert.isUndefined(completed.selectionPending);
    const latest = yield* owner.inspect(input.sessionId, provenance);
    assert.equal(latest.disposition, "complete");
    assert.isUndefined(latest.selectionPending);
  }),
);

it.effect(
  "keeps the Core Session identity while reading and observing an authorized child execution",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      f.state.executionThread = "child:a";
      const owner = yield* f.owner;
      const execution = { threadId: "child:a" };
      const result = yield* owner.read({ ...input, execution }, provenance);
      assert.equal(result.sessionId, input.sessionId);
      assert.equal(result.threadId, "child:a");
      const inspected = yield* owner.inspect(input.sessionId, provenance, undefined, execution);
      assert.deepEqual(inspected.execution, execution);
      assert.deepEqual(f.state.executionRequests[0], {
        sessionId: input.sessionId,
        threadId: "child:a",
      });
      const other = fixture("native");
      const rejected = yield* (yield* other.owner)
        .read({ ...input, execution }, provenance)
        .pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      if (rejected._tag === "Failure") assert.equal(rejected.failure.reason, "authorization");
      assert.deepEqual(other.calls, ["authorize"]);
    }),
);

it.effect("reports a point miss for a draft without starting an execution source", () =>
  Effect.gen(function* () {
    const f = fixture("draft");
    const result = yield* (yield* f.owner)
      .read({ ...input, itemId: "missing" }, provenance)
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "item_unavailable");
    assert.deepEqual(f.calls, ["authorize"]);
  }),
);

it.effect("forwards only admitted child ranges for the canonical Runtime coverage owner", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.state.causal = true;
    const owner = yield* f.owner;
    const causal = {
      ...provenance,
      authority: {
        ...provenance.authority,
        runtime: { runtime_id: "runtime:a", session_id: "caller", turn_kind: "run" as const },
      },
    };
    const partial = yield* owner.read({ ...input, itemId: item.id, maxCharsPerItem: 5 }, causal);
    assert.equal(f.state.acknowledgements.length, 1);
    if (partial.history.availability !== "available")
      return assert.fail("Expected available history");
    yield* owner.read({ ...input, cursor: partial.history.items[0]!.content.nextCursor! }, causal);
    assert.equal(f.state.acknowledgements.length, 2);
    yield* owner.read({ ...input, itemId: item.id }, causal);
    assert.deepEqual(
      f.state.acknowledgements,
      [
        { offset: 0, length: 5 },
        { offset: 5, length: item.text.length - 5 },
        { offset: 0, length: item.text.length },
      ].map((range) => ({
        sessionId: input.sessionId,
        items: [
          {
            itemId: item.id,
            sourceThreadId: item.threadId,
            format: "text",
            contentVersion: createHash("sha256").update(item.text).digest("base64url"),
            ...range,
            totalChars: item.text.length,
          },
        ],
      })),
    );
  }),
);

it.effect("uses the complete canonical JSON item as child-result evidence", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.state.causal = true;
    const owner = yield* f.owner;
    const causal = {
      ...provenance,
      authority: {
        ...provenance.authority,
        runtime: { runtime_id: "runtime:a", session_id: "caller", turn_kind: "run" as const },
      },
    };
    yield* owner.read({ ...input, itemId: item.id, view: "activity" }, causal);
    assert.deepEqual(f.state.acknowledgements, [
      {
        sessionId: input.sessionId,
        items: [
          {
            itemId: item.id,
            sourceThreadId: item.threadId,
            format: "json",
            contentVersion: createHash("sha256").update(JSON.stringify(item)).digest("base64url"),
            offset: 0,
            length: JSON.stringify({ source: "runtime", item }).length,
            totalChars: JSON.stringify({ source: "runtime", item }).length,
          },
        ],
      },
    ]);
  }),
);

it.effect(
  "does not record read evidence when a concurrent Project move makes the final envelope too large",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      f.state.causal = true;
      f.state.text = "bounded result ".repeat(10000);
      f.state.afterContent = () => {
        f.state.projectId = `project:${"x".repeat(500)}`;
      };
      const owner = yield* f.owner;
      const causal = {
        ...provenance,
        authority: {
          ...provenance.authority,
          runtime: { runtime_id: "runtime:a", session_id: "caller", turn_kind: "run" as const },
        },
      };
      const result = yield* owner
        .read({ ...input, itemId: item.id, maxCharsPerItem: 50000 }, causal)
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "source_limit");
      assert.equal(f.state.acknowledgements.length, 0);
    }),
);
