import type { ThreadGoal, ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import {
  CodexGateway,
  CodexThreadHostResolver,
  type CodexGatewayRequestOptions,
} from "../codex-runtime/CodexGateway";
import { createCodexAppServerCapabilitySnapshot } from "../codex-runtime/CodexAppServerCapabilities";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexMainConversationHistory } from "./CodexMainConversationHistory";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexResumeIngress, make as makeIngress } from "./CodexResumeIngress";
import { make, MainConversationResumeError } from "./CodexMainConversationResume";
import { ConversationEntityMap, live as entityLayer } from "./internal/ConversationEntityMap";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { buildAgentActivityV2CorpusThread } from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import type { ConversationStreamRole } from "../../shared/codex-conversation-stream";
import type { CodexApplicationProtocolOccurrence } from "../codex-runtime/CodexApplicationRequestInbox";

type Phase = "metadata" | "workspace" | "prepare" | "native" | "accept";

const pendingInputOccurrence = (): CodexApplicationProtocolOccurrence => ({
  kind: "request",
  protocol: "generated",
  hostId: "local",
  generation: 1,
  occurrenceId: "pending-replay",
  occurrenceToken: 10,
  requestId: 10,
  method: "item/tool/requestUserInput",
  params: { threadId: "thread", turnId: "turn" },
});

