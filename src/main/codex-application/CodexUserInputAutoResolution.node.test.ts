import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import {
  make,
  USER_INPUT_AUTO_RESOLUTION_COUNTDOWN,
  USER_INPUT_FOREGROUND_INACTIVITY,
} from "./CodexUserInputAutoResolution";
import {
  CodexRendererPresentationRegistry,
  make as makePresentationRegistry,
} from "./CodexRendererPresentationRegistry";
import { produce, type Draft } from "immer";
import { make as makeCodexMainConversationEdit } from "./CodexMainConversationEdit";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import { CodexMainConversationSettings } from "./CodexMainConversationSettings";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { layer as callbacks } from "../app/ScopedCallbackRuntime";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import type { TurnStartParams } from "@nodex/codex-app-server-protocol/v2";
import type { ConversationFollowerTurnStart } from "../../shared/codex-thread-follower-request";
import {
  make as makeCodexMainConversationInterrupt,
  CodexMainConversationInterrupt,
} from "./CodexMainConversationInterrupt";
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CodexServerRequestResponses } from "./CodexServerRequestResponses";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexNodeReplRuntime } from "./CodexNodeReplRuntime";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import type { ConversationStreamRole } from "../../shared/codex-conversation-stream";
import { CodexMainConversationResume } from "./CodexMainConversationResume";
import { CodexQueuedFollowUps } from "./CodexQueuedFollowUps";
import { make as makeCodexSessionControls } from "./CodexSessionControls";

