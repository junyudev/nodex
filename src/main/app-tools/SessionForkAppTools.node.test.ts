import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { isUuidV7 } from "../../shared/uuid-v7";
import {
  CodexProjectSessionFork,
  type CodexProjectSessionForkCommand,
} from "../codex-application/CodexProjectSessionFork";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./SessionForkAppTools";

const authority: FrozenNodexAgentTurnAuthority = {
  threadId: "caller",
  turnId: "turn",
  rootThreadId: "caller",
  actorProjectId: "project",
  libraryId: "library",
  storeEpoch: "epoch",
  frozenAtMs: Date.now(),
  readOnly: false,
  scope: "project",
  source: "project_turn",
};
const input: AppToolInvocation = {
  name: "fork_session",
  arguments: {},
  caller: {
    threadId: "caller",
    turnId: "turn",
    callId: "call",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
};
const setup = (
  options: {
    denied?: boolean;
    readOnly?: boolean;
    failure?: boolean;
    pending?: boolean;
    afterAdmission?: () => void;
  } = {},
) => {
  const admitted: ProjectWorkspaceApplyInput[] = [];
  const forks: CodexProjectSessionForkCommand[] = [];
  const seen = new Set<string>();
  return {
    admitted,
    forks,
    execute: make.pipe(
      Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
      Effect.provideService(ProjectWorkspace, {
        getThread: () => Effect.succeed({ sessionId: "source" }),
      } as never),
      Effect.provideService(CodexTurnAuthority, {
        capture: () => Effect.succeed({ ...authority, readOnly: options.readOnly ?? false }),
      } as never),
      Effect.provideService(CoreModules, {
        workspace: {
          read: ({ session_id }: { session_id: string }) =>
            Effect.succeed({
              value: {
                kind: "agent_session",
                session: { archived: false },
                thread:
                  session_id === "source"
                    ? { thread_id: "caller", backend_binding: { kind: "codex" } }
                    : forks.length && !options.failure && !options.pending
                      ? { thread_id: "child" }
                      : null,
              },
            }),
          apply: (command: ProjectWorkspaceApplyInput) =>
            Effect.gen(function* () {
              admitted.push(command);
              if (options.denied)
                return yield* coreRuntimeError({
                  operation: "apply",
                  reason: "operation",
                  retryable: false,
                });
              const duplicate = seen.has(command.operationId);
              seen.add(command.operationId);
              options.afterAdmission?.();
              if (
                command.intent.kind !== "agent_command" ||
                command.intent.intent.kind !== "admit_session_fork"
              )
                throw new Error("Unexpected fork admission");
              return {
                status: "committed",
                receipt: { duplicate, affected_session_ids: [command.intent.intent.session_id] },
              };
            }),
        },
      } as never),
      Effect.provideService(CodexProjectSessionFork, {
        fork: (command: CodexProjectSessionForkCommand) =>
          Effect.gen(function* () {
            forks.push(command);
            if (options.failure)
              return yield* coreRuntimeError({
                operation: "fork",
                reason: "operation",
                retryable: false,
              });
            return options.pending
              ? { pendingWorktreeId: "pending", clientThreadId: "client" }
              : { threadId: "child", session: { id: command.destinationSessionId } };
          }),
      } as never),
    ),
  };
};

it.effect("forks the calling Session into a reserved visible child and replays its binding", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const execute = yield* fixture.execute;
    const first = yield* execute(input);
    assert.deepInclude(first.structuredContent, {
      forkState: "attached",
      sourceSessionId: "source",
      threadId: "child",
    });
    const replay = yield* execute({
      ...input,
      arguments: { operationId: first.structuredContent?.operationId },
      caller: { ...input.caller, callId: "retry" },
    });
    assert.deepInclude(replay.structuredContent, {
      replay: true,
      forkState: "attached",
      sessionId: first.structuredContent?.sessionId,
    });
    assert.lengthOf(fixture.forks, 1);
    assert.deepStrictEqual(fixture.admitted[0], fixture.admitted[1]);
    assert.isTrue(isUuidV7(fixture.forks[0]!.destinationSessionId!));
    assert.deepInclude(fixture.forks[0], {
      sessionId: "source",
      threadSource: "user",
    });
    assert.strictEqual(fixture.forks[0]?.destinationSessionId, first.structuredContent?.sessionId);
    assert.deepStrictEqual(fixture.forks[0]?.input, { target: "local" });
  }),
);

it.effect("does not fork rejected, read-only or withdrawn requests", () =>
  Effect.gen(function* () {
    for (const options of [{ denied: true }, { readOnly: true }]) {
      const fixture = setup(options);
      const execute = yield* fixture.execute;
      assert.isTrue((yield* execute(input)).isError);
      assert.lengthOf(fixture.forks, 0);
    }
    let active = true;
    const fixture = setup({
      afterAdmission: () => {
        active = false;
      },
    });
    const execute = yield* fixture.execute;
    assert.isTrue((yield* execute({ ...input, arguments: { threadId: "forged" } })).isError);
    assert.lengthOf(fixture.admitted, 0);
    assert.isTrue(
      (yield* execute({ ...input, caller: { ...input.caller, isActive: () => active } })).isError,
    );
    assert.lengthOf(fixture.forks, 0);
  }),
);

it.effect("keeps failed and pending worktree forks reserved without a second fork", () =>
  Effect.gen(function* () {
    for (const options of [{ failure: true }, { pending: true }]) {
      const fixture = setup(options);
      const execute = yield* fixture.execute;
      const call = {
        ...input,
        arguments: { sessionId: "source", environment: { type: "worktree" } },
      };
      const first = yield* execute(call);
      assert.strictEqual(first.isError === true, !!options.failure);
      if (options.pending)
        assert.deepInclude(first.structuredContent, {
          forkState: "pending",
          pendingWorktreeId: "pending",
          clientThreadId: "client",
        });
      assert.deepInclude((yield* execute(call)).structuredContent, {
        replay: true,
        forkState: "unconfirmed",
      });
      assert.lengthOf(fixture.forks, 1);
      assert.deepStrictEqual(fixture.forks[0]?.input, { target: "newWorktree" });
    }
  }),
);