const build = Effect.fn("MainResumeTest.build")(function* (
  options: {
    hostId?: string;
    supportsPaginatedHistory?: boolean;
    selectedPaginated?: boolean;
    tailHydration?: boolean;
  } = {},
) {
  const hostId = options.hostId ?? "local";
  const entities = Context.get(
    yield* Layer.buildWithScope(entityLayer, yield* Scope.Scope),
    ConversationEntityMap,
  );
  const ingress = yield* makeIngress;
  const entity = entities.entity("thread");
  entity.installFollowerCanonicalState({
    ...conversationFixture("thread"),
    resumeState: "needs_resume",
  });
  const metadata = {
    ...buildAgentActivityV2CorpusThread([]),
    id: "thread",
    turns: [],
    historyMode: options.selectedPaginated === false ? ("legacy" as const) : ("paginated" as const),
  };
  const permissions = {
    approvalPolicy: "on-request" as const,
    approvalsReviewer: "user" as const,
    sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
    activePermissionProfile: null,
    runtimeWorkspaceRoots: ["/workspace/project"],
  };
  const response: ThreadResumeResponse = {
    thread: metadata,
    model: "gpt-test",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/workspace/project",
    ...permissions,
    sandbox: permissions.sandboxPolicy,
    instructionSources: [],
    reasoningEffort: "high",
    multiAgentMode: "explicitRequestOnly",
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
    initialTurnsPage: null,
  };
  const hooks: Partial<
    Record<
      Phase,
      Effect.Effect<void, MainConversationResumeError | ReturnType<typeof codexRuntimeError>>
    >
  > = {};
  const events: string[] = [];
  const requests: { method: string; options: CodexGatewayRequestOptions }[] = [];
  const historyRequestOptions: (CodexGatewayRequestOptions | undefined)[] = [];
  const acceptedResumeInputs: Parameters<
    CodexThreadDirectory["Service"]["acceptResumeResult"]
  >[0][] = [];
  const resets = new Set<() => void>();
  let connected = true;
  let generation = 1;
  let role: ConversationStreamRole | null = null;
  let goalRequest: () => Effect.Effect<
    { goal: ThreadGoal | null },
    ReturnType<typeof codexRuntimeError>
  > = () => Effect.succeed({ goal: null });
  let loadHistory: () => Effect.Effect<number> = () => Effect.succeed(2);
  const before = (phase: Phase) =>
    Effect.suspend(() => {
      events.push(phase);
      return hooks[phase] ?? Effect.void;
    });
  const manager = {
    hostId,
    get generation() {
      return generation;
    },
    assertCurrent(expected?: number) {
      if (!connected || (expected !== undefined && expected !== generation))
        throw new Error("Native connection retired");
    },
    onConnectionReset(callback: () => void) {
      resets.add(callback);
      return {
        [Symbol.dispose]() {
          resets.delete(callback);
        },
      };
    },
    stream: {
      getRole: () => role,
      setRole(_id: string, next: ConversationStreamRole | null) {
        role = next;
      },
      setFollowing() {
        events.push("follow");
      },
      broadcastSnapshot() {
        events.push("broadcast");
      },
    },
  };
  const gateway = {
    requestOnHost(
      _host: string,
      method: string,
      _params: unknown,
      options: CodexGatewayRequestOptions,
    ) {
      requests.push({ method, options });
      assert.strictEqual(options.expectedHostId, hostId);
      assert.strictEqual(options.expectedGeneration, generation);
      if (method === "thread/read") return before("metadata").pipe(Effect.as({ thread: metadata }));
      if (method === "thread/resume") return before("native").pipe(Effect.as(response));
      assert.strictEqual(method, "thread/goal/get");
      return Effect.suspend(() => {
        events.push("goal");
        return goalRequest();
      });
    },
  } as unknown as CodexGateway["Service"];
  const directory = {
    resolve: () =>
      Effect.succeed({ durable: { archived: false }, snapshot: entity.readSnapshot() }),
    prepareHistoryHydration: () =>
      before("workspace").pipe(
        Effect.as({
          summary: { threadId: "thread" },
          context: {
            hostId,
            model: "gpt-test",
            reasoningEffort: "high",
            cwd: "/workspace/project",
            ...permissions,
          },
        }),
      ),
    prepareResume: () =>
      before("prepare").pipe(
        Effect.map(() => ({
          requestedCwd: null,
          permissionContext: {
            requestedPermissions: permissions,
            runtimeWorkspaceRootCandidates: permissions.runtimeWorkspaceRoots,
          },
          params: {
            threadId: "thread",
            excludeTurns: options.tailHydration !== false,
            ...(options.selectedPaginated === false
              ? { initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" } }
              : {}),
          },
          summary: { threadId: "thread" },
          capability: createCodexAppServerCapabilitySnapshot({
            hostId,
            generation,
            userAgent: options.supportsPaginatedHistory === false ? "codex/0.0.0" : "codex/0.148.0",
          }),
        })),
      ),
    acceptResumeResult: (
      input: Parameters<CodexThreadDirectory["Service"]["acceptResumeResult"]>[0],
    ) =>
      before("accept").pipe(
        Effect.map(() => {
          acceptedResumeInputs.push(input);
          historyRequestOptions.push(input.requestOptions);
          entity.setResumeState("resumed");
          return { snapshot: entity.readSnapshot() };
        }),
      ),
  } as unknown as CodexThreadDirectory["Service"];
  const service = yield* make.pipe(
    Effect.provideService(ConversationEntityMap, entities),
    Effect.provideService(CodexResumeIngress, ingress),
    Effect.provideService(CodexGateway, gateway),
    Effect.provideService(CodexThreadDirectory, directory),
    Effect.provideService(CodexThreadHostResolver, { resolve: () => Effect.succeed(hostId) }),
    Effect.provideService(CodexMainConversationHistory, {
      loadComplete: (requestedHostId, threadId) =>
        Effect.suspend(() => {
          assert.strictEqual(requestedHostId, hostId);
          assert.strictEqual(threadId, "thread");
          events.push("drain");
          return loadHistory();
        }),
    }),
    Effect.provideService(CodexMainConversationManagers, {
      get: () => Effect.succeed(manager),
      current: () => manager,
    } as unknown as CodexMainConversationManagers["Service"]),
  );
  return {
    service,
    entity,
    entities,
    ingress,
    events,
    requests,
    historyRequestOptions,
    acceptedResumeInputs,
    hooks,
    resets,
    manager,
    metadata,
    setRole(next: ConversationStreamRole | null) {
      role = next;
    },
    setGoalRequest(next: typeof goalRequest) {
      goalRequest = next;
    },
    setHistoryLoad(next: typeof loadHistory) {
      loadHistory = next;
    },
    setOlderCursor(cursor: string | null) {
      entity.mutateCanonicalState((draft) => {
        draft.turnsPagination = {
          olderCursor: cursor,
          oldestLoadedTurnId: null,
          isLoadingOlder: false,
          hasLoadedOldest: cursor === null,
        };
      }, 1);
    },
    reset() {
      connected = false;
      for (const callback of resets) callback();
      role = null;
      entity.setResumeState("needs_resume");
      entity.setStreaming(false);
    },
    restore() {
      generation++;
      connected = true;
    },
  };
});

it.effect("captures the environment selection immediately before native resume dispatch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* build();
      f.entity.mutateCanonicalState((draft) => {
        draft.environments = [
          { environmentId: "old", cwd: "/old", runtimeWorkspaceRoots: ["/old"] },
        ];
        draft.environmentSelectionEvidence = { source: "live", updatedAt: 10 };
      }, 10_000);
      f.hooks.native = Effect.sync(() => {
        f.entity.mutateCanonicalState((draft) => {
          draft.environments = [
            { environmentId: "newer", cwd: "/newer", runtimeWorkspaceRoots: ["/newer"] },
          ];
          draft.environmentSelectionEvidence = { source: "live", updatedAt: 12 };
        }, 12_000);
      });

      assert.strictEqual((yield* f.service.resume("thread")).status, "ready");
      assert.deepEqual(f.acceptedResumeInputs[0]?.environmentSelectionEvidenceAtDispatch, {
        source: "live",
        updatedAt: 10,
      });
      assert.deepEqual(f.entity.readCanonicalState()?.environments, [
        { environmentId: "newer", cwd: "/newer", runtimeWorkspaceRoots: ["/newer"] },
      ]);
    }),
  ),
);

