import { describe } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import type { CodexCommandOutputUpdate } from "../../shared/codex-conversation-state/codex-command-output-queue";
import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexFrameTextDeltaUpdate } from "../../shared/codex-conversation-state/codex-frame-text-delta-queue";
import {
  CodexConversationDeltaBufferRuntime,
  make,
  type CodexConversationDeltaBufferRuntimeOptions,
} from "./CodexConversationDeltaBufferRuntime";
import {
  ConversationEntityMap,
  live as conversationRuntimeMapLive,
  live as conversationEntityMapLive,
} from "./internal/ConversationEntityMap";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { make as makeThreadCreationRuntime, makeWithCapacity } from "./ThreadCreationRuntime";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { produce } from "immer";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import type { CodexConversationSnapshot } from "../../shared/types";
import { CodexConversations, live } from "./CodexConversations";
import { BrowserUseRuntime, BrowserUseRuntimeError } from "../host-runtime/BrowserUseRuntime";
import { make as makeCodexConversationLifecycle } from "./CodexConversationLifecycle";
import { CodexManualCompactionRuntime } from "./CodexManualCompactionRuntime";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import {
  CodexRendererPresentationRegistry,
  make as makePresentationRegistry,
} from "./CodexRendererPresentationRegistry";
import * as Clock from "effect/Clock";
import { TestClock as TestClockCodexConversationResumeRequest } from "effect/testing";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type { CodexGateway, CodexGatewayRequestOptions } from "../codex-runtime/CodexGateway";
import { codexRuntimeError, type CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { requestMainConversationResume } from "./CodexConversationResumeRequest";

describe("CodexConversationDeltaBufferRuntime", () => {
  const frame = (delta: string): CodexFrameTextDeltaUpdate => ({
    conversationId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    target: { type: "agentMessage" },
    delta,
  });

  const output = (delta: string, conversationId = "thread-1"): CodexCommandOutputUpdate => ({
    conversationId,
    turnId: "turn-1",
    itemId: "command-1",
    delta,
  });

  const observeCommits = (
    conversations: ConversationEntityMap["Service"],
    threadId: string,
    frameCommits: string[],
    outputCommits: string[] = [],
  ): void => {
    const aggregate = conversations.entity(threadId);
    const commitFrameTextDeltas = aggregate.commitFrameTextDeltas;
    const commitCommandOutputDeltas = aggregate.commitCommandOutputDeltas;
    Object.defineProperties(aggregate, {
      commitFrameTextDeltas: {
        configurable: true,
        value: (input: Parameters<typeof commitFrameTextDeltas>[0]) => {
          frameCommits.push(
            ...input.updates.map((update) => `${threadId}:${update.delta}:${input.observedAtMs}`),
          );
          return commitFrameTextDeltas(input);
        },
      },
      commitCommandOutputDeltas: {
        configurable: true,
        value: (input: Parameters<typeof commitCommandOutputDeltas>[0]) => {
          outputCommits.push(...input.updates.map((update) => `${threadId}:${update.delta}`));
          return commitCommandOutputDeltas(input);
        },
      },
    });
  };

  const withRuntime = <A, E>(
    use: (
      runtime: CodexConversationDeltaBufferRuntime["Service"],
      conversations: ConversationEntityMap["Service"],
    ) => Effect.Effect<A, E>,
    options: CodexConversationDeltaBufferRuntimeOptions = {},
  ): Effect.Effect<A, E, Scope.Scope> =>
    Effect.gen(function* () {
      const ownerScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(conversationRuntimeMapLive, ownerScope);
      const conversations = Context.get(context, ConversationEntityMap);
      const runtime = yield* make(options).pipe(
        Effect.provideService(ConversationEntityMap, conversations),
      );
      const result = yield* use(runtime, conversations);
      yield* Scope.close(ownerScope, Exit.void);
      return result;
    });

  it.effect("completion drains every Thread in the manager prose batch", () =>
    withRuntime((runtime, conversations) =>
      Effect.gen(function* () {
        const commits: string[] = [];
        observeCommits(conversations, "thread-1", commits);
        observeCommits(conversations, "thread-2", commits);
        runtime.enqueueFrameText(frame("a"));
        runtime.enqueueFrameText({ ...frame("b"), conversationId: "thread-2" });
        runtime.drainBeforeCompletion("thread-1", 1_000);
        assert.strictEqual(commits.length, 2);
        assert.strictEqual(commits[0], "thread-1:a:1000");
        assert.isTrue(commits[1]?.startsWith("thread-2:b:"));
        yield* TestClock.adjust("20 millis");
        assert.strictEqual(commits.length, 2);
      }),
    ),
  );

  it.effect("clear removes only the addressed global-queue entries before the timer fires", () =>
    withRuntime((runtime, conversations) =>
      Effect.gen(function* () {
        const commits: string[] = [];
        observeCommits(conversations, "thread-1", commits);
        runtime.enqueueFrameText(frame("discard"));
        runtime.clear("thread-1");
        yield* TestClock.adjust("1 second");
        assert.deepEqual(commits, []);
      }),
    ),
  );

  it.effect("coalesces each Thread's prose until the fallback timer", () =>
    withRuntime((runtime, conversations) =>
      Effect.gen(function* () {
        const commits: string[] = [];
        observeCommits(conversations, "thread-1", commits);
        observeCommits(conversations, "thread-2", commits);
        runtime.enqueueFrameText(frame("a"));
        runtime.enqueueFrameText({ ...frame("b"), conversationId: "thread-2" });
        runtime.enqueueFrameText({ ...frame("cd"), conversationId: "thread-2" });
        runtime.enqueueFrameText({ ...frame("xyz"), conversationId: "thread-2" });
        assert.deepEqual(commits, []);
        yield* TestClock.adjust("1 second");
        assert.deepEqual(
          commits.map((entry) => entry.split(":").slice(0, 2).join(":")),
          ["thread-1:a", "thread-2:bcdxyz"],
        );
      }),
    ),
  );

  it.effect("commits a large buffered delta on the explicit completion drain", () =>
    withRuntime((runtime, conversations) =>
      Effect.sync(() => {
        const protocol: Thread = {
          model: null,
          reasoningEffort: null,
          id: "thread-1",
          environments: null,
          extra: null,
          sessionId: "session-1",
          forkedFromId: null,
          attachedToThreadId: null,
          parentThreadId: null,
          preview: "",
          ephemeral: false,
          section: null,
          sectionEnteredAt: null,
          projectId: null,
          historyMode: "paginated",
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 1,
          recencyAt: 1,
          status: { type: "active", activeFlags: [] },
          path: null,
          cwd: "/repo",
          cliVersion: "test",
          originator: null,
          source: "unknown",
          canAcceptDirectInput: true,
          threadSource: null,
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          daybreakEnabled: null,
          turns: [
            {
              rootTurnId: null,
              id: "turn-1",
              status: "inProgress",
              error: null,
              itemsView: "full",
              startedAt: 1,
              completedAt: null,
              durationMs: null,
              items: [
                {
                  questions: null,
                  type: "agentMessage",
                  moderation: null,
                  id: "item-1",
                  text: "",
                  phase: null,
                  memoryCitation: null,
                  delivery: null,
                },
              ],
            },
          ],
        };
        conversations.entity("thread-1").acceptCanonicalState(
          createCodexCanonicalHydratedConversationState(protocol, {
            hostId: "local",
            ...{
              model: "gpt-test",
              reasoningEffort: "high",
              cwd: "/repo",
              approvalPolicy: "on-request",
              approvalsReviewer: "user",
              sandboxPolicy: { type: "readOnly", networkAccess: false },
              activePermissionProfile: null,
              runtimeWorkspaceRoots: ["/repo"],
            },
          }),
        );

        runtime.enqueueFrameText(frame("x".repeat(2 * 1024 * 1024 + 1_024)));
        runtime.drainBeforeCompletion("thread-1", 1000);

        const turn = conversations.current("thread-1")?.readCanonicalState()?.turns[0];
        assert.strictEqual(turn?.items[0]?.type, "agentMessage");
        assert.isAbove(Buffer.byteLength(JSON.stringify(turn), "utf8"), 2 * 1024 * 1024);
      }),
    ),
  );

  it.effect("flushes all command keys at the timer while coalescing each item's output", () =>
    withRuntime((runtime, conversations) =>
      Effect.gen(function* () {
        const outputCommits: string[] = [];
        observeCommits(conversations, "thread-1", [], outputCommits);
        observeCommits(conversations, "thread-2", [], outputCommits);
        runtime.enqueueCommandOutput(output("ab"));
        runtime.enqueueCommandOutput(output("cd", "thread-2"));
        runtime.enqueueCommandOutput(output("😀😀😀", "thread-2"));
        assert.deepEqual(outputCommits, []);
        yield* TestClock.adjust("1 second");
        assert.deepEqual(outputCommits, ["thread-1:ab", "thread-2:cd😀😀😀"]);
      }),
    ),
  );

  it.effect(
    "completion flushes all queued command bytes before prose and leaves no timer replay",
    () =>
      withRuntime((runtime, conversations) =>
        Effect.gen(function* () {
          const commits: string[] = [];
          observeCommits(conversations, "thread-1", commits, commits);
          observeCommits(conversations, "thread-2", commits, commits);
          runtime.enqueueFrameText(frame("prose"));
          runtime.enqueueCommandOutput(output("same\n"));
          runtime.enqueueCommandOutput(output("same\n"));
          runtime.enqueueCommandOutput(output("other", "thread-2"));
          runtime.drainBeforeCompletion("thread-1", 1_000);
          assert.deepEqual(commits, [
            "thread-1:same\nsame\n",
            "thread-2:other",
            "thread-1:prose:1000",
          ]);
          yield* TestClock.adjust("100 millis");
          assert.strictEqual(commits.length, 3);
          runtime.enqueueCommandOutput(output("later"));
          yield* TestClock.adjust("100 millis");
          assert.strictEqual(commits.at(-1), "thread-1:later");
        }),
      ),
  );
});

describe("ThreadCreationRuntime", () => {
  const make = makeThreadCreationRuntime;
  it.effect("releases notification-first starts only after local materialization", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const gate = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
      const response = yield* Deferred.make<string>();
      const materialization = yield* gate
        .materialize("local", 7, Deferred.await(response), (threadId) => threadId)
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.isTrue(gate.defer("local", 7, "thread-a"));
      assert.isFalse(gate.defer("remote", 7, "thread-remote"));
      yield* Deferred.succeed(response, "thread-a");
      assert.strictEqual(yield* Fiber.join(materialization), "thread-a");
      const release = Option.getOrThrow(yield* Stream.runHead(gate.releases));
      assert.deepEqual(release, { hostId: "local", generation: 7, threadId: "thread-a" });
      assert.isFalse(gate.defer("local", 7, "thread-a"));

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("drains an unknown started Thread when its request fails", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const gate = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
      const rejectRequest = yield* Deferred.make<void>();
      const failed = yield* gate
        .materialize(
          "local",
          3,
          Deferred.await(rejectRequest).pipe(Effect.andThen(Effect.fail("request failed"))),
          () => null,
        )
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.isTrue(gate.defer("local", 3, "orphan-thread"));
      yield* Deferred.succeed(rejectRequest, undefined);
      assert.strictEqual((yield* Fiber.await(failed))._tag, "Failure");
      assert.deepEqual(Option.getOrThrow(yield* Stream.runHead(gate.releases)), {
        hostId: "local",
        generation: 3,
        threadId: "orphan-thread",
      });

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "keeps the physical materialization alive after its renderer waiter is interrupted",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const gate = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
        const response = yield* Deferred.make<string>();
        const committed = yield* Deferred.make<string>();
        const waiter = yield* gate
          .materialize(
            "local",
            11,
            Deferred.await(response).pipe(
              Effect.tap((threadId) => Deferred.succeed(committed, threadId)),
            ),
            (threadId) => threadId,
          )
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        assert.isTrue(gate.defer("local", 11, "thread-detached"));
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(response, "thread-detached");
        assert.strictEqual(yield* Deferred.await(committed), "thread-detached");
        assert.deepEqual(Option.getOrThrow(yield* Stream.runHead(gate.releases)), {
          hostId: "local",
          generation: 11,
          threadId: "thread-detached",
        });

        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect("fails health instead of dropping a deferred canonical start release", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const gate = yield* makeWithCapacity(1).pipe(Effect.provideService(Scope.Scope, scope));
      const response = yield* Deferred.make<void>();
      const materialization = yield* gate
        .materialize(
          "local",
          1,
          Deferred.await(response).pipe(Effect.andThen(Effect.fail("request failed"))),
          () => null,
        )
        .pipe(Effect.forkChild);
      const termination = yield* gate.termination.pipe(Effect.flip, Effect.forkChild);

      yield* Effect.yieldNow;
      assert.isTrue(gate.defer("local", 1, "thread-a"));
      assert.isTrue(gate.defer("local", 1, "thread-b"));
      yield* Deferred.succeed(response, undefined);
      yield* Fiber.await(materialization);
      const overflow = yield* Fiber.join(termination);

      assert.strictEqual(overflow.capacity, 1);
      assert.strictEqual(overflow.hostId, "local");
      assert.strictEqual(overflow.generation, 1);
      assert.strictEqual(overflow.threadId, "thread-b");
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("never admits or releases a start across Endpoint generations", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const gate = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
      const oldResponse = yield* Deferred.make<void>();
      const nextResponse = yield* Deferred.make<void>();
      const oldMaterialization = yield* gate
        .materialize("local", 21, Deferred.await(oldResponse), () => null)
        .pipe(Effect.forkChild);
      const nextMaterialization = yield* gate
        .materialize("local", 22, Deferred.await(nextResponse), () => null)
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.isTrue(gate.defer("local", 21, "thread-old"));
      assert.isTrue(gate.defer("local", 22, "thread-next"));
      assert.isFalse(gate.defer("local", 23, "thread-unknown"));

      yield* Deferred.succeed(oldResponse, undefined);
      yield* Fiber.join(oldMaterialization);
      assert.deepEqual(Option.getOrThrow(yield* Stream.runHead(gate.releases)), {
        hostId: "local",
        generation: 21,
        threadId: "thread-old",
      });

      yield* Deferred.succeed(nextResponse, undefined);
      yield* Fiber.join(nextMaterialization);
      assert.deepEqual(Option.getOrThrow(yield* Stream.runHead(gate.releases)), {
        hostId: "local",
        generation: 22,
        threadId: "thread-next",
      });

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "a renderer admission spans raw response delivery and closes exactly once after acceptance",
    () =>
      Effect.gen(function* () {
        const gate = yield* make;
        const admission = gate.open("local", 9);
        assert.isTrue(gate.defer("local", 9, "child"));
        yield* admission.close("child");
        assert.deepEqual(Option.getOrThrow(yield* Stream.runHead(gate.releases)), {
          hostId: "local",
          generation: 9,
          threadId: "child",
        });
        assert.isFalse(gate.defer("local", 9, "child"));
        yield* admission.close("child");
        const replacement = gate.open("local", 9);
        assert.isTrue(gate.defer("local", 9, "next"));
        yield* replacement.close();
        assert.deepEqual(Option.getOrThrow(yield* Stream.runHead(gate.releases)), {
          hostId: "local",
          generation: 9,
          threadId: "next",
        });
      }),
  );
});

describe("CodexConversations", () => {
  it.effect("projects private entity state into one immutable cross-subsystem capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          live.pipe(Layer.provideMerge(conversationEntityMapLive)),
        );
        const conversations = Context.get(context, CodexConversations);
        const entities = Context.get(context, ConversationEntityMap);
        const entity = entities.entity("thread-a");
        entity.acceptCanonicalState({
          ...conversationFixture("thread-a", [
            turnFixture("turn-old"),
            turnFixture("turn-current", "inProgress"),
          ]),
          title: "Canonical title",
        });
        entity.installSnapshot({
          threadId: "thread-a",
          threadName: "Projected title",
          statusType: "idle",
          statusActiveFlags: [],
          turns: [],
          requests: [],
          pendingSteers: [],
          queuedFollowUps: {
            status: "ready",
            ledgerRevision: 0,
            projectionRevision: 0,
            entries: [],
            inFlightFollowUpId: null,
            editingFollowUpId: null,
            error: null,
          },
        } as unknown as CodexConversationSnapshot);

        assert.strictEqual(conversations.latestTurnId("thread-a"), "turn-current");
        assert.deepEqual(conversations.activity("thread-a"), {
          active: true,
          label: "Canonical title",
          pending: false,
        });
        assert.strictEqual(conversations.read("thread-a")?.generation, entity.generation);
        assert.deepEqual(conversations.read("thread-a")?.historyCheckpoint, [
          entity.generation,
          entity.readHistoryTopology().generation,
          entity.read().historyMutationRevision,
        ]);

        yield* conversations.retire("thread-a");
        assert.isNull(conversations.read("thread-a"));
      }),
    ),
  );

  it.effect(
    "reads activity and the latest accepted Turn from resident history without a presentation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            live.pipe(Layer.provideMerge(conversationEntityMapLive)),
          );
          const conversations = Context.get(context, CodexConversations);
          const entity = Context.get(context, ConversationEntityMap).entity("resident-thread");
          const canonical = produce(
            conversationFixture("resident-thread", [
              turnFixture("resident-old"),
              turnFixture("resident-active", "inProgress"),
            ]),
            (draft) => {
              replaceCanonicalHistoryDraft(draft, draft.turns, true, null);
            },
          );
          assert.strictEqual(canonical.turns.length, 0);
          entity.acceptCanonicalState(canonical);
          assert.isNull(entity.readSnapshot());
          assert.strictEqual(conversations.latestTurnId("resident-thread"), "resident-active");
          assert.isTrue(conversations.activity("resident-thread").active);
          const liveState = conversationFixture("resident-thread", [
            turnFixture("new-live-turn", "inProgress"),
          ]);
          entity.acceptCanonicalState({ ...canonical, turns: liveState.turns });
          assert.strictEqual(conversations.latestTurnId("resident-thread"), "new-live-turn");
          assert.isTrue(conversations.activity("resident-thread").active);

          entity.acceptCanonicalState({
            ...canonical,
            turns: [
              {
                ...conversationFixture("overlay", [turnFixture("placeholder", "inProgress")])
                  .turns[0]!,
                turnId: null,
              },
            ],
          });
          assert.strictEqual(conversations.latestTurnId("resident-thread"), "resident-active");
        }),
      ),
  );

  it.effect("does not let a stale presentation restore canonical activity or requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          live.pipe(Layer.provideMerge(conversationEntityMapLive)),
        );
        const conversations = Context.get(context, CodexConversations);
        const entity = Context.get(context, ConversationEntityMap).entity("settled-thread");
        entity.acceptCanonicalState(
          conversationFixture("settled-thread", [turnFixture("settled")]),
        );
        entity.installSnapshot({
          threadId: "settled-thread",
          threadName: "Stale name",
          statusType: "active",
          statusActiveFlags: ["waitingOnApproval"],
          turns: [],
          requests: [],
          pendingSteers: [],
        } as unknown as CodexConversationSnapshot);
        assert.deepEqual(conversations.activity("settled-thread"), {
          active: false,
          pending: false,
          label: "Initial title",
        });
      }),
    ),
  );
});

