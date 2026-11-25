import { describe } from "vite-plus/test";
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
import {
  createCodexAppServerCapabilitySnapshot,
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
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
import { appToolCatalog } from "../../shared/nodex-app-tools/catalog";
import { CodexTurnPresentation } from "../../host/TurnPresentation";
import {
  makeTestTurnPresentation,
  testSubmitPresentation,
} from "./CodexTurnPresentation.test-support";
import * as Stream from "effect/Stream";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import type { CodexTurnStartOptions } from "../../shared/types";
import type {
  CodexPendingStartConversationParamsInput,
  CodexPendingWorktreeEntry,
} from "../../shared/codex-pending-worktree";
import { buildCodexDesktopThreadFeatureConfig } from "../codex/codex-thread-config";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { makeTestApplicationSettings } from "../settings/ApplicationSettings.test-support";
import { CodexAttachments } from "./CodexAttachments";
import { CodexClientThreadIdentity } from "./CodexClientThreadIdentity";
import { make as makeCodexConversationCreation } from "./CodexConversationCreation";
import { CodexConversationFork } from "./CodexConversationFork";
import { CodexGitProbe } from "./CodexGitProbe";
import { makeTestCodexGitProbe } from "./CodexGitProbe.test-support";
import { CodexForkSidePanelTransfer } from "./CodexForkSidePanelTransferRuntime";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexThreadLaunchCompletion } from "./CodexThreadLaunchCompletion";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { transparentThreadCreationRuntime } from "./ThreadCreationRuntime.test-support";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import { CodexAutoThreadTitle } from "./CodexAutoThreadTitle";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { ManagedWorktreeRuntime } from "./ManagedWorktreeRuntime";

describe("CodexMainConversationResume", () => {
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
      historyMode:
        options.selectedPaginated === false ? ("legacy" as const) : ("paginated" as const),
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
      disabledPluginIds: [],
      cwd: "/workspace/project",
      ...permissions,
      sandbox: permissions.sandboxPolicy,
      instructionSources: [],
      reasoningEffort: "high",
      collaborationMode: null,
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
    const acceptedQueueAdmissions: boolean[] = [];
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
        if (method === "thread/read")
          return before("metadata").pipe(Effect.as({ thread: metadata }));
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
              userAgent:
                options.supportsPaginatedHistory === false ? "codex/0.0.0" : "codex/0.148.0",
            }),
          })),
        ),
      acceptResumeResult: (
        input: Parameters<CodexThreadDirectory["Service"]["acceptResumeResult"]>[0],
      ) =>
        before("accept").pipe(
          Effect.map(() => {
            acceptedResumeInputs.push(input);
            acceptedQueueAdmissions.push(input.canRecordQueueAcceptance?.() === true);
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
      acceptedQueueAdmissions,
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

  it.effect("retires restored queue acceptance when its admitted owner changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* build();
        assert.strictEqual((yield* f.service.resume("thread")).status, "ready");
        const admission = f.acceptedResumeInputs[0]?.canRecordQueueAcceptance;
        assert.ok(admission);
        assert.deepEqual(f.acceptedQueueAdmissions, [true]);
        // Publication replaces the role incarnation, so the admission has already retired.
        assert.isFalse(admission());
        f.setRole({ role: "follower", ownerClientId: "window" });
        assert.isFalse(admission());
        f.setRole({ role: "owner" });
        assert.isFalse(admission());
        f.reset();
        f.restore();
        assert.isFalse(admission());
      }),
    ),
  );

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
          assert.deepEqual(f.manager.stream.getRole(), {
            role: "follower",
            ownerClientId: "window",
          });
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
                    moderation: null,
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
});

