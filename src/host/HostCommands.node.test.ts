import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import type { components } from "@nodex/core-protocol";
import type { HeadlessHost } from "./HeadlessApplicationLive";
import { executeHostCommand } from "./HostCommands";
import { HostInvocation } from "./HostInvocation";
import { createBoundedOperationId } from "../shared/operation-identity";

/** The host's own Runtime owners, recording what each relayed call asks of them and as whom. */
const recordingHost = () => {
  const calls: { method: string; input: unknown; proof: string | null }[] = [];
  const record = (method: string) => (input: unknown) =>
    Effect.flatMap(HostInvocation, (proof) =>
      Effect.sync(() => {
        calls.push({ method, input, proof });
        return method === "setSessionsSettled"
          ? {
              value: { changedSessionIds: ["chat"] },
              apply: { status: "no_op", observed: { store_epoch: "epoch", commit_seq: 1 } },
            }
          : { sessionId: "created", threadId: "thread", projectId: null };
      }),
    );
  const sessions = new Proxy({} as HeadlessHost["Service"]["sessions"], {
    get: (_target, method: string) => record(method),
  });
  const host = { sessions } as unknown as HeadlessHost["Service"];
  const relay = (operation: components["schemas"]["HostOperation"], input: unknown) =>
    executeHostCommand(host, { id: "call", credential: "bob-proof", call: { operation, input } });
  return { calls, relay };
};

const source = { sessionId: "chat", threadId: "root" };

it.effect("forks a hosted chat for the Member Core admitted, with the host's own workspace", () =>
  Effect.gen(function* () {
    const { calls, relay } = recordingHost();
    const fork = {
      source,
      sessionId: "fork",
      requestId: "fork-request",
      acceptedAt: 1,
      environment: "same-directory",
      sourceRunId: "run",
    };
    yield* relay("session_fork", fork);
    expect(calls).toEqual([{ method: "fork", input: fork, proof: "bob-proof" }]);
    // A desktop's environment path names nothing on the host and is never taken.
    const local = yield* relay("session_fork", {
      ...fork,
      runInEnvironmentPath: "/Users/bob/.codex/environment.toml",
    }).pipe(Effect.exit);
    expect(local._tag).toBe("Failure");
    expect(calls).toHaveLength(1);
  }),
);

it.effect("opens, merges back and deletes a Member's side chat on the host", () =>
  Effect.gen(function* () {
    const { calls, relay } = recordingHost();
    const side = { source, sessionId: "side", requestId: "side-request", acceptedAt: 1 };
    yield* relay("session_side_chat_create", side);
    yield* relay("session_merge_back", { sessionId: "side", requestId: "merge" });
    yield* relay("session_side_chat_delete", { sessionId: "side", requestId: "delete" });
    expect(calls).toEqual([
      { method: "createSideChat", input: side, proof: "bob-proof" },
      {
        method: "mergeBack",
        input: { sessionId: "side", requestId: "merge" },
        proof: "bob-proof",
      },
      {
        method: "deleteSideChat",
        input: { sessionId: "side", requestId: "delete" },
        proof: "bob-proof",
      },
    ]);
  }),
);

it.effect("compacts, retries and clears a hosted chat's context for whoever may manage it", () =>
  Effect.gen(function* () {
    const { calls, relay } = recordingHost();
    const retry = { ...source, requestId: "retry", failedRunId: "failed" };
    yield* relay("session_compact", retry);
    yield* relay("session_clear_context", { ...source, requestId: "clear" });
    expect(calls).toEqual([
      { method: "compact", input: retry, proof: "bob-proof" },
      { method: "clearContext", input: { ...source, requestId: "clear" }, proof: "bob-proof" },
    ]);
  }),
);

it.effect("answers with the host's own Inbox settings, never a request's", () =>
  Effect.gen(function* () {
    const inbox = { chatAgent: { instanceId: "codex", model: "gpt-6-luna", effort: "low" } };
    const host = {
      settings: { snapshot: () => Effect.succeed({ inbox }) },
    } as unknown as HeadlessHost["Service"];
    const read = (input: unknown) =>
      executeHostCommand(host, {
        id: "call",
        credential: "bob-proof",
        call: { operation: "inbox_settings", input },
      });
    expect(yield* read({})).toBe(inbox);
    expect((yield* read({ chatAgent: null }).pipe(Effect.exit))._tag).toBe("Failure");
  }),
);

it.effect("relays a settlement batch under the requesting Member's proof", () =>
  Effect.gen(function* () {
    const { relay, calls } = recordingHost();
    const input = {
      operationId: createBoundedOperationId("test.settlement"),
      payload: { sessionIds: ["chat", "quiet"], settled: true },
    };
    expect(yield* relay("sessions_set_settled", input)).toMatchObject({
      ok: true,
      value: { changedSessionIds: ["chat"] },
    });
    expect(calls).toEqual([{ method: "setSessionsSettled", input, proof: "bob-proof" }]);
  }),
);
