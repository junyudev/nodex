import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodexThreadTargets } from "./CodexThreadTargets";
import { CodexClientThreadIdentity } from "./CodexClientThreadIdentity";
import { CodexPendingWorktreeRuntime } from "./CodexPendingWorktreeRuntime";
import { make } from "./CodexCreatedThreadResolution";
import type { CodexCreatedThreadResolution } from "../../shared/codex-child-thread-summary";

const clientThreadId = "client-new-thread:created";
const fixture = (
  input: {
    pending?: boolean;
    fork?: boolean;
    duplicatePending?: boolean;
    state?: boolean;
    ambiguous?: boolean;
    foreign?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    let commands = 0;
    const targets = CodexThreadTargets.of({
      readSummary: () => Effect.die("Resolution must not read native metadata"),
      ensureOpen: () =>
        Effect.sync(() => {
          commands++;
          return null;
        }),
      resolveKnown: (threadId, hostId) =>
        Effect.succeed(
          input.foreign || hostId === "foreign"
            ? null
            : {
                hostId: hostId ?? "ssh:owner",
                threadId,
                ready: true,
                parentThreadId: threadId === "child" ? "root" : null,
              },
        ),
    });
    const pending = {
      list: () =>
        input.duplicatePending
          ? ["one", "two"].map((id) => ({
              id,
              launchMode: "start-conversation",
              clientThreadId,
              hostId: "ssh:owner",
            }))
          : input.fork
            ? [
                {
                  id: "fork-pending",
                  launchMode: "fork-conversation",
                  clientThreadId,
                  hostId: "worktree-host",
                  sourceConversationId: "source",
                },
              ]
            : input.pending
              ? [
                  {
                    launchMode: "start-conversation",
                    id: "actual-pending",
                    clientThreadId,
                    hostId: "local",
                    threadStartHostId: "ssh:owner",
                  },
                ]
              : [],
      resolveThread: () =>
        input.pending || input.fork || input.state ? { state: "starting" } : null,
    } as unknown as CodexPendingWorktreeRuntime["Service"];
    const identities = {
      candidates: (_id: string, host?: string) =>
        Effect.succeed(
          input.ambiguous
            ? [
                { hostId: "ssh:owner", threadId: "one", clientThreadId },
                { hostId: "ssh:owner", threadId: "two", clientThreadId },
              ]
            : [{ hostId: host ?? "ssh:owner", threadId: "child", clientThreadId }],
        ),
    } as unknown as CodexClientThreadIdentity["Service"];
    const service = yield* make.pipe(
      Effect.provideService(CodexThreadTargets, targets),
      Effect.provideService(CodexPendingWorktreeRuntime, pending),
      Effect.provideService(CodexClientThreadIdentity, identities),
    );
    return { service, commands: () => commands };
  });

it.effect(
  "keeps pending launch unready even after its actual host/native identity is persisted",
  () =>
    Effect.gen(function* () {
      const { service, commands } = yield* fixture({ pending: true });
      assert.deepStrictEqual(yield* service.read({ clientThreadId }), {
        hostId: "ssh:owner",
        threadId: "child",
        clientThreadId,
        pendingWorktreeId: "actual-pending",
        ready: false,
        parentThreadId: "root",
      } satisfies CodexCreatedThreadResolution);
      assert.isNull(yield* service.read({ clientThreadId, expectedHostId: "foreign" }));
      assert.strictEqual(commands(), 0);
    }),
);
it.effect("preserves retained launch ownership after the visible pending row was removed", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture({ state: true });
    assert.strictEqual((yield* service.read({ clientThreadId }))?.ready, false);
  }),
);
it.effect(
  "resolves a pending fork from its native source binding instead of the worktree filesystem host",
  () =>
    Effect.gen(function* () {
      const { service } = yield* fixture({ fork: true });
      assert.strictEqual((yield* service.read({ clientThreadId }))?.hostId, "ssh:owner");
      assert.isNull(yield* service.read({ clientThreadId, expectedHostId: "worktree-host" }));
    }),
);
it.effect("rejects two active launch owners for one client identity", () =>
  Effect.gen(function* () {
    const { service, commands } = yield* fixture({ duplicatePending: true });
    assert.isNull(yield* service.read({ clientThreadId }));
    assert.strictEqual(commands(), 0);
  }),
);
it.effect(
  "admits one completed Core-confirmed coordinate and rejects ambiguity or foreign binding",
  () =>
    Effect.gen(function* () {
      const complete = yield* fixture();
      assert.strictEqual((yield* complete.service.read({ clientThreadId }))?.ready, true);
      const ambiguous = yield* fixture({ ambiguous: true });
      assert.isNull(yield* ambiguous.service.read({ clientThreadId }));
      const foreign = yield* fixture({ foreign: true });
      assert.isNull(yield* foreign.service.read({ clientThreadId }));
      assert.isNull(yield* foreign.service.read({ threadId: "child", expectedHostId: "foreign" }));
    }),
);
