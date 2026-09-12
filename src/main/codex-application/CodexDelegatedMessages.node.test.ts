import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { make } from "./CodexDelegatedMessages";
import { CodexMainConversationResume } from "./CodexMainConversationResume";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { createSteerTurnInactiveError } from "../../shared/codex-steer-errors";
import type { ConversationFollowerRequest } from "../../shared/codex-client-coordination";
import type { ConversationStreamRole } from "../../shared/codex-conversation-stream";
const fixture = (active: boolean, recovering = false) =>
  Effect.gen(function* () {
    const trace: string[] = [];
    const resumeTiers: Array<string | null | undefined> = [];
    const forwarded: ConversationFollowerRequest[] = [];
    const controls = {
      state: conversationFixture("target", active ? [turnFixture("active", "inProgress")] : []),
      generation: 1,
      role: { role: "follower", ownerClientId: "window" } as ConversationStreamRole,
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
          if (request.method === "thread-follower-steer-turn" && controls.steerFailure)
            return Promise.reject(controls.steerFailure);
          return Promise.resolve({ resultType: "success", result: { turn: { id: "turn" } } });
        },
      },
    };
    const service = yield* make.pipe(
      Effect.provideService(CodexMainConversationResume, {
        resume: (_threadId, options) =>
          Effect.sync(() => {
            trace.push("resume");
            resumeTiers.push(options?.serviceTier);
            return recovering
              ? ({ status: "not-ready", reason: "owner-recovering" } as const)
              : ({ status: "ready", snapshot: null } as const);
          }),
      }),
      Effect.provideService(CodexThreadHostResolver, { resolve: () => Effect.succeed("local") }),
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
        ) =>
          Effect.sync(() => {
            trace.push(`prepare:${mode}:${source}:${prompt}`);
            controls.afterPreparation();
            const steer = {
              conversationId: "target",
              clientUserMessageId: mode,
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
it.effect("resumes an unloaded delegated target before forwarding its admitted native start", () =>
  Effect.gen(function* () {
    const f = yield* fixture(false);
    yield* f.service.send("target", "source", "continue");
    assert.deepEqual(f.trace.slice(0, 2), ["resume", "prepare:start:source:continue"]);
    assert.strictEqual(f.forwarded[0]?.method, "thread-follower-start-turn");
    assert.ok(f.trace.includes("release-start:start"));
  }),
);
it.effect("reprepares a delegated start when the owner's active turn ends during forwarding", () =>
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
