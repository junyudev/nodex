import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { make, CodexNativeThreadLookupError } from "./CodexNativeThreadLookup";

const harness = (readable: readonly string[]) =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const activeSshHosts = yield* SubscriptionRef.make(new Map([["remote", {}]]));
    const lookup = yield* make.pipe(
      Effect.provideService(ExecutionHostRuntime, {
        activeSshHosts,
      } as unknown as ExecutionHostRuntime["Service"]),
      Effect.provideService(CodexMainConversationManagers, {
        get: (hostId: string) => Effect.succeed({ hostId, generation: 1, assertCurrent: () => {} }),
      } as unknown as CodexMainConversationManagers["Service"]),
      Effect.provideService(CodexGateway, {
        localHostId: "local",
        requestOnHost: (hostId: string) =>
          Effect.suspend(() => {
            calls.push(hostId);
            return readable.includes(hostId)
              ? Effect.succeed({ thread: { id: "unloaded-native-task" } })
              : Effect.fail(
                  new CodexNativeThreadLookupError({
                    threadId: "unloaded-native-task",
                    cause: new Error("not found"),
                  }),
                );
          }),
      } as unknown as CodexGateway["Service"]),
    );
    return { lookup, calls };
  });
it.effect("finds an unloaded native task without a durable directory lookup", () =>
  Effect.gen(function* () {
    const h = yield* harness(["remote"]);
    const match = yield* h.lookup.resolve("unloaded-native-task");
    assert.strictEqual(match.hostId, "remote");
    assert.deepEqual(h.calls, ["local", "remote"]);
  }),
);
it.effect("a readable preferred host wins without probing other hosts", () =>
  Effect.gen(function* () {
    const h = yield* harness(["local", "remote"]);
    assert.strictEqual(
      (yield* h.lookup.resolve("unloaded-native-task", "remote")).hostId,
      "remote",
    );
    assert.deepEqual(h.calls, ["remote"]);
  }),
);
it.effect("failed preferred hosts are not retried and ambiguous matches are rejected", () =>
  Effect.gen(function* () {
    const h = yield* harness(["remote"]);
    assert.strictEqual((yield* h.lookup.resolve("unloaded-native-task", "local")).hostId, "remote");
    assert.deepEqual(h.calls, ["local", "remote"]);
    const ambiguous = yield* harness(["local", "remote"]);
    const error = yield* ambiguous.lookup.resolve("unloaded-native-task").pipe(Effect.flip);
    assert.include(
      String(error.cause),
      "Ambiguous Codex thread id unloaded-native-task; matching hosts: local, remote",
    );
  }),
);