it.effect.each([false, true])(
  "preserves request scheduling for reconnect recovery %s",
  (recovery) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* build();
        assert.strictEqual(
          (yield* f.service.resume("thread", { isReconnectRecovery: recovery })).status,
          "ready",
        );
        yield* TestClock.adjust(0);
        const metadata = f.requests.find((entry) => entry.method === "thread/read")!.options;
        const resume = f.requests.find((entry) => entry.method === "thread/resume")!.options;
        const goal = f.requests.find((entry) => entry.method === "thread/goal/get")!.options;
        assert.strictEqual(metadata.priority, recovery ? "interactive" : "critical");
        assert.strictEqual(metadata.timeoutMs, 30_000);
        assert.strictEqual(resume.priority, recovery ? "interactive" : "critical");
        assert.strictEqual(resume.timeoutMs, recovery ? 30_000 : 120_000);
        assert.deepEqual(f.historyRequestOptions, [
          { source: "thread_hydration", priority: recovery ? "interactive" : "critical" },
        ]);
        assert.strictEqual(goal.priority, recovery ? "interactive" : undefined);
        assert.strictEqual(goal.source, recovery ? "thread_hydration" : undefined);
      }),
    ),
);

it.effect("drains a legacy tail only after publication and deferred goal hydration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* build({ supportsPaginatedHistory: false, selectedPaginated: false });
      const goal = yield* Deferred.make<{ goal: ThreadGoal | null }>();
      const drainStarted = yield* Deferred.make<void>();
      f.setOlderCursor("older");
      f.setGoalRequest(() => Deferred.await(goal));
      f.setHistoryLoad(() =>
        Deferred.succeed(drainStarted, undefined).pipe(Effect.andThen(Effect.never)),
      );
      assert.strictEqual((yield* f.service.resume("thread")).status, "ready");
      assert.include(f.events, "broadcast");
      assert.notInclude(f.events, "drain");
      yield* Deferred.succeed(goal, { goal: null });
      yield* Deferred.await(drainStarted);
      assert.strictEqual(f.events.filter((event) => event === "drain").length, 1);
      assert.isBelow(f.events.indexOf("broadcast"), f.events.indexOf("drain"));
    }),
  ),
);