describe("CodexConversationLifecycle", () => {
  const snapshot = (threadId: string): CodexConversationSnapshot =>
    ({
      threadId,
      queuedFollowUps: {
        status: "ready",
        ledgerRevision: 1,
        projectionRevision: 1,
        entries: [
          {
            threadId,
            followUpId: "follow-up-1",
            prompt: "ship",
          },
        ],
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      },
      requests: [],
      resumeState: "resumed",
    }) as unknown as CodexConversationSnapshot;

  it.effect("retires every conversation resource from inside its current causal lane", () =>
    Effect.gen(function* () {
      const ownerScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(conversationRuntimeMapLive, ownerScope);
      const conversations = Context.get(context, ConversationEntityMap);
      const threadId = "thread-a";
      const reason = new Error("thread deleted");
      const calls: string[] = [];
      let rejectedReason: unknown;

      const pending = CodexPendingServerRequestRuntime.of({
        rejectDispatchedDynamicForThread: (candidate: string, candidateReason: unknown) => {
          calls.push(`pending-dispatched:${candidate}`);
          rejectedReason = candidateReason;
        },
        rejectRemovedTurns: (candidate: string) => {
          calls.push(`pending-all:${candidate}`);
        },
      } as unknown as CodexPendingServerRequestRuntime["Service"]);
      const deltas = CodexConversationDeltaBufferRuntime.of({
        clear: (candidate: string) => calls.push(`deltas:${candidate}`),
      } as unknown as CodexConversationDeltaBufferRuntime["Service"]);
      const manualCompaction = CodexManualCompactionRuntime.of({
        clear: (candidate: string) => calls.push(`compaction:${candidate}`),
      } as unknown as CodexManualCompactionRuntime["Service"]);
      const presentation = yield* makePresentationRegistry;
      presentation.setPresented(threadId, "renderer-a", "surface-a", true);
      const managers = CodexMainConversationManagers.of({
        current: () => ({
          stream: { removeConversation: (candidate: string) => calls.push(`peer:${candidate}`) },
        }),
      } as unknown as CodexMainConversationManagers["Service"]);
      const browserUse = BrowserUseRuntime.of({
        releaseSession: (candidate: string) =>
          Effect.sync(() => {
            calls.push(`browser:${candidate}`);
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new BrowserUseRuntimeError({
                  operation: "release-session",
                  cause: new Error("browser already gone"),
                }),
              ),
            ),
          ),
      } as unknown as BrowserUseRuntime["Service"]);
      const lifecycle = yield* makeCodexConversationLifecycle.pipe(
        Effect.provideService(CodexConversationDeltaBufferRuntime, deltas),
        Effect.provideService(CodexManualCompactionRuntime, manualCompaction),
        Effect.provideService(CodexPendingServerRequestRuntime, pending),
        Effect.provideService(CodexMainConversationManagers, managers),
        Effect.provideService(CodexRendererPresentationRegistry, presentation),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(BrowserUseRuntime, browserUse),
      );

      const aggregate = conversations.entity(threadId);
      aggregate.installSnapshot(snapshot(threadId));
      aggregate.setStreaming(true);

      yield* conversations.runCommand(threadId, lifecycle.close(threadId, reason));

      assert.strictEqual(rejectedReason, reason);
      assert.deepEqual(calls, [
        "pending-dispatched:thread-a",
        "pending-all:thread-a",
        "deltas:thread-a",
        "compaction:thread-a",
        "peer:thread-a",
        "browser:thread-a",
      ]);
      assert.strictEqual(conversations.current(threadId), aggregate);
      assert.isNull(aggregate.readSnapshot());
      assert.isFalse(aggregate.isStreaming());
      assert.deepEqual(aggregate.readQueuedFollowUpProjection().entries, []);
      assert.isFalse(presentation.isClientPresenting(threadId, "renderer-a"));

      let laneRemainsUsable = false;
      yield* conversations.runCommand(
        threadId,
        Effect.sync(() => {
          laneRemainsUsable = true;
        }),
      );
      assert.isTrue(laneRemainsUsable);

      yield* Scope.close(ownerScope, Exit.void);
    }),
  );
});

