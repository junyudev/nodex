import { describe } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { make } from "./CodexDelegatedMessages";
import { CodexMainConversationResume } from "./CodexMainConversationResume";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexTurnCommands, type CodexTurnStartOverrides } from "./CodexTurnCommands";
import { ConversationEntityMap, live as entitiesLayer } from "./internal/ConversationEntityMap";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { createSteerTurnInactiveError } from "../../shared/codex-steer-errors";
import type { ConversationFollowerRequest } from "../../shared/codex-client-coordination";
import type { ConversationStreamRole } from "../../shared/codex-conversation-stream";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import {
  makeTestTurnPresentation,
  testSubmitPresentation,
} from "./CodexTurnPresentation.test-support";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CodexMainConversationSettings } from "./CodexMainConversationSettings";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import {
  CodexManualCompactionClosedError,
  CodexManualCompactionRuntime,
  live,
} from "./CodexManualCompactionRuntime";

describe("CodexDelegatedMessages", () => {
  const fixture = (active: boolean, recovering = false) =>
    Effect.gen(function* () {
      const trace: string[] = [];
      const resumeTiers: Array<string | null | undefined> = [];
      const forwarded: ConversationFollowerRequest[] = [];
      const queue: Array<{ id: string; clientUserMessageId: string; input: unknown[] }> = [];
      const nativeWrites: string[] = [];
      const controls = {
        state: conversationFixture("target", active ? [turnFixture("active", "inProgress")] : []),
        generation: 1,
        role: { role: "follower", ownerClientId: "window" } as ConversationStreamRole,
        routeHostId: "local",
        afterResume: () => {},
        afterSettings: () => {},
        afterPreparation: () => {},
        afterExecution: () => {},
        steerFailure: createSteerTurnInactiveError("target") as Error | null,
      };
      let entity = { readCanonicalState: () => controls.state };
      const manager = {
        get generation() {
          return controls.generation;
        },
        assertCurrent: (generation = controls.generation) => {
          if (generation !== controls.generation) throw new Error("Native connection changed");
        },
        stream: { getRole: () => controls.role },
        coordination: {
          requestThreadFollower: ({ request }: { request: ConversationFollowerRequest }) => {
            forwarded.push(request);
            if (request.method === "thread-follower-update-thread-settings") {
              controls.afterSettings();
            } else {
              controls.afterExecution();
            }
            if (request.method === "thread-follower-interrupt-turn")
              controls.state = conversationFixture("target", [
                turnFixture("active", "interrupted"),
              ]);
            if (request.method === "thread-follower-steer-turn" && controls.steerFailure)
              return Promise.reject(controls.steerFailure);
            return Promise.resolve({
              resultType: "success",
              result: { result: { turn: { id: "turn" } } },
            });
          },
        },
      };
      const service = yield* make.pipe(
        Effect.provideService(CodexGateway, {
          requestOnHost: (
            _host: string,
            method: string,
            input: { clientUserMessageId?: string; input?: unknown[] },
          ) =>
            Effect.sync(() => {
              if (method === "thread/queue/list") return { data: queue, nextCursor: null };
              if (method === "thread/turns/list")
                return { data: [], nextCursor: "unloaded-older-page" };
              if (method !== "thread/queue/add") throw new Error("Unexpected native write");
              nativeWrites.push(method);
              const queuedSubmission = {
                id: "queued",
                clientUserMessageId: input.clientUserMessageId!,
                input: input.input!,
              };
              queue.push(queuedSubmission);
              return { queuedSubmission };
            }).pipe(Effect.tap(() => Effect.yieldNow)),
        } as unknown as CodexGateway["Service"]),
        Effect.provideService(CodexAppServerCapabilities, {
          forHost: () => Effect.succeed({ generation: 1, flags: { threadQueue: true } }),
        } as unknown as CodexAppServerCapabilities["Service"]),
        Effect.provideService(CodexMainConversationResume, {
          resume: (_threadId, options) =>
            Effect.sync(() => {
              trace.push("resume");
              controls.afterResume();
              resumeTiers.push(options?.serviceTier);
              return recovering
                ? ({ status: "not-ready", reason: "owner-recovering" } as const)
                : ({ status: "ready", snapshot: null } as const);
            }),
        }),
        Effect.provideService(CodexThreadHostResolver, {
          resolve: () => Effect.sync(() => controls.routeHostId),
        }),
        Effect.provideService(ConversationEntityMap, {
          current: () => entity,
        } as unknown as ConversationEntityMap["Service"]),
        Effect.provideService(CodexMainConversationManagers, {
          get: () => Effect.succeed(manager),
        } as unknown as CodexMainConversationManagers["Service"]),
        Effect.provideService(CodexTurnCommands, {
          prepareNativeToolMessage: (
            _thread: string,
            source: string,
            prompt: string,
            mode: "start" | "steer",
            overrides?: CodexTurnStartOverrides,
          ) =>
            Effect.sync(() => {
              trace.push(`prepare:${mode}:${source}:${prompt}`);
              controls.afterPreparation();
              const steer = {
                conversationId: "target",
                clientUserMessageId: overrides?.clientUserMessageId ?? mode,
                input: [],
                attachments: [],
                restoreMessage: { context: { commentAttachments: [] } },
                toolOutput: {
                  name: "send_message_to_thread",
                  namespace: "codex_app",
                  output: prompt,
                },
              };
              return {
                steer,
                ...(mode === "start"
                  ? {
                      start: {
                        request: {
                          threadId: "target",
                          input: [],
                          clientUserMessageId: mode,
                          toolOutput: steer.toolOutput,
                        },
                      },
                    }
                  : {}),
              };
            }),
          releasePreparedNativeStart: (id: string) => {
            trace.push(`release-start:${id}`);
          },
          releasePreparedNativeSteer: (id: string) => {
            trace.push(`release-steer:${id}`);
          },
        } as unknown as CodexTurnCommands["Service"]),
      );
      return {
        service,
        trace,
        resumeTiers,
        forwarded,
        controls,
        queue,
        nativeWrites,
        replaceEntity: () => {
          entity = { readCanonicalState: () => controls.state };
        },
      };
    });
  it.effect("does not prepare or forward a delegated message while its owner is recovering", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false, true);
      const outcome = yield* f.service.send("target", "source", "continue").pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      assert.deepEqual(f.trace, ["resume"]);
      assert.deepEqual(f.forwarded, []);
    }),
  );
  it.effect(
    "resumes an unloaded delegated target before forwarding its admitted native start",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false);
        yield* f.service.send("target", "source", "continue");
        assert.deepEqual(f.trace.slice(0, 2), ["resume", "prepare:start:source:continue"]);
        assert.strictEqual(f.forwarded[0]?.method, "thread-follower-start-turn");
        assert.ok(f.trace.includes("release-start:start"));
      }),
  );
  it.effect(
    "reprepares a delegated start when the owner's active turn ends during forwarding",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true);
        yield* f.service.send("target", "source", "continue");
        assert.deepEqual(
          f.forwarded.map((request) => request.method),
          ["thread-follower-steer-turn", "thread-follower-start-turn"],
        );
        assert.deepEqual(f.trace.slice(0, 4), [
          "resume",
          "prepare:steer:source:continue",
          "release-steer:steer",
          "prepare:start:source:continue",
        ]);
      }),
  );
  it.effect("updates owner settings before preparing and steering an active delegated task", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      yield* f.service.send("target", "source", "continue", {
        model: "next-model",
        reasoningEffort: "high",
        serviceTier: "priority",
      });
      assert.deepEqual(f.resumeTiers, ["priority"]);
      assert.strictEqual(f.forwarded[0]?.method, "thread-follower-update-thread-settings");
      assert.deepEqual(f.forwarded[0]?.params, {
        conversationId: "target",
        threadSettings: { model: "next-model", effort: "high" },
      });
      assert.deepEqual(
        f.forwarded.map((request) => request.method),
        [
          "thread-follower-update-thread-settings",
          "thread-follower-steer-turn",
          "thread-follower-start-turn",
        ],
      );
    }),
  );

  for (const activeAfterSettings of [false, true]) {
    it.effect(
      `selects the current delegated Turn after settings finish: active=${activeAfterSettings}`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(!activeAfterSettings);
          f.controls.afterSettings = () => {
            f.controls.state = conversationFixture("target", [
              turnFixture("current", activeAfterSettings ? "inProgress" : "completed"),
            ]);
          };
          yield* f.service.send("target", "source", "continue", { model: "next-model" });
          assert.strictEqual(
            f.trace.find((entry) => entry.startsWith("prepare:")),
            `prepare:${activeAfterSettings ? "steer" : "start"}:source:continue`,
          );
        }),
    );
  }

  it.effect("does not steer an older active resident Turn after a newer Turn completed", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      f.controls.state = conversationFixture("target", [
        turnFixture("older", "inProgress"),
        turnFixture("latest", "completed"),
      ]);
      yield* f.service.send("target", "source", "continue");
      assert.strictEqual(f.trace[1], "prepare:start:source:continue");
      assert.strictEqual(f.forwarded[0]?.method, "thread-follower-start-turn");
    }),
  );

  for (const phase of ["afterSettings", "afterPreparation", "afterExecution"] as const) {
    it.effect(`rejects a delegated native generation changed ${phase}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(true);
        f.controls[phase] = () => {
          f.controls.generation += 1;
        };
        const result = yield* f.service
          .send("target", "source", "continue", { model: "next-model" })
          .pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.isFalse(f.trace.includes("prepare:start:source:continue"));
        assert.strictEqual(
          f.forwarded.filter((request) => request.method === "thread-follower-steer-turn").length,
          phase === "afterExecution" ? 1 : 0,
        );
        if (phase !== "afterSettings") assert.ok(f.trace.includes("release-steer:steer"));
      }),
    );
  }

  for (const change of ["entity", "owner-reacquired"] as const) {
    it.effect(`rejects delegated preparation after its ${change} lifetime changes`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(true);
        f.controls.afterPreparation = () => {
          if (change === "entity") f.replaceEntity();
          else f.controls.role = { role: "follower", ownerClientId: "window" };
        };
        const result = yield* f.service.send("target", "source", "continue").pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.deepEqual(f.forwarded, []);
        assert.ok(f.trace.includes("release-steer:steer"));
      }),
    );
  }

  it.effect("rejects a late successful delegated response from a retired native generation", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      f.controls.steerFailure = null;
      f.controls.afterExecution = () => {
        f.controls.generation += 1;
      };
      const result = yield* f.service.send("target", "source", "continue").pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(f.forwarded.length, 1);
      assert.ok(f.trace.includes("release-steer:steer"));
    }),
  );

  it.effect("queues one stable native message and proves a retry from the producer queue", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const options = { clientUserMessageId: "stable-message" };
      const first = yield* f.service.send("target", "source", "continue", options, {
        mode: "queue",
      });
      const retry = yield* f.service.send("target", "source", "continue", options, {
        mode: "queue",
      });
      assert.deepEqual(first, {
        messageId: "stable-message",
        runId: null,
        status: "queued",
        delivery: "queued",
      });
      assert.strictEqual(retry.delivery, "replayed");
      assert.deepEqual(f.nativeWrites, ["thread/queue/add"]);
      assert.deepEqual(f.queue[0]?.input, [{ type: "text", text: "continue", text_elements: [] }]);
      assert.isEmpty(f.forwarded);
    }),
  );

  it.effect("restarts through the captured native owner and returns the accepted Turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const result = yield* f.service.send(
        "target",
        "source",
        "replace",
        { clientUserMessageId: "stable-restart" },
        { mode: "restart" },
      );
      assert.deepEqual(
        f.forwarded.map((request) => request.method),
        ["thread-follower-interrupt-turn", "thread-follower-start-turn"],
      );
      assert.strictEqual(result.delivery, "restarted");
      assert.strictEqual(result.runId, "turn");
      assert.strictEqual(result.messageId, "stable-restart");
    }),
  );

  it.effect("strict steer never starts a different Turn when no active Turn exists", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      const result = yield* f.service
        .send("target", "source", "steer", { model: "another-model" }, { mode: "steer" })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.isEmpty(f.forwarded);
      assert.deepEqual(f.trace, ["resume"]);
    }),
  );

  it.effect("serializes concurrent queue retries before producer admission", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const send = f.service.send(
        "target",
        "source",
        "continue",
        { clientUserMessageId: "concurrent-stable" },
        { mode: "queue" },
      );
      const results = yield* Effect.all([send, send], { concurrency: "unbounded" });
      assert.deepEqual(results.map((result) => result.delivery).sort(), ["queued", "replayed"]);
      assert.deepEqual(f.nativeWrites, ["thread/queue/add"]);
    }),
  );

  it.effect("rejects a final prepared start that would leave the caller's Plan ceiling", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      const result = yield* f.service
        .send("target", "source", "config overrides Plan", undefined, {
          interactionModeCeiling: "plan",
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.isEmpty(f.forwarded);
      assert.ok(f.trace.includes("release-start:start"));
    }),
  );

  it.effect("cannot blindly replay a message whose bounded producer lookup did not close", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      const result = yield* f.service.reconcile({
        hostId: "local",
        threadId: "target",
        messageId: "historical-message",
      });
      assert.strictEqual(result.delivery, "unconfirmed");
      assert.isNull(result.runId);
      assert.isEmpty(f.forwarded);
      assert.isEmpty(f.nativeWrites);
    }),
  );

  it.effect("reconciles original producer evidence without resuming an unloaded conversation", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false, true);
      f.queue.push({ id: "queued", clientUserMessageId: "message", input: [] });
      const result = yield* f.service.reconcile({
        hostId: "local",
        threadId: "target",
        messageId: "message",
      });
      assert.equal(result.delivery, "replayed");
      assert.equal(result.status, "queued");
      assert.isEmpty(f.trace);
      assert.isEmpty(f.forwarded);
      assert.isEmpty(f.nativeWrites);
    }),
  );

  it.effect("refuses a host change before resume without preparing or forwarding a message", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      f.controls.routeHostId = "another-host";
      assert.equal(
        (yield* f.service
          .send("target", "source", "continue", undefined, { expectedHostId: "local" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.isEmpty(f.trace);
      assert.isEmpty(f.forwarded);
    }),
  );

  it.effect("refuses a host change during resume without preparing or forwarding a message", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      f.controls.afterResume = () => {
        f.controls.routeHostId = "another-host";
      };
      assert.equal(
        (yield* f.service
          .send("target", "source", "continue", undefined, { expectedHostId: "local" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.deepEqual(f.trace, ["resume"]);
      assert.isEmpty(f.forwarded);
    }),
  );

  it.effect("refuses a retained canonical entity from a different host", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      f.controls.state = conversationFixture("target", [], "another-host");
      assert.equal(
        (yield* f.service
          .send("target", "source", "continue", undefined, { expectedHostId: "local" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.deepEqual(f.trace, ["resume"]);
      assert.isEmpty(f.forwarded);
    }),
  );

  it.effect("revalidates application binding immediately before forwarding prepared input", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      let valid = true;
      f.controls.afterPreparation = () => {
        valid = false;
      };
      let dispatched = false;
      const result = yield* f.service
        .send("target", "source", "continue", undefined, {
          expectedHostId: "local",
          beforeNativeDispatch: Effect.gen(function* () {
            if (!valid) return yield* Effect.fail(new Error("binding changed"));
          }),
          onNativeDispatch: () => {
            dispatched = true;
          },
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.isFalse(dispatched);
      assert.isEmpty(f.forwarded);
      assert.isEmpty(f.nativeWrites);
    }),
  );
});

describe("CodexTurnPresentation", () => {
  const target = { kind: "thread", threadId: "thread-a" } as const;
  const setup = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const presentation = yield* makeTestTurnPresentation.pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    const ticket = yield* presentation.capture(11, {
      target,
      presentation: testSubmitPresentation,
    });
    return { scope, presentation, ticket };
  });

  it.effect(
    "acknowledged queued edits replace only their unstarted message origin and retain exact edit retries",
    () =>
      Effect.gen(function* () {
        const { scope, presentation, ticket } = yield* setup;
        yield* presentation.admitRuntimeMessage(ticket, target, target.threadId, "queued-message");
        const edit = yield* presentation.capture(11, {
          target,
          presentation: { ...testSubmitPresentation, presentationRevision: 9 },
        });
        const accepted = yield* presentation.replaceQueuedRuntimeMessage(
          edit,
          target.threadId,
          "queued-message",
          "edit-one",
        );
        const retried = yield* presentation.capture(11, {
          target,
          presentation: { ...testSubmitPresentation, presentationRevision: 10 },
        });
        assert.deepEqual(
          yield* presentation.replaceQueuedRuntimeMessage(
            retried,
            target.threadId,
            "queued-message",
            "edit-one",
          ),
          accepted,
        );
        const source = {
          runtimeId: "runtime",
          runtimeGeneration: "lease",
          providerSessionId: "native",
          nativeGeneration: 1,
        };
        yield* presentation.observeRuntimeMessage(
          target.threadId,
          "run-queued",
          "queued-message",
          source,
        );
        assert.equal(presentation.read(target.threadId, "run-queued")?.presentationRevision, 9);
        const late = yield* presentation.capture(11, {
          target,
          presentation: { ...testSubmitPresentation, presentationRevision: 11 },
        });
        assert.isNull(
          yield* presentation.replaceQueuedRuntimeMessage(
            late,
            target.threadId,
            "queued-message",
            "edit-two",
          ),
        );
        assert.equal(presentation.read(target.threadId, "run-queued")?.presentationRevision, 9);
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect(
    "retains an exact Session message origin through engine retries and later foreground messages",
    () =>
      Effect.gen(function* () {
        const { scope, presentation } = yield* setup;
        const sessionTarget = {
          kind: "session",
          sessionId: "product-session",
          launchId: "stable-launch",
        } as const;
        const ticket = yield* presentation.capture(11, {
          target: sessionTarget,
          presentation: testSubmitPresentation,
        });
        const first = yield* presentation.admitRuntimeMessage(
          ticket,
          sessionTarget,
          "engine-root",
          "message-a",
        );
        assert.deepEqual(
          yield* presentation.admitRuntimeMessage(
            ticket,
            sessionTarget,
            "engine-root",
            "message-a",
          ),
          first,
        );
        assert.equal(
          (yield* presentation
            .admitRuntimeMessage(ticket, sessionTarget, "other-thread", "message-a")
            .pipe(Effect.flip)).reason,
          "submission_mismatch",
        );
        const source = {
          runtimeId: "runtime",
          runtimeGeneration: "lease",
          providerSessionId: "native-a",
          nativeGeneration: 1,
        };
        yield* presentation.observeRuntimeMessage("engine-root", "run-a", "message-a", source);
        const nextTarget = { kind: "thread", threadId: "engine-root" } as const;
        const nextTicket = yield* presentation.capture(11, {
          target: nextTarget,
          presentation: { ...testSubmitPresentation, presentationRevision: 9 },
        });
        yield* presentation.admitRuntimeMessage(nextTicket, nextTarget, "engine-root", "message-b");
        yield* presentation.observeRuntimeMessage("engine-root", "run-b", "message-b", {
          ...source,
          providerSessionId: "native-b",
        });
        assert.equal(presentation.read("engine-root", "run-a")?.presentationRevision, 7);
        assert.equal(presentation.read("engine-root", "run-b")?.presentationRevision, 9);
        const recaptured = yield* presentation.capture(11, {
          target: sessionTarget,
          presentation: { ...testSubmitPresentation, presentationRevision: 10 },
        });
        assert.deepEqual(
          yield* presentation.admitRuntimeMessage(
            recaptured,
            sessionTarget,
            "engine-root",
            "message-a",
          ),
          first,
        );
        assert.equal(presentation.read("engine-root", "run-a")?.presentationRevision, 7);
        assert.isNull(presentation.read("engine-root", "unknown-run"));
        assert.deepEqual(
          yield* presentation.admitRuntimeMessage(
            ticket,
            sessionTarget,
            "engine-root",
            "message-a",
          ),
          first,
        );
        presentation.finishRuntimeSource({ ...source, nativeGeneration: 2 });
        assert.equal(presentation.read("engine-root", "run-a")?.presentationRevision, 7);
        presentation.finishRuntimeSource(source);
        assert.isNull(presentation.read("engine-root", "run-a"));
        assert.equal(presentation.read("engine-root", "run-b")?.presentationRevision, 9);
        presentation.finishRuntimeLease("runtime", "old-lease");
        assert.equal(presentation.read("engine-root", "run-b")?.presentationRevision, 9);
        presentation.finishRuntimeLease("runtime", "lease");
        assert.isNull(presentation.read("engine-root", "run-b"));
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect(
    "stamps the submitting window and binds exact client identity before the response",
    () =>
      Effect.gen(function* () {
        const { scope, presentation, ticket } = yield* setup;
        assert.equal(
          (yield* presentation
            .capture(99, { target, presentation: testSubmitPresentation })
            .pipe(Effect.flip)).reason,
          "unavailable",
        );
        assert.equal(
          (yield* presentation
            .capture(22, { target, presentation: testSubmitPresentation })
            .pipe(Effect.flip)).reason,
          "stale_renderer",
        );
        assert.equal(
          (yield* presentation
            .claim(ticket, { kind: "thread", threadId: "other" }, "client-a")
            .pipe(Effect.flip)).reason,
          "target_mismatch",
        );
        const claim = yield* presentation.claim(ticket, target, "client-a");
        assert.equal(
          (yield* presentation.claim(ticket, target, "other-client").pipe(Effect.flip)).reason,
          "submission_mismatch",
        );
        const launch = yield* presentation.begin(claim, target.threadId);
        yield* presentation.observeUserMessage(target.threadId, "unrelated", null);
        yield* presentation.observeUserMessage(target.threadId, "unrelated", "other-client");
        assert.isNull(presentation.read(target.threadId, "unrelated"));
        yield* presentation.observeUserMessage(target.threadId, "accepted", "client-a");
        const anchor = presentation.read(target.threadId, "accepted");
        assert.deepInclude(anchor, { ...testSubmitPresentation, windowSessionId: "window-a" });
        yield* presentation.bind(launch, "accepted");
        assert.equal(
          (yield* presentation.claim(ticket, target, "client-a").pipe(Effect.flip)).reason,
          "already_accepted",
        );
        assert.equal(
          (yield* presentation.bind(launch, "other-turn").pipe(Effect.flip)).reason,
          "turn_mismatch",
        );
        presentation.finish(target.threadId, "accepted");
        assert.isNull(presentation.read(target.threadId, "accepted"));
        yield* presentation.bind(launch, "accepted");
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect(
    "does not guess between concurrent submissions and permits proven-rejection retry",
    () =>
      Effect.gen(function* () {
        const { scope, presentation, ticket } = yield* setup;
        const claim = yield* presentation.claim(ticket, target, "client-a");
        const first = yield* presentation.begin(claim, target.threadId);
        assert.equal(
          (yield* presentation.begin(claim, target.threadId).pipe(Effect.flip)).reason,
          "in_flight",
        );
        const secondTicket = yield* presentation.capture(22, {
          target,
          presentation: { ...testSubmitPresentation, rendererGeneration: "renderer-b" },
        });
        const secondClaim = yield* presentation.claim(secondTicket, target, "client-a");
        const second = yield* presentation.begin(secondClaim, target.threadId);
        yield* presentation.observeUserMessage(target.threadId, "ambiguous", "client-a");
        assert.isNull(presentation.read(target.threadId, "ambiguous"));
        presentation.abort(first);
        presentation.releaseClaim(claim);
        yield* presentation.observeUserMessage(target.threadId, "accepted", "client-a");
        assert.equal(presentation.read(target.threadId, "accepted")?.windowSessionId, "window-b");
        const retryTicket = yield* presentation.capture(11, {
          target,
          presentation: testSubmitPresentation,
        });
        const retryClaim = yield* presentation.claim(retryTicket, target, "retry-client");
        const rejected = yield* presentation.begin(retryClaim, target.threadId);
        presentation.abort(rejected);
        const retry = yield* presentation.begin(retryClaim, target.threadId);
        yield* presentation.bind(retry, "retried");
        yield* presentation.bind(second, "accepted");
        yield* Scope.close(scope, Exit.void);
        assert.isNull(presentation.read(target.threadId, "retried"));
      }),
  );

  it.effect("retains queued origins across time and prunes only settled queue claims", () =>
    Effect.gen(function* () {
      const { scope, presentation, ticket } = yield* setup;
      const queued = yield* presentation.claim(ticket, target, "queued-client");
      presentation.retainQueued(queued);
      const ordinaryTicket = yield* presentation.capture(11, {
        target,
        presentation: testSubmitPresentation,
      });
      const ordinary = yield* presentation.claim(ordinaryTicket, target, "ordinary-client");
      const expired = yield* presentation.capture(11, {
        target,
        presentation: testSubmitPresentation,
      });
      yield* TestClock.adjust("16 minutes");
      assert.isUndefined(yield* presentation.claim(expired, target, "expired-client"));
      assert.deepEqual(presentation.readQueued(target.threadId, "queued-client"), queued);
      assert.isUndefined(presentation.readQueued("other-thread", "queued-client"));
      presentation.reconcileQueued(target.threadId, []);
      assert.isUndefined(presentation.readQueued(target.threadId, "queued-client"));
      const launch = yield* presentation.begin(ordinary, target.threadId);
      yield* presentation.bind(launch, "ordinary-turn");
      assert.equal(presentation.read(target.threadId, "ordinary-turn")?.presentationRevision, 7);
      assert.isNull(yield* presentation.begin(undefined, "autonomous-thread"));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("binds a fresh Session submission to its materialized Conversation", () =>
    Effect.gen(function* () {
      const { scope, presentation } = yield* setup;
      const freshTarget = {
        kind: "session",
        sessionId: "session-a",
        launchId: "launch-a",
      } as const;
      const ticket = yield* presentation.capture(11, {
        target: freshTarget,
        presentation: testSubmitPresentation,
      });
      assert.equal(
        (yield* presentation
          .claim(ticket, { ...freshTarget, launchId: "other-launch" }, "fresh-client")
          .pipe(Effect.flip)).reason,
        "target_mismatch",
      );
      const claim = yield* presentation.claim(ticket, freshTarget, "fresh-client");
      const launch = yield* presentation.begin(claim, "new-thread");
      yield* presentation.bind(launch, "first-turn");
      assert.equal(presentation.read("new-thread", "first-turn")?.windowSessionId, "window-a");
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "freezes selected Page identity even when its tab is reused or a reader mutates a snapshot",
    () =>
      Effect.gen(function* () {
        const { scope, presentation } = yield* setup;
        const selected = {
          tabId: "preview-page",
          panelId: "right" as const,
          groupId: "group-a",
          protected: false,
          persisted: false,
          preview: true,
          selected: true,
          visible: true,
          auxiliary: null,
          surface: {
            id: "preview-page",
            kind: "page_stage" as const,
            titleSnapshot: "Original page",
            config: {
              routingContext: { kind: "project" as const, projectId: "project-a" },
              pageId: "page-a",
            },
          },
        };
        const ticket = yield* presentation.capture(11, {
          target,
          presentation: {
            ...testSubmitPresentation,
            focusedTarget: null,
            selectedTabs: [selected],
          },
        });
        selected.surface.config.pageId = "replacement-page";
        const claim = yield* presentation.claim(ticket, target, "selected-client");
        const launch = yield* presentation.begin(claim, target.threadId);
        yield* presentation.bind(launch, "selected-turn");
        const anchor = presentation.read(target.threadId, "selected-turn");
        const surface = anchor?.selectedTabs[0]?.surface;
        if (surface?.kind !== "page_stage") throw new Error("Expected the original selected Page");
        assert.equal(surface.config.pageId, "page-a");
        Reflect.set(surface.config, "pageId", "reader-replacement");
        const reread = presentation.read(target.threadId, "selected-turn")?.selectedTabs[0]
          ?.surface;
        assert.equal(reread?.kind === "page_stage" ? reread.config.pageId : null, "page-a");
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect(
    "bounds retained metadata bytes and releases capacity without evicting an accepted Turn",
    () =>
      Effect.gen(function* () {
        const { scope, presentation } = yield* setup;
        const metadata = (count: number) => ({
          ...testSubmitPresentation,
          selectedTabs: Array.from({ length: count }, (_, index) => ({
            tabId: `plan-${index}`,
            panelId: "right" as const,
            groupId: `group-${index}`,
            protected: false,
            persisted: false,
            preview: false,
            selected: true,
            visible: true,
            surface: null,
            auxiliary: { kind: "plan" as const, title: "x".repeat(1_900) },
          })),
        });
        const oversized = yield* presentation
          .capture(11, { target, presentation: metadata(400) })
          .pipe(Effect.flip);
        assert.equal(oversized.reason, "capacity");
        assert.include(oversized.message, "768 KiB");
        const snapshot = metadata(100);
        const tickets: { ticketId: string }[] = [];
        for (let index = 0; index < 200; index += 1) {
          const result = yield* presentation
            .capture(11, { target, presentation: snapshot })
            .pipe(Effect.result);
          if (result._tag === "Failure") {
            assert.equal(result.failure.reason, "capacity");
            assert.include(result.failure.message, "32 MiB");
            break;
          }
          tickets.push(result.success);
        }
        assert.isAbove(tickets.length, 1);
        assert.isBelow(tickets.length, 200);
        const acceptedClaim = yield* presentation.claim(tickets[0]!, target, "accepted-budget");
        const accepted = yield* presentation.begin(acceptedClaim, target.threadId);
        yield* presentation.bind(accepted, "accepted-budget-turn");
        assert.equal(
          (yield* presentation.capture(11, { target, presentation: snapshot }).pipe(Effect.flip))
            .reason,
          "capacity",
        );
        assert.isNotNull(presentation.read(target.threadId, "accepted-budget-turn"));
        const removed = yield* presentation.claim(tickets[1]!, target, "released-budget");
        presentation.releaseClaim(removed);
        yield* presentation.capture(11, { target, presentation: snapshot });
        presentation.finish(target.threadId, "accepted-budget-turn");
        yield* presentation.capture(11, { target, presentation: snapshot });
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect(
    "uses the latest accepted submission and ignores delayed acknowledgements of older origins",
    () =>
      Effect.gen(function* () {
        const { scope, presentation, ticket } = yield* setup;
        const first = yield* presentation.begin(
          yield* presentation.claim(ticket, target, "first-message"),
          target.threadId,
        );
        const secondTicket = yield* presentation.capture(22, {
          target,
          presentation: { ...testSubmitPresentation, rendererGeneration: "renderer-b" },
        });
        const second = yield* presentation.begin(
          yield* presentation.claim(secondTicket, target, "second-message"),
          target.threadId,
        );
        yield* presentation.observeUserMessage(target.threadId, "same-turn", "second-message");
        const frozen = presentation.read(target.threadId, "same-turn");
        yield* presentation.bind(first, "same-turn");
        expectOrigin(presentation.read(target.threadId, "same-turn"), "window-b");
        yield* presentation.bind(second, "same-turn");
        expectOrigin(presentation.read(target.threadId, "same-turn"), "window-b");
        assert.equal(frozen?.windowSessionId, "window-b");
        presentation.finish(target.threadId, "same-turn");
        assert.isNull(presentation.read(target.threadId, "same-turn"));
        yield* presentation.bind(first, "same-turn");
        yield* presentation.bind(second, "same-turn");
        yield* Scope.close(scope, Exit.void);
      }),
  );

  function expectOrigin(anchor: { windowSessionId: string } | null, windowSessionId: string) {
    assert.equal(anchor?.windowSessionId, windowSessionId);
  }

  it.effect(
    "an accepted submission without context clears the older origin without affecting frozen readers",
    () =>
      Effect.gen(function* () {
        const { scope, presentation, ticket } = yield* setup;
        const first = yield* presentation.begin(
          yield* presentation.claim(ticket, target, "first-message"),
          target.threadId,
        );
        yield* presentation.bind(first, "turn");
        const frozen = presentation.read(target.threadId, "turn");
        const absent = yield* presentation.begin(
          undefined,
          target.threadId,
          "restored-queued-message",
        );
        yield* presentation.observeUserMessage(target.threadId, "turn", "restored-queued-message");
        assert.isNull(presentation.read(target.threadId, "turn"));
        expectOrigin(frozen, "window-a");
        yield* presentation.bind(absent, "turn");
        yield* presentation.bind(first, "turn");
        assert.isNull(presentation.read(target.threadId, "turn"));
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect("does not resurrect context when completion precedes a late steer response", () =>
    Effect.gen(function* () {
      const { scope, presentation, ticket } = yield* setup;
      const claim = yield* presentation.claim(ticket, target, "late-message");
      const launch = yield* presentation.begin(claim, target.threadId);
      presentation.finish(target.threadId, "completed-turn");
      yield* presentation.bind(launch, "completed-turn");
      assert.isNull(presentation.read(target.threadId, "completed-turn"));
      yield* presentation.bind(launch, "completed-turn");
      yield* Scope.close(scope, Exit.void);
    }),
  );
});

describe("CodexManualCompactionRuntime", () => {
  const threadId = "thread-manual-compaction";
  const turnId = "turn-manual-compaction";

  const gateway = (
    request: CodexGateway["Service"]["requestForThread"],
  ): CodexGateway["Service"] => {
    const unsupported = () => Effect.die(new Error("Unsupported test operation"));
    return CodexGateway.of({
      promoteQueuedCatalogPage: Effect.succeed(false),
      localHostId: "local",
      requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
      requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
      events: Stream.empty,
      requestLocal: unsupported as CodexGateway["Service"]["requestLocal"],
      requestOnHost: unsupported as CodexGateway["Service"]["requestOnHost"],
      requestForThread: request,
      notifyLocal: unsupported,
      connection: unsupported,
      connectionChanges: () => Stream.empty,
      awaitReady: unsupported,
      reconcileHost: unsupported,
      removeHost: unsupported,
      restartHost: unsupported,
    });
  };

  const ownerFixture = Effect.fn("CodexManualCompactionRuntimeTest.ownerFixture")(function* (
    providedScope?: Scope.Scope,
  ) {
    const scope = providedScope ?? (yield* Scope.Scope);
    const entities = Context.get(
      yield* Layer.buildWithScope(entitiesLayer, scope),
      ConversationEntityMap,
    );
    const install = () => {
      const entity = entities.entity(threadId);
      entity.installFollowerCanonicalState(
        conversationFixture(threadId, [turnFixture(turnId, "inProgress")]),
      );
      return entity;
    };
    const entity = install();
    const calls: string[] = [];
    const resets = new Set<() => void>();
    const controls = {
      generation: 1,
      role: { role: "owner" } as ConversationStreamRole | null,
      settings: Effect.void as Effect.Effect<void, Error>,
      native: Effect.succeed({}) as Effect.Effect<{}, Error>,
      peerError: null as Error | null,
    };
    const manager = {
      hostId: "local",
      get generation() {
        return controls.generation;
      },
      stream: {
        getRole: () => controls.role,
        removeConversation: () => {
          controls.role = null;
        },
      },
      assertCurrent: (generation = controls.generation) => {
        if (generation !== controls.generation) throw new Error("Native generation changed");
      },
      onConnectionReset: (callback: () => void) => {
        resets.add(callback);
        return {
          [Symbol.dispose]() {
            resets.delete(callback);
          },
        };
      },
      onDispose: () => ({ [Symbol.dispose]() {} }),
      coordination: {
        requestThreadFollower: () => {
          calls.push("peer");
          return controls.peerError
            ? Promise.reject(controls.peerError)
            : Promise.resolve({ resultType: "success", result: { ok: true } });
        },
      },
    };
    const native = (...args: unknown[]) =>
      Effect.suspend(() => {
        calls.push("native");
        assert.strictEqual(args[1], "thread/compact/start");
        const options = args[3] as { expectedGeneration?: number } | undefined;
        if (options) assert.strictEqual(options.expectedGeneration, controls.generation);
        return controls.native;
      });
    const context = yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ConversationEntityMap, entities),
            Layer.succeed(CodexGateway, {
              ...gateway(() => Effect.die("Compaction must use its admitted host generation")),
              requestOnHost: native,
            } as CodexGateway["Service"]),
            Layer.succeed(CodexThreadHostResolver, { resolve: () => Effect.succeed("local") }),
            Layer.succeed(CodexMainConversationManagers, {
              get: () => Effect.succeed(manager),
            } as unknown as CodexMainConversationManagers["Service"]),
            Layer.succeed(CodexMainConversationSettings, {
              awaitCurrent: () =>
                Effect.suspend(() => {
                  calls.push("settings");
                  return controls.settings;
                }),
            } as unknown as CodexMainConversationSettings["Service"]),
            Layer.succeed(CodexMainConversationResume, {
              resume: () =>
                Effect.sync(() => {
                  calls.push("resume");
                  controls.role = { role: "owner" };
                  return { status: "ready", snapshot: null } as const;
                }),
            }),
          ),
        ),
      ),
      scope,
    );
    return {
      runtime: Context.get(context, CodexManualCompactionRuntime),
      controls,
      calls,
      entity,
      entities,
      hasPendingItem: () =>
        residentConversationTurns(entity.readCanonicalState()).some((turn) =>
          turn.items.some((item) => item.type === "contextCompaction" && !item.completed),
        ),
      replace: () => entities.retire(threadId).pipe(Effect.map(install)),
      reconnect: () => {
        controls.generation += 1;
        for (const reset of [...resets]) reset();
        controls.role = { role: "owner" };
      },
    };
  });

  it.effect("routes public compaction through the follower's owner after pending settings", () =>
    Effect.gen(function* () {
      const f = yield* ownerFixture();
      f.controls.role = { role: "follower", ownerClientId: "window" };
      yield* f.runtime.start(threadId);
      assert.deepEqual(f.calls, ["settings", "peer"]);
      assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
    }),
  );

  for (const change of ["connection", "entity"] as const) {
    it.effect(`rejects compaction when ${change} changes while settings finish`, () =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        f.controls.settings =
          change === "entity" ? f.replace().pipe(Effect.asVoid) : Effect.sync(f.reconnect);
        const result = yield* f.runtime.start(threadId).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.deepEqual(f.calls, ["settings"]);
        assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
      }),
    );
  }

  it.effect("routes compaction to the owner selected after pending settings finish", () =>
    Effect.gen(function* () {
      const f = yield* ownerFixture();
      f.controls.settings = Effect.sync(() => {
        f.controls.role = { role: "follower", ownerClientId: "new-window" };
      });
      yield* f.runtime.start(threadId);
      assert.deepEqual(f.calls, ["settings", "peer"]);
      assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
    }),
  );

  for (const roleAfterSettings of ["owner", "follower"] as const) {
    it.effect(
      `uses the current ${roleAfterSettings} role when pending settings lose their owner`,
      () =>
        Effect.gen(function* () {
          const f = yield* ownerFixture();
          f.controls.role =
            roleAfterSettings === "owner"
              ? { role: "follower", ownerClientId: "old-window" }
              : { role: "owner" };
          f.controls.settings = Effect.sync(() => {
            f.controls.role =
              roleAfterSettings === "owner"
                ? { role: "owner" }
                : { role: "follower", ownerClientId: "new-window" };
          }).pipe(
            Effect.andThen(
              Effect.fail(
                codexRuntimeError({
                  operation: "settings-test",
                  reason: "request",
                  retryable: false,
                  cause: new Error("no-client-found"),
                }),
              ),
            ),
          );
          const result = yield* f.runtime.start(threadId).pipe(Effect.result);
          assert.strictEqual(result._tag, roleAfterSettings === "follower" ? "Success" : "Failure");
          assert.deepEqual(
            f.calls,
            roleAfterSettings === "follower" ? ["settings", "peer"] : ["settings"],
          );
          assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
        }),
    );
  }

  for (const failure of ["peer timeout", "no-client-found"] as const) {
    it.effect(`recovers a missing compaction owner only for ${failure}`, () =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        f.controls.role = { role: "follower", ownerClientId: "window" };
        f.controls.peerError = new Error(failure);
        const result = yield* f.runtime.start(threadId).pipe(Effect.result);
        assert.strictEqual(result._tag, failure === "no-client-found" ? "Success" : "Failure");
        assert.deepEqual(
          f.calls,
          failure === "no-client-found"
            ? ["settings", "peer", "resume", "settings", "native"]
            : ["settings", "peer"],
        );
      }),
    );
  }

  it.effect("does not accept compaction success after its native connection retires", () =>
    Effect.gen(function* () {
      const f = yield* ownerFixture();
      f.controls.native = Effect.sync(() => {
        f.reconnect();
        return {};
      });
      const result = yield* f.runtime.start(threadId).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
    }),
  );

  it.effect("an old compaction failure cannot consume a new owner's pending request", () =>
    Effect.gen(function* () {
      const f = yield* ownerFixture();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.controls.native = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(
          Effect.fail(
            codexRuntimeError({
              operation: "manual-compaction-test",
              reason: "request",
              retryable: false,
            }),
          ),
        ),
      );
      const old = yield* Effect.forkChild(f.runtime.start(threadId).pipe(Effect.result));
      yield* Deferred.await(entered);
      f.reconnect();
      f.runtime.clear(threadId);
      f.controls.native = Effect.succeed({});
      yield* f.runtime.start(threadId);
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual((yield* Fiber.join(old))._tag, "Failure");
      assert.strictEqual(f.runtime.consumeSource(threadId), "manual");
      assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
    }),
  );

  it.effect("admits compaction before the remote request and correlates its source once", () =>
    Effect.gen(function* () {
      const f = yield* ownerFixture();
      f.controls.native = Effect.sync(() => {
        assert.isTrue(f.hasPendingItem());
        return {};
      });
      yield* f.runtime.start(threadId);
      assert.isTrue(f.hasPendingItem());
      assert.deepEqual(f.calls, ["settings", "native"]);
      assert.strictEqual(f.runtime.consumeSource(threadId), "manual");
      assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
    }),
  );

  it.effect("keeps the optimistic projection while another admitted request remains", () =>
    Effect.gen(function* () {
      const f = yield* ownerFixture();
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      const failure = codexRuntimeError({
        operation: "manual-compaction-test",
        reason: "request",
        retryable: false,
      });
      let requestCount = 0;
      f.controls.native = Effect.suspend(() => {
        requestCount += 1;
        return requestCount === 1
          ? Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.andThen(Effect.fail(failure)),
            )
          : Deferred.succeed(secondStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseSecond)),
              Effect.as({}),
            );
      });

      const first = yield* Effect.forkChild(f.runtime.start(threadId));
      yield* Deferred.await(firstStarted);
      const second = yield* Effect.forkChild(f.runtime.start(threadId));
      yield* Deferred.await(secondStarted);
      yield* Deferred.succeed(releaseFirst, undefined);
      assert.strictEqual(yield* Fiber.join(first).pipe(Effect.flip), failure);
      assert.isTrue(f.hasPendingItem());

      yield* Deferred.succeed(releaseSecond, undefined);
      yield* Fiber.join(second);
      assert.strictEqual(f.runtime.consumeSource(threadId), "manual");
      assert.strictEqual(f.runtime.consumeSource(threadId), "automatic");
    }),
  );

  it.effect("compensates an interrupted request and rejects admission after Scope close", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let interrupted = false;
      const scope = yield* Scope.make();
      const f = yield* ownerFixture(scope);
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      f.controls.native = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
      );
      const fiber = yield* f.runtime.start(threadId).pipe(Effect.forkIn(scope));
      yield* Deferred.await(started);

      yield* Scope.close(scope, Exit.void);
      yield* Fiber.await(fiber);
      assert.isTrue(interrupted);
      assert.isFalse(f.hasPendingItem());
      assert.instanceOf(
        yield* f.runtime.start(threadId).pipe(Effect.flip),
        CodexManualCompactionClosedError,
      );
    }),
  );
});