it.effect.each([
  { reason: "durable host", hostId: "durable" },
  { reason: "full hydration", tailHydration: false },
  { reason: "paginated selection", selectedPaginated: true },
  { reason: "host pagination suppression", supportsPaginatedHistory: true },
  { reason: "product opt-out", drainRemainingHistory: false },
  { reason: "reconnect recovery", isReconnectRecovery: true },
  { reason: "exhausted history", olderCursor: null },
])("does not automatically drain during $reason", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* build({
        supportsPaginatedHistory: false,
        selectedPaginated: false,
        ...scenario,
      });
      const olderCursor = "olderCursor" in scenario ? scenario.olderCursor : undefined;
      f.setOlderCursor(olderCursor === undefined ? "older" : olderCursor);
      yield* f.service.resume("thread", scenario);
      yield* TestClock.adjust(0);
      assert.notInclude(f.events, "drain");
    }),
  ),
);

it.effect.each(["success", "failed goal", "newer goal"] as const)(
  "retains legacy drain eligibility after %s",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* build({ supportsPaginatedHistory: false, selectedPaginated: false });
        const goal = yield* Deferred.make<
          { goal: ThreadGoal | null },
          ReturnType<typeof codexRuntimeError>
        >();
        const drained = yield* Deferred.make<void>();
        f.setOlderCursor("older");
        f.setGoalRequest(() => Deferred.await(goal));
        f.setHistoryLoad(() => Deferred.succeed(drained, undefined).pipe(Effect.as(2)));
        yield* f.service.resume("thread");
        if (outcome === "newer goal") {
          f.entity.mutateCanonicalState((draft) => {
            draft.threadGoal = {
              threadId: "thread",
              objective: "live",
              status: "paused",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1,
            };
          }, 2);
        }
        if (outcome === "failed goal")
          yield* Deferred.fail(
            goal,
            codexRuntimeError({ operation: "request", reason: "request", retryable: false }),
          );
        else yield* Deferred.succeed(goal, { goal: null });
        yield* Deferred.await(drained);
        if (outcome === "newer goal")
          assert.strictEqual(f.entity.readCanonicalState()?.threadGoal?.objective, "live");
      }),
    ),
);

it.effect.each(["reset", "retirement", "superseded"] as const)(
  "does not drain a legacy tail after hydration %s",
  (reason) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* build({ supportsPaginatedHistory: false, selectedPaginated: false });
        const goal = yield* Deferred.make<{ goal: ThreadGoal | null }>();
        f.setOlderCursor("older");
        f.setGoalRequest(() => Deferred.await(goal));
        yield* f.service.resume("thread");
        if (reason === "reset") f.reset();
        if (reason === "retirement") yield* f.entities.retire("thread");
        if (reason === "superseded") {
          f.entity.setResumeState("needs_resume");
          f.setGoalRequest(() => Effect.never);
          yield* f.service.resume("thread");
        }
        yield* Deferred.succeed(goal, { goal: null });
        yield* TestClock.adjust(0);
        assert.notInclude(f.events, "drain");
      }),
    ),
);

it.effect(
  "waits for the recovering owner's document without rewriting readiness or dispatching native work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* build();
        f.setRole({ role: "follower", ownerClientId: "window" });
        f.entity.setResumeState("resuming");
        assert.deepEqual(yield* f.service.resume("thread"), {
          status: "not-ready",
          reason: "owner-recovering",
        });
        assert.strictEqual(f.entity.readResumeState(), "resuming");
        assert.deepEqual(f.events, []);
        f.entity.installFollowerCanonicalState(conversationFixture("thread"));
        yield* f.service.resume("thread");
        assert.deepEqual(f.events, []);
        assert.strictEqual(f.entity.readResumeState(), "resumed");
      }),
    ),
);

