import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexMainConversationResume } from "./CodexMainConversationResume";
import { CodexMainConversationInterrupt } from "./CodexMainConversationInterrupt";
import { CodexQueuedFollowUps } from "./CodexQueuedFollowUps";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { make } from "./CodexSessionControls";

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
          request.request.method === "thread-follower-session-queue" && request.hostId === "remote",
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