describe("CodexUserInputAutoResolution", () => {
  const makeRuntime = Effect.fn("CodexUserInputAutoResolutionTest.makeRuntime")(function* (
    presented: boolean,
  ) {
    const registry = yield* makePresentationRegistry;
    registry.setClientForegrounded("renderer-a", presented);
    registry.setPresented("thread-1", "renderer-a", "surface-a", presented);
    return {
      registry,
      runtime: yield* make.pipe(Effect.provideService(CodexRendererPresentationRegistry, registry)),
    };
  });

  it.effect("waits for foreground inactivity before publishing one typed timeout", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { runtime } = yield* makeRuntime(true).pipe(Effect.provideService(Scope.Scope, scope));
      const changes = yield* runtime.changes.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const timeout = yield* runtime.timeouts.pipe(Stream.runHead, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* runtime.observeRequest("thread-1", "request-1", { hostId: "local", generation: 1 });
      assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "waitingForInactivity");

      yield* TestClock.adjust(USER_INPUT_FOREGROUND_INACTIVITY);
      const scheduled = (yield* runtime.snapshot)[0];
      assert.strictEqual(scheduled?.phase.type, "scheduled");
      yield* TestClock.adjust(USER_INPUT_AUTO_RESOLUTION_COUNTDOWN);
      assert.isEmpty(yield* runtime.snapshot);
      const observed = [...(yield* Fiber.join(changes))];
      const expected = {
        type: "timedOut",
        hostId: "local",
        conversationId: "thread-1",
        requestId: "request-1",
      } as const;
      assert.deepEqual(observed.at(-1), expected);
      assert.deepEqual(Option.getOrUndefined(yield* Fiber.join(timeout)), {
        ...expected,
        connection: { hostId: "local", generation: 1 },
        responseKind: "emptyUserInput",
      });
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "starts explicit MCP countdowns immediately and snoozes by restarting the same duration",
    () =>
      Effect.gen(function* () {
        const { runtime } = yield* makeRuntime(true);
        const timeout = yield* runtime.timeouts.pipe(Stream.runHead, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* runtime.observeRequest(
          "thread-1",
          "mcp-request",
          { hostId: "local", generation: 3 },
          { responseKind: "declineMcpElicitation", autoResolutionMs: 5_000 },
        );
        assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "scheduled");

        yield* TestClock.adjust("4 seconds");
        assert.isTrue(
          yield* runtime.snooze({
            hostId: "local",
            conversationId: "thread-1",
            requestId: "mcp-request",
          }),
        );
        assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "scheduled");
        yield* TestClock.adjust("4999 millis");
        assert.lengthOf(yield* runtime.snapshot, 1);
        yield* TestClock.adjust("1 millis");
        assert.isEmpty(yield* runtime.snapshot);
        assert.deepEqual(Option.getOrUndefined(yield* Fiber.join(timeout)), {
          type: "timedOut",
          hostId: "local",
          conversationId: "thread-1",
          requestId: "mcp-request",
          connection: { hostId: "local", generation: 3 },
          responseKind: "declineMcpElicitation",
        });
      }),
  );

  it.effect("resets inactivity, preserves scalar request identity, and snoozes permanently", () =>
    Effect.gen(function* () {
      const { registry, runtime } = yield* makeRuntime(true);
      yield* runtime.observeRequest("thread-1", 7, { hostId: "local", generation: 1 });
      yield* TestClock.adjust("59 seconds");
      yield* runtime.recordActivity({ hostId: "local", conversationId: "thread-1" });
      yield* TestClock.adjust("59 seconds");
      assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "waitingForInactivity");

      registry.setPresented("thread-1", "renderer-a", "surface-a", false);
      yield* runtime.reevaluatePresentation({ hostId: "local", conversationId: "thread-1" });
      assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "scheduled");
      registry.setPresented("thread-1", "renderer-a", "surface-a", true);
      yield* runtime.reevaluatePresentation({ hostId: "local", conversationId: "thread-1" });
      assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "waitingForInactivity");
      registry.setPresented("thread-1", "renderer-a", "surface-a", false);
      yield* runtime.reevaluatePresentation({ hostId: "local", conversationId: "thread-1" });
      assert.isFalse(
        yield* runtime.snooze({ hostId: "local", conversationId: "thread-1", requestId: "7" }),
      );
      assert.isTrue(
        yield* runtime.snooze({ hostId: "local", conversationId: "thread-1", requestId: 7 }),
      );
      yield* TestClock.adjust("10 minutes");
      assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "snoozed");
    }),
  );

  it.effect("clears every request generation when the app-server disconnects", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime(false);
      const removal = yield* runtime.changes.pipe(
        Stream.filter((change) => change.type === "removed" && change.reason === "disconnected"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* runtime.observeRequest("thread-1", "request-1", { hostId: "local", generation: 1 });
      yield* runtime.handleDisconnect("local", 1);

      assert.isEmpty(yield* runtime.snapshot);
      assert.deepEqual(Option.getOrUndefined(yield* Fiber.join(removal)), {
        type: "removed",
        hostId: "local",
        conversationId: "thread-1",
        requestId: "request-1",
        reason: "disconnected",
      });
    }),
  );

  it.effect("a lost host generation cannot clear remote timers or a replacement occurrence", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime(false);
      const local = { hostId: "local", generation: 1 };
      const remote = { hostId: "remote", generation: 1 };
      yield* runtime.observeRequest("old", 7, local);
      yield* runtime.observeRequest("remote", 7, remote);
      yield* runtime.observeRequest("replacement", 7, local);
      yield* runtime.observeRequest("replacement", 7, { ...local, generation: 2 });
      yield* runtime.handleDisconnect("local", 1);
      assert.deepEqual(
        (yield* runtime.snapshot).map((entry) => entry.conversationId),
        ["remote", "replacement"],
      );
      yield* runtime.observeServerResolution("replacement", 7, local);
      yield* runtime.observeResponse("replacement", 7, local);
      yield* runtime.observeServerResolution("remote", 7, local);
      assert.strictEqual((yield* runtime.snapshot).length, 2);
      yield* runtime.handleDisconnect("remote", 1);
      assert.deepEqual(
        (yield* runtime.snapshot).map((entry) => entry.conversationId),
        ["replacement"],
      );
      yield* runtime.observeServerResolution("replacement", 7, { ...local, generation: 2 });
      assert.isEmpty(yield* runtime.snapshot);
      yield* TestClock.adjust("10 minutes");
      assert.isEmpty(yield* runtime.snapshot);
    }),
  );

  it.effect("replaces requests and cancels stale generations on response or reconciliation", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime(false);
      const changes = yield* runtime.changes.pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* runtime.observeRequest("thread-1", 7, { hostId: "local", generation: 1 });
      yield* runtime.observeRequest("thread-1", "7", { hostId: "local", generation: 1 });
      yield* runtime.observeResponse("thread-1", 7, { hostId: "local", generation: 1 });
      assert.lengthOf(yield* runtime.snapshot, 1);
      yield* runtime.reconcilePendingRequests({ hostId: "local", conversationId: "thread-1" }, [7]);
      assert.isEmpty(yield* runtime.snapshot);
      yield* TestClock.adjust("10 minutes");
      const observed = [...(yield* Fiber.join(changes))];
      assert.deepInclude(observed, {
        type: "removed",
        hostId: "local",
        conversationId: "thread-1",
        requestId: 7,
        reason: "replaced",
      });
    }),
  );

  it.effect("interrupts every countdown when its owning Scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { runtime } = yield* makeRuntime(false).pipe(Effect.provideService(Scope.Scope, scope));
      const timeout = yield* runtime.timeouts.pipe(Stream.runHead, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* runtime.observeRequest("thread-1", "request-1", { hostId: "local", generation: 1 });
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust("10 minutes");
      assert.isTrue(Option.isNone(yield* Fiber.join(timeout)));
    }),
  );

  it.effect("isolates the same conversation and request identities across hosts", () =>
    Effect.gen(function* () {
      const { registry, runtime } = yield* makeRuntime(true);
      const local = { hostId: "local", conversationId: "thread-1" };
      const remote = { hostId: "remote", conversationId: "thread-1" };
      yield* runtime.observeRequest("thread-1", "same", { hostId: "local", generation: 1 });
      yield* runtime.observeRequest("thread-1", "same", { hostId: "remote", generation: 1 });
      assert.deepEqual(
        (yield* runtime.snapshot).map(({ hostId, phase }) => [hostId, phase.type]),
        [
          ["local", "waitingForInactivity"],
          ["remote", "scheduled"],
        ],
      );
      assert.isTrue(yield* runtime.snooze({ ...local, requestId: "same" }));
      yield* runtime.clearConversation({ hostId: "unrelated", conversationId: "thread-1" });
      assert.lengthOf(yield* runtime.snapshot, 2);
      yield* runtime.reconcilePendingRequests(local, []);
      assert.deepEqual(
        (yield* runtime.snapshot).map(({ hostId }) => hostId),
        ["remote"],
      );
      registry.setPresented("thread-1", "renderer-a", "remote-surface", true, "remote");
      yield* runtime.reevaluatePresentation(remote);
      assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "waitingForInactivity");
      yield* runtime.observeResponse("thread-1", "same", { hostId: "local", generation: 1 });
      assert.lengthOf(yield* runtime.snapshot, 1);
      yield* runtime.handleDisconnect("local", 1);
      assert.lengthOf(yield* runtime.snapshot, 1);
      yield* TestClock.adjust("59 seconds");
      yield* runtime.recordActivity(local);
      yield* TestClock.adjust("1 second");
      assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "scheduled");
      yield* TestClock.adjust("90 seconds");
      assert.isEmpty(yield* runtime.snapshot);
    }),
  );
});