describe("CodexConversationResumeRequest", () => {
  const TestClock = TestClockCodexConversationResumeRequest;
  type ThreadResumeParams = ClientRequestParamsByMethod["thread/resume"];
  const params: ThreadResumeParams = { threadId: "thread", excludeTurns: true };
  const response = { thread: { id: "thread" } } as ClientRequestResponsesByMethod["thread/resume"];
  const failure = (reason: "timeout" | "request" | "session-lost", message: string) =>
    codexRuntimeError({
      operation: "request",
      method: "thread/resume",
      reason,
      retryable: true,
      cause: new Error(message),
    });
  const closing = () =>
    failure("request", "thread thread is closing; retry thread/resume after the thread is closed");

  function fixture(errors: readonly CodexRuntimeError[], options: CodexGatewayRequestOptions = {}) {
    const attempts: Array<{
      at: number;
      options: CodexGatewayRequestOptions | undefined;
      params: ThreadResumeParams;
    }> = [];
    const gateway = {
      requestOnHost: (
        _hostId: string,
        _method: string,
        request: ThreadResumeParams,
        scheduling?: CodexGatewayRequestOptions,
      ) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const error = errors[attempts.length];
          attempts.push({ at, options: scheduling, params: request });
          if (error) return yield* Effect.fail(error);
          return response;
        }),
    } as Pick<CodexGateway["Service"], "requestOnHost">;
    return {
      attempts,
      send: requestMainConversationResume(gateway, "remote", params, {
        expectedHostId: "remote",
        expectedGeneration: 7,
        ...options,
      }),
    };
  }

  it.effect(
    "Main retries closing responses with the same immutable request and generation fence",
    () =>
      Effect.gen(function* () {
        const f = fixture([closing(), closing(), closing(), closing()]);
        const fiber = yield* f.send.pipe(Effect.forkChild);
        yield* TestClock.adjust(750 + 1500 + 3000 + 6000);
        assert.strictEqual(yield* Fiber.join(fiber), response);
        assert.deepEqual(
          f.attempts.map(({ at }) => at - f.attempts[0]!.at),
          [0, 750, 2250, 5250, 11250],
        );
        for (const attempt of f.attempts) {
          assert.strictEqual(attempt.params, params);
          assert.deepEqual(attempt.options, {
            expectedHostId: "remote",
            expectedGeneration: 7,
            timeoutMs: 120_000,
          });
        }
      }),
  );

  it.effect("Main expands only default timeout attempts and retains the final failure", () =>
    Effect.gen(function* () {
      const errors = [
        failure("timeout", "request deadline"),
        failure("timeout", "request deadline"),
        failure("timeout", "last deadline"),
      ];
      const f = fixture(errors);
      const fiber = yield* f.send.pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust(1500);
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure, errors[2]);
      assert.deepEqual(
        f.attempts.map(({ options }) => options?.timeoutMs),
        [120_000, 240_000, 480_000],
      );
    }),
  );

  it.effect("Main does not retry an explicit timeout or endpoint retirement", () =>
    Effect.gen(function* () {
      for (const error of [
        failure("timeout", "deadline"),
        failure("session-lost", "endpoint retired"),
      ]) {
        const f = fixture([error], { timeoutMs: 30_000 });
        const result = yield* f.send.pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(f.attempts.length, 1);
        assert.strictEqual(f.attempts[0]!.options?.timeoutMs, 30_000);
      }
    }),
  );

  it.effect(
    "closing the Main consumer Scope interrupts backoff before another native dispatch",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const f = fixture([closing()]);
        const fiber = yield* f.send.pipe(Effect.forkIn(scope, { startImmediately: true }));
        yield* TestClock.adjust(749);
        assert.strictEqual(f.attempts.length, 1);
        yield* Scope.close(scope, Exit.void);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
        yield* TestClock.adjust(30_000);
        assert.strictEqual(f.attempts.length, 1);
      }),
  );
});