it.effect(
  "uses a received owner snapshot while preparation is pending without acquiring ownership",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* build();
        f.hooks.prepare = Effect.sync(() => {
          assert.isNull(f.manager.stream.getRole());
          f.setRole({ role: "follower", ownerClientId: "window" });
          f.entity.installFollowerCanonicalState(
            conversationFixture("thread", [turnFixture("remote")]),
          );
        });
        yield* f.service.resume("thread");
        assert.deepEqual(f.events, ["follow", "metadata", "workspace", "prepare"]);
        assert.deepEqual(f.manager.stream.getRole(), { role: "follower", ownerClientId: "window" });
        assert.deepEqual(
          residentConversationTurns(f.entity.readCanonicalState()).map((t) => t.turnId),
          ["remote"],
        );
        assert.isFalse(f.ingress.has("thread"));
        assert.strictEqual(f.resets.size, 0);
      }),
    ),
);

it.effect(
  "claims ownership only after preparation and publishes after native ingress is replayed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* build();
        f.hooks.prepare = Effect.sync(() => assert.isNull(f.manager.stream.getRole()));
        f.hooks.native = Effect.sync(() =>
          assert.deepEqual(f.manager.stream.getRole(), { role: "owner" }),
        );
        yield* f.service.resume("thread");
        assert.deepEqual(f.events.slice(0, 6), [
          "follow",
          "metadata",
          "workspace",
          "prepare",
          "native",
          "accept",
        ]);
        assert.strictEqual(f.events.at(-1), "broadcast");
        assert.strictEqual(f.entity.readResumeState(), "resumed");
        const count = f.events.length;
        yield* f.service.resume("thread");
        assert.strictEqual(f.events.length, count);
      }),
    ),
);

it.effect.each(["workspace", "prepare", "native", "accept"] as const)(
  "retires the complete resume operation on connection reset during %s",
  (phase) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* build();
        const started = yield* Deferred.make<void>();
        f.hooks[phase] = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        const running = yield* f.service.resume("thread").pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        f.reset();
        const result = yield* Fiber.join(running);
        assert.strictEqual(result._tag, "Failure");
        assert.isFalse(f.ingress.has("thread"));
        assert.strictEqual(f.resets.size, 0);
        assert.strictEqual(f.entity.readResumeState(), "needs_resume");
        assert.notInclude(f.events, "broadcast");
        delete f.hooks[phase];
        f.restore();
        yield* f.service.resume("thread");
        assert.strictEqual(f.entity.readResumeState(), "resumed");
      }),
    ),
);

it.effect.each(["prepare", "accept"] as const)(
  "conversation removal interrupts %s and cannot recreate or overwrite a replacement",
  (phase) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* build();
        const started = yield* Deferred.make<void>();
        f.hooks[phase] = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        const running = yield* f.service.resume("thread").pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        yield* f.entities.retire("thread");
        const replacement = f.entities.entity("thread");
        replacement.installFollowerCanonicalState(
          conversationFixture("thread", [turnFixture("replacement")]),
        );
        const result = yield* Fiber.join(running);
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(f.entities.current("thread"), replacement);
        assert.strictEqual(replacement.readResumeState(), "resumed");
        assert.deepEqual(
          residentConversationTurns(replacement.readCanonicalState()).map((t) => t.turnId),
          ["replacement"],
        );
        assert.isFalse(f.ingress.has("thread"));
        assert.strictEqual(f.resets.size, 0);
        assert.notInclude(f.events, "broadcast");
      }),
    ),
);

it.effect.each([false, true])(
  "failed preparation preserves another owner's snapshot (snapshot arrives: %s)",
  (receivesOwner) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* build();
        f.hooks.prepare = Effect.suspend(() => {
          if (receivesOwner) {
            f.setRole({ role: "follower", ownerClientId: "window" });
            f.entity.installFollowerCanonicalState(conversationFixture("thread"));
          }
          return Effect.fail(
            new MainConversationResumeError({
              threadId: "thread",
              cause: new Error("preparation failed"),
            }),
          );
        });
        const result = yield* f.service.resume("thread").pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(f.entity.readResumeState(), receivesOwner ? "resumed" : "needs_resume");
        assert.isFalse(f.ingress.has("thread"));
        assert.strictEqual(f.resets.size, 0);
      }),
    ),
);