describe("CodexMainConversationEdit", () => {
  const make = makeCodexMainConversationEdit;
  const makeEditFixture = Effect.fnUntraced(function* (
    hostId = "local",
    failure?: "prepare" | "inspect" | "revert",
  ) {
    let state = produce(
      conversationFixture("thread", [turnFixture("message"), turnFixture("automatic")]),
      (draft) => {
        draft.turns[0]!.params.input = [
          { type: "text", text: "original", text_elements: [] },
          { type: "localImage", path: "/image.png" },
        ];
        draft.turns[1]!.params.input = [];
        replaceCanonicalHistoryDraft(draft, draft.turns, false);
      },
    );
    const calls: string[] = [];
    let admitted: ConversationFollowerTurnStart | undefined;
    const manager = {
      hostId,
      generation: 1,
      assertCurrent: () => {},
      stream: { getRole: () => ({ role: "owner" }) },
    } as unknown as MainConversationManager;
    const service = yield* make.pipe(
      Effect.provideService(TemporaryAssets, {
        resolveAssetPath: (fileName: string) => {
          assert.strictEqual(fileName, "shot.png");
          return `/managed-images/${fileName}`;
        },
      } as TemporaryAssets["Service"]),
      Effect.provideService(CodexMainConversationManagers, {
        get: () => Effect.succeed(manager),
      } as unknown as CodexMainConversationManagers["Service"]),
      Effect.provideService(CodexMainConversationSettings, {
        awaitCurrent: () =>
          Effect.sync(() => {
            calls.push("settings");
          }),
      } as unknown as CodexMainConversationSettings["Service"]),
      Effect.provideService(ConversationEntityMap, {
        current: () => ({
          readCanonicalState: () => state,
          mutateCanonicalState: (recipe: (draft: Draft<typeof state>) => void) => {
            state = produce(state, recipe);
          },
        }),
      } as unknown as ConversationEntityMap["Service"]),
      Effect.provideService(CodexGateway, {
        requestOnHost: (_host: string, method: string, params: unknown) =>
          Effect.sync(() => {
            calls.push(method);
            if (failure === "revert") throw new Error("revert failed");
            assert.strictEqual(method, "thread/revert");
            assert.deepEqual(params, { threadId: "thread", beforeTurnId: "message" });
            return {
              thread: {
                id: "thread",
                sessionId: "new-session",
                path: null,
                cwd: "/returned",
                status: { type: "idle" },
              },
              turnsBackwardsCursor: "retained",
              itemsBackwardsCursor: null,
            };
          }),
      } as unknown as CodexGateway["Service"]),
      Effect.provideService(CodexAppServerCapabilities, {
        forHost: () =>
          Effect.succeed(
            createCodexAppServerCapabilitySnapshot({
              hostId,
              generation: 1,
              userAgent: "0.153.0",
            }),
          ),
      } as unknown as CodexAppServerCapabilities["Service"]),
      Effect.provideService(CodexTurnCommands, {
        prepareNativeStart: (
          _id: string,
          _prompt: string,
          overrides: Parameters<CodexTurnCommands["Service"]["prepareNativeStart"]>[2],
          request: TurnStartParams,
          context: ConversationFollowerTurnStart["context"],
        ) =>
          Effect.sync(() => {
            calls.push("prepare");
            if (failure === "prepare") throw new Error("prepare failed");
            assert.deepEqual(overrides?.preparedPrompt?.inputItems, request.input);
            assert.deepEqual(overrides?.preparedPrompt?.pendingInputItems, request.input);
            admitted = { request: { ...request, clientUserMessageId: "edit" }, context };
            return admitted;
          }),
        inspectPreparedNativeStart: (operation: ConversationFollowerTurnStart) =>
          failure === "inspect"
            ? Effect.fail(new Error("image preparation failed"))
            : Effect.succeed({ request: operation.request }),
        executePreparedNativeStart: () =>
          Effect.sync(() => {
            calls.push("start");
            return {};
          }),
        releasePreparedNativeStart: () => {
          calls.push("release");
        },
      } as unknown as CodexTurnCommands["Service"]),
    );
    return {
      service,
      calls,
      readState: () => state,
      readAdmitted: () => admitted,
    };
  });

  for (const { name, message, writtenImages, expectedText, expectedImages } of [
    {
      name: "plain text",
      message: "edited",
      writtenImages: undefined,
      expectedText: "edited",
      expectedImages: [],
    },
    {
      name: "written images",
      message:
        "![shot](/tmp/x.png)\n\n![asset](nodex://assets/shot.png)\n\n![file](file:///tmp/my%20shot.png)\n\n![library](nodex://files/library-shot)",
      writtenImages: [
        { source: "/tmp/x.png" },
        { source: "nodex://assets/shot.png" },
        { source: "file:///tmp/my%20shot.png" },
        { source: "data:image/png;base64,AQID" },
      ],
      expectedText:
        "[Image #2] (caption: shot; path: /tmp/x.png)\n\n[Image #3] (caption: asset)\n\n[Image #4] (caption: file; path: /tmp/my shot.png)\n\n[Image #5] (caption: library)",
      expectedImages: [
        { type: "localImage", path: "/tmp/x.png" },
        { type: "localImage", path: "/managed-images/shot.png" },
        { type: "localImage", path: "/tmp/my shot.png" },
        { type: "image", url: "data:image/png;base64,AQID" },
      ],
    },
  ] as const)
    it.effect(
      `Main edit reverts retained identities and admits prepared native input and context (${name})`,
      () =>
        Effect.gen(function* () {
          const { service, calls, readState, readAdmitted } = yield* makeEditFixture();
          yield* service.edit("local", "thread", {
            images: [{ source: "/image.png" }],
            turnId: "message",
            message,
            writtenImages,
            writingBlockContextPrepared: true,
          });
          assert.deepEqual(calls, ["settings", "prepare", "thread/revert", "start", "release"]);
          const admitted = readAdmitted();
          assert.deepEqual(admitted?.request.input, [
            { type: "text", text: expectedText, text_elements: [] },
            { type: "localImage", path: "/image.png" },
            ...expectedImages,
          ]);
          assert.strictEqual(admitted?.request.cwd, "/workspace/project");
          assert.strictEqual(admitted?.context?.writingBlockContextPrepared, true);
          assert.strictEqual(residentConversationTurns(readState()).length, 0);
        }).pipe(Effect.provide(callbacks)),
    );

  it.effect("Main edit preserves remote history when a managed image has no bytes", () =>
    Effect.gen(function* () {
      const { service, calls, readState, readAdmitted } = yield* makeEditFixture("devbox");
      const originalState = readState();
      const originalTurns = structuredClone(residentConversationTurns(originalState));
      const options = {
        images: [{ source: "/image.png" }],
        turnId: "message",
        message: "Compare ![asset](nodex://assets/shot.png)",
        writingBlockContextPrepared: true,
      };
      const error = yield* service
        .edit("devbox", "thread", {
          ...options,
          writtenImages: [{ source: "nodex://assets/shot.png" }],
        })
        .pipe(Effect.flip);

      assert.strictEqual(error.hostId, "devbox");
      assert.strictEqual(
        String(error.cause),
        "Error: A managed image reaches another host only as its bytes",
      );
      assert.deepEqual(calls, ["settings"]);
      assert.isUndefined(readAdmitted());
      assert.strictEqual(readState(), originalState);
      assert.deepEqual(residentConversationTurns(readState()), originalTurns);

      yield* service.edit("devbox", "thread", {
        ...options,
        writtenImages: [{ source: "data:image/png;base64,AQID" }],
      });

      assert.deepEqual(calls, [
        "settings",
        "settings",
        "prepare",
        "thread/revert",
        "start",
        "release",
      ]);
      assert.deepEqual(readAdmitted()?.request.input, [
        { type: "text", text: "Compare [Image #2] (caption: asset)", text_elements: [] },
        { type: "localImage", path: "/image.png" },
        { type: "image", url: "data:image/png;base64,AQID" },
      ]);
      assert.strictEqual(residentConversationTurns(readState()).length, 0);
    }).pipe(Effect.provide(callbacks)),
  );

  for (const failure of ["prepare", "inspect", "revert"] as const)
    it.effect(`Main edit keeps history and releases preparation when ${failure} fails`, () =>
      Effect.gen(function* () {
        const f = yield* makeEditFixture("local", failure);
        const original = f.readState();
        const result = yield* f.service
          .edit("local", "thread", { turnId: "message", message: "new", images: [] })
          .pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(f.readState(), original);
        assert.isFalse(f.calls.includes("start"));
        assert.strictEqual(f.calls.includes("thread/revert"), failure === "revert");
        assert.isTrue(f.calls.includes("release"));
      }).pipe(Effect.provide(callbacks)),
    );
});