describe("CodexConversationCreation", () => {
  const make = makeCodexConversationCreation;
  const request = (): Extract<
    CodexPendingWorktreeEntry,
    { readonly launchMode: "start-conversation" }
  > => ({
    id: "local:pending-1",
    hostId: "local",
    label: "Delegated task",
    sourceWorkspaceRoot: "/source",
    startingState: { type: "branch", branchName: "main" },
    localEnvironmentConfigPath: null,
    prompt: "Implement it",
    launchMode: "start-conversation",
    firstSubmission: {
      launchId: "01991e60-b800-7000-8000-000000000101",
      clientUserMessageId: "01991e60-b800-7000-8000-000000000102",
    },
    clientThreadId: "client-new-thread:local:pending-1",
    startConversationParamsInput: {
      input: [],
      commentAttachments: [],
      workspaceRoots: ["/source"],
      cwd: "/source",
      fileAttachments: [],
      addedFiles: [],

      model: null,
      serviceTier: null,
      reasoningEffort: null,
      collaborationMode: null,
      config: {},
      threadSource: "subagent",
      workspaceKind: "project",
      projectAssignment: {
        projectKind: "local",
        projectId: "project-pending",
        pendingCoreUpdate: false,
      },
    },
    sourceConversationId: null,
    sourceCollaborationMode: null,
    createdAt: 1,
    attempt: 1,
    phase: "worktree-ready",
    labelEdited: true,
    worktreeOutputText: "",
    setupOutputText: "",
    errorMessage: null,
    worktreeWorkspaceRoot: "/worktree",
    worktreeGitRoot: "/worktree",
    needsAttention: false,
    isPinned: false,
  });

  it.effect.each([
    {
      withProfile: true,
      pinned: false,
      withOrigin: false,
      targetHostId: "ssh:remote",
      passive: false,
    },
    {
      withProfile: false,
      pinned: false,
      withOrigin: false,
      targetHostId: "ssh:remote",
      passive: false,
    },
    {
      withProfile: true,
      pinned: true,
      withOrigin: false,
      targetHostId: "ssh:remote",
      passive: false,
    },
    {
      withProfile: true,
      pinned: false,
      withOrigin: true,
      targetHostId: "ssh:remote",
      passive: false,
    },
    { withProfile: true, pinned: false, withOrigin: false, targetHostId: "local", passive: true },
  ])(
    "preserves the model, accepted first Turn, and Session pin during pending launch (%j)",
    ({ withProfile, pinned, withOrigin, targetHostId, passive }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const presentation = yield* makeTestTurnPresentation;
          const requests: Array<{
            readonly hostId: string;
            readonly method: string;
            readonly scheduling: unknown;
          }> = [];
          const threadStartParams: Record<string, unknown>[] = [];
          const acceptedCapabilities: CodexAppServerCapabilitySnapshot[] = [];
          const firstTurnOverrides: Record<string, unknown>[] = [];
          const launchEvents: string[] = [];
          const unsupported = () => Effect.die(new Error("unused"));
          const capability = createCodexAppServerCapabilitySnapshot({
            hostId: targetHostId,
            generation: 17,
            userAgent: "codex-app-server/0.145.0-alpha.15",
            nativeAppTools: targetHostId === "local",
          });
          const requestPhysical = (
            hostId: string,
            method: string,
            params: unknown,
            scheduling: unknown,
          ) =>
            Effect.sync(() => {
              requests.push({ hostId, method, scheduling });
              if (method === "config/read") {
                return { config: {}, origins: {}, layers: null };
              }
              if (method === "experimentalFeature/list") {
                return { data: [], nextCursor: null };
              }
              if (method === "thread/start") {
                const requestParams = params as Record<string, unknown>;
                threadStartParams.push(requestParams);
                return {
                  thread: { id: "thread-created", historyMode: "paginated", turns: [] },
                  model: requestParams.model,
                  modelProvider: requestParams.modelProvider,
                  reasoningEffort: (requestParams.config as Record<string, unknown> | undefined)
                    ?.model_reasoning_effort,
                  serviceTier:
                    requestParams.serviceTier === null ? "default" : requestParams.serviceTier,
                };
              }
              return {};
            }) as never;
          const gateway = CodexGateway.of({
            promoteQueuedCatalogPage: Effect.succeed(false),
            localHostId: "local",
            events: Stream.empty,
            requestLocal: (method: string, params: unknown, scheduling: unknown) =>
              requestPhysical("local", method, params, scheduling),
            requestRawOnHost: unsupported,
            requestRawForThread: unsupported,
            requestOnHost: (hostId: string, method: string, params: unknown, scheduling: unknown) =>
              requestPhysical(hostId, method, params, scheduling),
            requestForThread: unsupported,
            notifyLocal: unsupported,
            connection: unsupported,
            connectionChanges: () => Stream.empty,
            awaitReady: () => Effect.void,
            reconcileHost: unsupported,
            removeHost: unsupported,
            restartHost: unsupported,
          });
          const serviceEffect = make.pipe(
            Effect.provideService(CodexTurnPresentation, presentation),
            Effect.provideService(
              CodexAppServerCapabilities,
              CodexAppServerCapabilities.of({
                forHost: () => Effect.succeed(capability),
                forThread: () => Effect.succeed(capability),
                isCurrent: () => Effect.succeed(true),
              }),
            ),
            Effect.provideService(ApplicationSettings, makeTestApplicationSettings()),
            Effect.provideService(
              CodexAttachments,
              CodexAttachments.of({
                materializeGoal: unsupported,
                cleanupGoalSources: () => Effect.void,
                cleanupMaterializedGoal: () => Effect.void,
              } as unknown as CodexAttachments["Service"]),
            ),
            Effect.provideService(
              CodexClientThreadIdentity,
              CodexClientThreadIdentity.of({
                remember: (_threadId: string, _clientThreadId: string, hostId?: string) =>
                  Effect.sync(() => {
                    assert.strictEqual(hostId, targetHostId);
                    launchEvents.push("identity:remembered");
                  }),
                forget: () => Effect.void,
              } as unknown as CodexClientThreadIdentity["Service"]),
            ),
            Effect.provideService(
              CodexConversationFork,
              CodexConversationFork.of({ fork: unsupported } as never),
            ),
            Effect.provideService(
              CodexForkSidePanelTransfer,
              CodexForkSidePanelTransfer.of({ promotePending: unsupported } as never),
            ),
            Effect.provideService(CodexGateway, gateway),
            Effect.provideService(
              DesktopToolRuntime,
              DesktopToolRuntime.of({
                threadConfig: () =>
                  Effect.succeed({
                    "features.js_repl": false,
                    "mcp_servers.node_repl": { command: "/runtime/node" },
                  }),
              } as unknown as DesktopToolRuntime["Service"]),
            ),
            Effect.provideService(
              CodexThreadDirectory,
              CodexThreadDirectory.of({
                acceptSessionStart: (
                  input: Parameters<CodexThreadDirectory["Service"]["acceptSessionStart"]>[0],
                ) =>
                  Effect.sync(() => {
                    acceptedCapabilities.push(input.capability);
                    return { summary: { threadId: "thread-created" } } as never;
                  }),
                acceptStandaloneStart: (
                  input: Parameters<CodexThreadDirectory["Service"]["acceptStandaloneStart"]>[0],
                ) =>
                  Effect.sync(() => {
                    acceptedCapabilities.push(input.capability);
                    return { summary: { threadId: "thread-created" } } as never;
                  }),
              } as never),
            ),
            Effect.provideService(
              CodexThreadGoalRuntime,
              CodexThreadGoalRuntime.of({ set: unsupported } as never),
            ),
            Effect.provideService(
              CodexThreadLaunchCompletion,
              CodexThreadLaunchCompletion.of({ accepted: () => Effect.void } as never),
            ),
            Effect.provideService(ThreadCreationRuntime, transparentThreadCreationRuntime),
            Effect.provideService(
              CodexThreadTitlePersistence,
              CodexThreadTitlePersistence.of({ set: unsupported } as never),
            ),
            Effect.provideService(
              CodexAutoThreadTitle,
              CodexAutoThreadTitle.of({
                schedule: () => Effect.void,
              }),
            ),
            Effect.provideService(
              CodexTurnCommands,
              CodexTurnCommands.of({
                start: (_threadId: string, _prompt: string, overrides?: CodexTurnStartOptions) =>
                  Effect.sync(() => {
                    launchEvents.push("turn:accepted");
                    firstTurnOverrides.push((overrides ?? {}) as Record<string, unknown>);
                    return { id: "turn-1" } as never;
                  }),
              } as never),
            ),
            Effect.provideService(
              BrowserUseRuntime,
              BrowserUseRuntime.of({ promoteRoute: unsupported } as never),
            ),
            Effect.provideService(ManagedWorktreeRuntime, ManagedWorktreeRuntime.of({} as never)),
            Effect.provideService(
              CodexSidebarSyncRuntime,
              CodexSidebarSyncRuntime.of({
                ensureSession: (threadId: string) =>
                  Effect.sync(() => {
                    assert.strictEqual(threadId, "thread-created");
                    launchEvents.push("session:ensured");
                    return { id: "session-created" } as never;
                  }),
              } as never),
            ),
            Effect.provideService(
              ProjectWorkspace,
              ProjectWorkspace.of({
                setThreadPinned: (threadId: string, isPinned: boolean) =>
                  Effect.sync(() => {
                    assert.deepEqual([threadId, isPinned], ["thread-created", true]);
                    launchEvents.push("pin:applied");
                  }),
              } as never),
            ),
          );
          const service = yield* serviceEffect.pipe(
            Effect.provideService(CodexGitProbe, makeTestCodexGitProbe()),
          );

          const pending = request();
          if (passive) {
            const failure = yield* service
              .launchPending(pending, "/worktree", false)
              .pipe(Effect.flip);
            assert.equal(failure.operation, "launch");
            assert.deepEqual(requests, []);
            assert.deepEqual(firstTurnOverrides, []);
            assert.deepEqual(launchEvents, []);
            return;
          }

          const target = {
            kind: "session",
            sessionId: "session-pending",
            launchId: pending.firstSubmission.launchId,
          } as const;
          const ticket = withOrigin
            ? yield* presentation.capture(11, { target, presentation: testSubmitPresentation })
            : undefined;
          const expectedClaim = ticket
            ? yield* presentation.claim(ticket, target, pending.firstSubmission.clientUserMessageId)
            : undefined;
          const executionProfile: CodexExecutionProfile = {
            modelId: "gpt-5.6-luna",
            reasoningEffort: "max",
            serviceTier: null,
          };
          const startConversationParamsInput: CodexPendingStartConversationParamsInput = {
            ...pending.startConversationParamsInput,
            executionProfile: withProfile ? executionProfile : null,
            model: "gpt-5.6-sol",
            reasoningEffort: "max",
            serviceTier: withProfile ? "fast" : null,
          };
          assert.deepEqual(
            yield* service.launchPending(
              {
                ...pending,
                threadStartHostId: targetHostId,
                projectSessionId: withOrigin ? target.sessionId : null,
                isPinned: pinned,
                startConversationParamsInput,
              },
              "/worktree",
              false,
            ),
            {
              threadId: "thread-created",
            },
          );
          assert.deepEqual(requests, [
            {
              hostId: targetHostId,
              method: "config/read",
              scheduling: { expectedHostId: targetHostId, expectedGeneration: 17 },
            },
            {
              hostId: targetHostId,
              method: "experimentalFeature/list",
              scheduling: { expectedHostId: targetHostId, expectedGeneration: 17 },
            },
            {
              hostId: targetHostId,
              method: "thread/start",
              scheduling: { expectedHostId: targetHostId, expectedGeneration: 17 },
            },
          ]);
          assert.strictEqual(threadStartParams[0]?.serviceTier, null);
          assert.strictEqual(
            threadStartParams[0]?.model,
            withProfile ? "gpt-5.6-luna" : "gpt-5.6-sol",
          );
          assert.strictEqual(firstTurnOverrides[0]?.model, threadStartParams[0]?.model);
          assert.strictEqual(threadStartParams[0]?.historyMode, "paginated");
          assert.deepEqual(threadStartParams[0]?.dynamicTools, []);
          assert.isUndefined(threadStartParams[0]?.allowProviderModelFallback);
          assert.deepEqual(threadStartParams[0]?.config, {
            ...buildCodexDesktopThreadFeatureConfig(capability.version),
            ...(targetHostId === "local"
              ? {
                  "features.js_repl": false,
                  "mcp_servers.node_repl": { command: "/runtime/node" },
                }
              : {}),
            ...(capability.nativeAppTools
              ? {
                  "mcp_servers.nodex_app.enabled_tools": appToolCatalog.map((tool) => tool.name),
                }
              : {}),
            model_reasoning_effort: "max",
          });
          assert.strictEqual(firstTurnOverrides[0]?.serviceTier, null);
          assert.deepEqual(firstTurnOverrides[0]?.presentationClaim, expectedClaim);
          assert.deepEqual(acceptedCapabilities, [capability]);
          assert.deepEqual(
            launchEvents,
            pinned
              ? ["turn:accepted", "session:ensured", "pin:applied", "identity:remembered"]
              : ["turn:accepted", "identity:remembered"],
          );
        }),
      ),
  );
});
