import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { CodexThreadStartForSessionInput } from "../../shared/types";
import { isUuidV7 } from "../../shared/uuid-v7";
import { CodexSessionThreadLaunch } from "../codex-application/CodexSessionThreadLaunch";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./SessionLaunchAppTools";

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
  name: "create_session",
  arguments: {
    prompt: "Do the work",
    target: { type: "project", projectId: "project", environment: { type: "local" } },
  },
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
  const commands: ProjectWorkspaceApplyInput[] = [];
  const starts: CodexThreadStartForSessionInput[] = [];
  const seen = new Set<string>();
  const execute = make.pipe(
    Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
    Effect.provideService(CodexTurnAuthority, {
      capture: () => Effect.succeed({ ...authority, readOnly: options.readOnly ?? false }),
    } as never),
    Effect.provideService(CoreModules, {
      workspace: {
        apply: (command: ProjectWorkspaceApplyInput, _options: unknown, projectId: string) =>
          Effect.gen(function* () {
            commands.push(command);
            assert.strictEqual(projectId, "project");
            assert.deepNestedInclude(command, {
              "intent.kind": "agent_command",
              "intent.provenance.authority.turn_id": "turn",
            });
            if (options.denied)
              return yield* coreRuntimeError({
                operation: "apply",
                reason: "operation",
                retryable: false,
              });
            const duplicate = seen.has(command.operationId);
            seen.add(command.operationId);
            options.afterAdmission?.();
            assert.strictEqual(command.intent.kind, "agent_command");
            if (
              command.intent.kind !== "agent_command" ||
              command.intent.intent.kind !== "admit_session_launch"
            )
              throw new Error("Unexpected launch command");
            return {
              status: "committed",
              receipt: { duplicate, affected_session_ids: [command.intent.intent.session_id] },
            };
          }),
        read: () =>
          Effect.succeed({
            value: {
              kind: "agent_session",
              thread:
                starts.length && !options.failure && !options.pending
                  ? { thread_id: "child" }
                  : null,
            },
          }),
      },
    } as never),
    Effect.provideService(CodexSessionThreadLaunch, {
      start: (launch: CodexThreadStartForSessionInput) =>
        Effect.gen(function* () {
          starts.push(launch);
          if (options.failure)
            return yield* coreRuntimeError({
              operation: "launch",
              reason: "operation",
              retryable: false,
            });
          return options.pending
            ? { kind: "pending", pendingWorktreeId: "pending", clientThreadId: "client" }
            : { kind: "started", detail: { threadId: "child" } };
        }),
    } as never),
  );
  return { execute, commands, starts };
};

it.effect("admits once and replays a stable Session binding without another backend launch", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const execute = yield* fixture.execute;
    const first = yield* execute(input);
    assert.strictEqual(first.structuredContent?.launchState, "started");
    const operationId = first.structuredContent?.operationId;
    const second = yield* execute({
      ...input,
      arguments: { ...input.arguments, operationId },
      caller: { ...input.caller, callId: "retry" },
    });
    assert.strictEqual(second.structuredContent?.launchState, "attached");
    assert.strictEqual(second.structuredContent?.sessionId, first.structuredContent?.sessionId);
    assert.deepStrictEqual(fixture.commands[0], fixture.commands[1]);
    assert.lengthOf(fixture.starts, 1);
    const launch = fixture.starts[0]!;
    assert.isTrue(isUuidV7(launch.sessionId));
    assert.isTrue(isUuidV7(launch.firstSubmission.launchId));
    assert.isTrue(isUuidV7(launch.firstSubmission.clientUserMessageId));
    assert.notStrictEqual(
      launch.firstSubmission.launchId,
      launch.firstSubmission.clientUserMessageId,
    );
    assert.isUndefined(launch.model);
    assert.isUndefined(launch.executionProfile);
    assert.strictEqual(launch.threadSource, "user");
  }),
);

it.effect("does not launch denied, read-only, malformed or withdrawn requests", () =>
  Effect.gen(function* () {
    for (const options of [{ denied: true }, { readOnly: true }]) {
      const fixture = setup(options);
      const execute = yield* fixture.execute;
      assert.isTrue((yield* execute(input)).isError);
      assert.lengthOf(fixture.starts, 0);
    }
    let active = true;
    const fixture = setup({
      afterAdmission: () => {
        active = false;
      },
    });
    const execute = yield* fixture.execute;
    assert.isTrue(
      (yield* execute({ ...input, arguments: { ...input.arguments, callerId: "forged" } })).isError,
    );
    assert.lengthOf(fixture.commands, 0);
    assert.isTrue(
      (yield* execute({ ...input, caller: { ...input.caller, isActive: () => active } })).isError,
    );
    assert.lengthOf(fixture.starts, 0);
  }),
);

it.effect(
  "preserves worktree settings and reports failed or pending launches without retrying them",
  () =>
    Effect.gen(function* () {
      for (const options of [{ failure: true }, { pending: true }]) {
        const fixture = setup(options);
        const execute = yield* fixture.execute;
        const call = {
          ...input,
          arguments: {
            ...input.arguments,
            model: "chosen-model",
            target: {
              type: "project",
              projectId: "project",
              environment: {
                type: "worktree",
                startingState: {
                  type: "branch",
                  branchName: "feature",
                  onMissing: "create-branch",
                },
              },
            },
          },
        };
        const first = yield* execute(call);
        assert.strictEqual(first.isError === true, !!options.failure);
        const second = yield* execute(call);
        assert.strictEqual(second.structuredContent?.launchState, "unconfirmed");
        assert.lengthOf(fixture.starts, 1);
        assert.deepInclude(fixture.starts[0], {
          model: "chosen-model",
          runInTarget: "newWorktree",
        });
        assert.deepStrictEqual(fixture.starts[0]?.worktreeStartingState, {
          type: "branch",
          branchName: "feature",
          onMissing: "create-branch",
        });
      }
    }),
);