it.effect("manager retirement interrupts the actual native resume retry delay", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* build();
      f.hooks.native = Effect.fail(
        codexRuntimeError({
          operation: "request",
          method: "thread/resume",
          reason: "request",
          retryable: false,
          cause: new Error(
            "thread thread is closing; retry thread/resume after the thread is closed",
          ),
        }),
      );
      const running = yield* f.service.resume("thread").pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust(749);
      assert.strictEqual(f.events.filter((e) => e === "native").length, 1);
      f.reset();
      assert.strictEqual((yield* Fiber.join(running))._tag, "Failure");
      yield* TestClock.adjust(30_000);
      assert.strictEqual(f.events.filter((e) => e === "native").length, 1);
      assert.strictEqual(f.resets.size, 0);
    }),
  ),
);

it.effect("hydrates before replaying interleaved ingress without duplicating hydrated text", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* build();
      const turn = turnFixture("turn", "inProgress");
      const delivered: string[] = [];
      f.hooks.accept = Effect.sync(() => {
        const events: CodexApplicationProtocolOccurrence[] = [
          {
            kind: "notification",
            protocol: "generated",
            hostId: "local",
            generation: 1,
            occurrenceId: "delta",
            occurrenceToken: 1,
            method: "item/agentMessage/delta",
            params: { threadId: "thread", turnId: "turn", itemId: "message", delta: "hello" },
          },
          {
            kind: "request",
            protocol: "generated",
            hostId: "local",
            generation: 1,
            occurrenceId: "request",
            occurrenceToken: 2,
            requestId: 9,
            method: "item/tool/requestUserInput",
            params: { threadId: "thread", turnId: "turn" },
          },
        ];
        for (const occurrence of events)
          f.ingress.offer("thread", {
            occurrence,
            replay: (event) =>
              Effect.sync(() => {
                delivered.push(event.kind);
                return false;
              }),
            reject: () => Effect.die("must not reject"),
          });
        f.entity.installFollowerCanonicalState(
          conversationFixture("thread", [
            {
              ...turn,
              items: [
                {
                  type: "agentMessage",
                  id: "message",
                  text: "hello",
                  phase: null,
                  memoryCitation: null,
                  delivery: null,
                  questions: null,
                },
              ],
            },
          ]),
        );
      });
      yield* f.service.resume("thread");
      assert.deepEqual(delivered, ["request"]);
      assert.isFalse(f.ingress.has("thread"));
      const item = residentConversationTurns(f.entity.readCanonicalState())[0]?.items[0];
      assert.strictEqual(item?.type === "agentMessage" ? item.text : null, "hello");
    }),
  ),
);

it.effect(
  "goal hydration tolerates unrelated changes but not newer goals or superseding hydration",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* build();
        const goal: ThreadGoal = {
          threadId: "thread",
          objective: "saved",
          status: "paused",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        };
        const first = yield* Deferred.make<{ goal: ThreadGoal | null }>();
        f.setGoalRequest(() => Deferred.await(first));
        yield* f.service.resume("thread");
        f.entity.mutateCanonicalState((draft) => {
          draft.title = "updated";
        }, 2);
        yield* Deferred.succeed(first, { goal });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.deepEqual(f.entity.readCanonicalState()?.threadGoal, goal);
        const second = yield* Deferred.make<{ goal: ThreadGoal | null }>();
        f.entity.setResumeState("needs_resume");
        f.setGoalRequest(() => Deferred.await(second));
        yield* f.service.resume("thread");
        const newer = { ...goal, objective: "live update" };
        f.entity.mutateCanonicalState((draft) => {
          draft.threadGoal = newer;
        }, 3);
        yield* Deferred.succeed(second, { goal: null });
        yield* Effect.yieldNow;
        assert.deepEqual(f.entity.readCanonicalState()?.threadGoal, newer);
        const third = yield* Deferred.make<{ goal: ThreadGoal | null }>();
        const fourth = yield* Deferred.make<{ goal: ThreadGoal | null }>();
        f.entity.setResumeState("needs_resume");
        f.setGoalRequest(() => Deferred.await(third));
        yield* f.service.resume("thread");
        f.entity.setResumeState("needs_resume");
        f.setGoalRequest(() => Deferred.await(fourth));
        yield* f.service.resume("thread");
        yield* Deferred.succeed(third, { goal });
        yield* Effect.yieldNow;
        assert.deepEqual(f.entity.readCanonicalState()?.threadGoal, newer);
        yield* Deferred.succeed(fourth, { goal: null });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.isNull(f.entity.readCanonicalState()?.threadGoal);
      }),
    ),
);