describe("CodexMainConversationInterrupt", () => {
  const make = makeCodexMainConversationInterrupt;
  const harness = Effect.gen(function* () {
    let state = produce(
      conversationFixture("thread", [turnFixture("active", "inProgress")]),
      (draft) => {
        draft.threadGoal = {
          threadId: "thread",
          objective: "finish",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 0,
          updatedAt: 0,
        };
      },
    );
    const calls: string[] = [];
    const control = {
      generation: 1,
      role: { role: "owner" } as ConversationStreamRole,
      failPause: true,
      afterRequest: (_method: string) => {},
    };
    const originalEntity = {
      readCanonicalState: () => state,
      readServerRequests: () => [],
      mutateCanonicalState: (recipe: (draft: Draft<typeof state>) => void) => {
        state = produce(state, recipe);
      },
    };
    let entity = originalEntity;
    const manager = {
      hostId: "local",
      get generation() {
        return control.generation;
      },
      assertCurrent: (expected = control.generation) => {
        if (expected !== control.generation) throw new Error("Connection changed");
      },
      stream: { getRole: () => control.role },
    } as unknown as MainConversationManager;
    const service = yield* make.pipe(
      Effect.provideService(CodexMainConversationManagers, {
        get: () => Effect.succeed(manager),
      } as unknown as CodexMainConversationManagers["Service"]),
      Effect.provideService(ConversationEntityMap, {
        current: () => entity,
      } as unknown as ConversationEntityMap["Service"]),
      Effect.provideService(CodexGateway, {
        requestOnHost: (
          _host: string,
          method: string,
          _params: unknown,
          options: { priority?: string; timeoutMs?: number },
        ) =>
          Effect.suspend(() => {
            calls.push(method);
            control.afterRequest(method);
            if (method !== "thread/goal/set") return Effect.succeed({});
            if (!control.failPause)
              return Effect.succeed({ goal: { ...state.threadGoal, status: "paused" } });
            if (options.priority === "critical") assert.strictEqual(options.timeoutMs, 500);
            return Effect.fail(
              new CodexRuntimeError({
                operation: "goal",
                reason: "request",
                retryable: false,
                message: "pause failed",
              }),
            );
          }),
      } as unknown as CodexGateway["Service"]),
      Effect.provideService(
        CodexServerRequestResponses,
        {} as CodexServerRequestResponses["Service"],
      ),
      Effect.provideService(CodexSubagentDirectory, {
        settleInterruptedSubtree: () =>
          Effect.sync(() => {
            calls.push("descendants");
          }),
      } as unknown as CodexSubagentDirectory["Service"]),
      Effect.provideService(CodexNodeReplRuntime, {
        cleanupForOwner: () => Effect.die("Owner cleanup must use the admitted interrupt path"),
        cleanup: () =>
          Effect.sync(() => {
            calls.push("repl");
          }),
      }),
      Effect.provideService(CodexApplicationEventHub, {
        publish: () => {
          calls.push("started");
        },
      } as unknown as CodexApplicationEventHub["Service"]),
    );
    return {
      service,
      calls,
      control,
      read: () => state,
      replaceEntity: () => {
        entity = { ...originalEntity };
      },
    };
  });

  it.effect("expected-turn interrupt skips active goal pause and rejects stale expectations", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      assert.deepEqual(yield* f.service.interrupt("local", "thread", "user-stop", "other"), {
        interruptedTurnId: null,
      });
      assert.deepEqual(f.calls, []);
      assert.deepEqual(
        yield* f.service.interrupt("local", "thread", "descendant-cleanup", "active"),
        { interruptedTurnId: "active" },
      );
      assert.deepEqual(f.calls, ["turn/interrupt", "started", "repl"]);
    }).pipe(Effect.provide(callbacks)),
  );

  it.effect("user stop still interrupts when critical goal pause fails", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const result = yield* f.service.interrupt("local", "thread", "user-stop");
      assert.deepEqual(result, {
        interruptedTurnId: "active",
        goalPauseError: "Failed to pause thread goal",
      });
      assert.strictEqual(f.calls[0], "thread/goal/set");
      assert.ok(f.calls.includes("turn/interrupt"));
    }).pipe(Effect.provide(callbacks)),
  );

  it.effect("system pause failure still runs the outer descendant cleanup", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const result = yield* f.service.interrupt("local", "thread", "system").pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepEqual(f.calls, ["thread/goal/set", "descendants"]);
    }).pipe(Effect.provide(callbacks)),
  );

  for (const boundary of ["thread/goal/set", "turn/interrupt"] as const) {
    it.effect.each(["entity", "owner", "connection"] as const)(
      `rejects retired %s completion after ${boundary} without mutating or cleaning a successor`,
      (retired) =>
        Effect.gen(function* () {
          const f = yield* harness;
          f.control.failPause = false;
          f.control.afterRequest = (method) => {
            if (method !== boundary) return;
            if (retired === "entity") f.replaceEntity();
            if (retired === "owner") f.control.role = { role: "owner" } as ConversationStreamRole;
            if (retired === "connection") f.control.generation++;
          };
          const result = yield* f.service
            .interrupt(
              "local",
              "thread",
              "system",
              boundary === "turn/interrupt" ? "active" : undefined,
            )
            .pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          assert.strictEqual(f.read().threadGoal?.status, "active");
          assert.strictEqual(f.read().turns[0]?.status, "inProgress");
          assert.deepEqual(f.calls, [boundary]);
        }).pipe(Effect.provide(callbacks)),
    );
  }

  it.effect("pauses an active resident child Goal after descendant interruption", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      f.control.failPause = false;
      const result = yield* f.service.interrupt("local", "thread", "descendant-cleanup");
      assert.strictEqual(result.interruptedTurnId, "active");
      assert.strictEqual(f.read().threadGoal?.status, "paused");
      assert.isTrue(f.calls.indexOf("turn/interrupt") < f.calls.indexOf("thread/goal/set"));
      assert.notInclude(f.calls, "descendants");
    }).pipe(Effect.provide(callbacks)),
  );

  it.effect("keeps an accepted child stop successful if its Goal pause fails", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const result = yield* f.service.interrupt("local", "thread", "descendant-cleanup");
      assert.strictEqual(result.interruptedTurnId, "active");
      assert.strictEqual(f.read().threadGoal?.status, "active");
      assert.isTrue(f.calls.indexOf("turn/interrupt") < f.calls.indexOf("thread/goal/set"));
      assert.notInclude(f.calls, "descendants");
    }).pipe(Effect.provide(callbacks)),
  );
});