it.effect("a reset interrupts buffered replay before its old delivery can finish", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* build();
      const replayStarted = yield* Deferred.make<void>();
      const finishReplay = yield* Deferred.make<void>();
      let replayFinished = false;
      f.hooks.accept = Effect.sync(() => {
        f.ingress.offer("thread", {
          occurrence: pendingInputOccurrence(),
          replay: () =>
            Deferred.succeed(replayStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishReplay)),
              Effect.andThen(
                Effect.sync(() => {
                  replayFinished = true;
                  return false;
                }),
              ),
            ),
          reject: () => Effect.void,
        });
      });
      const running = yield* f.service.resume("thread").pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(replayStarted);
      yield* Effect.yieldNow;
      f.reset();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      const settledBeforeRelease = running.pollUnsafe() !== undefined;
      yield* Deferred.succeed(finishReplay, undefined);
      assert.strictEqual((yield* Fiber.join(running))._tag, "Failure");
      assert.isTrue(settledBeforeRelease);
      assert.isFalse(replayFinished);
      assert.notInclude(f.events, "broadcast");
    }),
  ),
);

it.effect("a synchronous reset during replay cancels the delivery before resume settles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* build();
      const finishReplay = yield* Deferred.make<void>();
      let replayFinished = false;
      let rejected = false;
      f.hooks.accept = Effect.sync(() => {
        f.ingress.offer("thread", {
          occurrence: pendingInputOccurrence(),
          replay: () =>
            Effect.sync(() => f.reset()).pipe(
              Effect.andThen(Deferred.await(finishReplay)),
              Effect.andThen(
                Effect.sync(() => {
                  replayFinished = true;
                  return false;
                }),
              ),
            ),
          reject: () =>
            Effect.sync(() => {
              rejected = true;
            }),
        });
      });
      const running = yield* f.service.resume("thread").pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      const settledBeforeRelease = running.pollUnsafe() !== undefined;
      const rejectedBeforeRelease = rejected;
      yield* Deferred.succeed(finishReplay, undefined);
      assert.strictEqual((yield* Fiber.join(running))._tag, "Failure");
      assert.isTrue(settledBeforeRelease);
      assert.isTrue(rejectedBeforeRelease);
      assert.isFalse(replayFinished);
      assert.notInclude(f.events, "broadcast");
    }),
  ),
);

it.effect("a successor waits for failed resume cleanup before checking readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* build();
      const cleanupStarted = yield* Deferred.make<void>();
      const finishCleanup = yield* Deferred.make<void>();
      f.hooks.native = Effect.suspend(() => {
        f.ingress.offer("thread", {
          occurrence: pendingInputOccurrence(),
          replay: () => Effect.succeed(false),
          reject: () =>
            Deferred.succeed(cleanupStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishCleanup)),
            ),
        });
        return Effect.fail(
          new MainConversationResumeError({
            threadId: "thread",
            cause: new Error("resume failed"),
          }),
        );
      });
      const first = yield* f.service.resume("thread").pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(cleanupStarted);
      delete f.hooks.native;
      const second = yield* f.service.resume("thread").pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      const successorSettledEarly = second.pollUnsafe() !== undefined;
      yield* Deferred.succeed(finishCleanup, undefined);
      assert.strictEqual((yield* Fiber.join(first))._tag, "Failure");
      assert.strictEqual((yield* Fiber.join(second))._tag, "Success");
      assert.isFalse(successorSettledEarly);
      assert.strictEqual(f.events.filter((event) => event === "native").length, 2);
      assert.strictEqual(f.entity.readResumeState(), "resumed");
    }),
  ),
);