describe("CodexSessionControls", () => {
  const make = makeCodexSessionControls;
  const fixture = Effect.gen(function* () {
    const requests: Array<{
      hostId: string;
      targetClientId?: string;
      request: { method: string; params: unknown };
    }> = [];
    let error = false;
    let retired = false;
    const controls = yield* make.pipe(
      Effect.provideService(CodexMainConversationManagers, {
        get: () =>
          Effect.succeed({
            generation: 3,
            assertCurrent: () => {
              if (retired) throw new Error("Owner retired");
            },
            stream: { getRole: () => ({ role: "follower", ownerClientId: "window-owner" }) },
            coordination: {
              requestThreadFollower: (input: (typeof requests)[number]) => {
                requests.push(input);
                return Promise.resolve({
                  resultType: "success",
                  result:
                    input.request.method === "thread-follower-interrupt-turn"
                      ? { interruptedTurnId: "turn" }
                      : error
                        ? { error: { reason: "unsupported", message: "Action unavailable" } }
                        : { value: { sequence: 7 } },
                });
              },
            },
          }),
      } as never),
      Effect.provideService(CodexMainConversationResume, {
        resume: () => Effect.die("Existing owners do not need resume"),
      } as never),
      Effect.provideService(CodexMainConversationInterrupt, {
        interrupt: () => Effect.die("The selected peer must stop its own execution"),
      } as never),
      Effect.provideService(CodexQueuedFollowUps, {} as never),
      Effect.provideService(CodexTurnCommands, {} as never),
    );
    return {
      controls,
      requests,
      setError: () => {
        error = true;
      },
      retire: () => {
        retired = true;
      },
    };
  });

  it.effect.each(["local", "remote"])("routes native Stop through the %s execution owner", (host) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      assert.isTrue(yield* f.controls.stop(host, "thread"));
      assert.deepEqual(f.requests, [
        {
          hostId: host,
          targetClientId: "window-owner",
          request: {
            method: "thread-follower-interrupt-turn",
            params: { conversationId: "thread", mode: "user-stop" },
          },
        },
      ]);
    }),
  );

  it.effect("routes every remote queue action and preserves typed owner refusals", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const action of ["list", "read", "edit", "remove", "reorder", "steer"] as const) {
        const args = {
          sessionId: "session",
          action,
          queuedId: "queued",
          beforeId: null,
          text: "text",
          limit: 20,
        };
        // The application boundary owns action-specific validation; the selected owner receives its exact command.
        assert.deepEqual(yield* f.controls.queue("remote", "thread", args), { sequence: 7 });
      }
      assert.lengthOf(f.requests, 6);
      assert.isTrue(
        f.requests.every(
          (request) =>
            request.request.method === "thread-follower-session-queue" &&
            request.hostId === "remote",
        ),
      );
      f.setError();
      const error = yield* f.controls
        .queue("remote", "thread", { action: "remove", sessionId: "session", queuedId: "queued" })
        .pipe(Effect.result);
      assert.equal(error._tag, "Failure");
      if (error._tag === "Failure")
        assert.equal((error.failure as { reason: string }).reason, "unsupported");
    }),
  );

  it.effect(
    "refuses unsupported local queues and never reroutes a control after owner retirement",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const local = yield* f.controls
          .queue("local", "thread", { action: "list", sessionId: "session", limit: 20 })
          .pipe(Effect.result);
        assert.equal(local._tag, "Failure");
        if (local._tag === "Failure")
          assert.equal((local.failure as { reason: string }).reason, "unsupported");
        assert.isEmpty(f.requests);
        f.retire();
        assert.isTrue(yield* f.controls.stop("remote", "thread").pipe(Effect.isFailure));
        assert.isEmpty(f.requests);
      }),
  );
});
