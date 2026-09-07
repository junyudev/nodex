import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import {
  CodexTurnCommands,
  type CodexTurnStartOverrides,
} from "../codex-application/CodexTurnCommands";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./SessionMessageAppTools";

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
  name: "send_message_to_session",
  arguments: { sessionId: "target", prompt: "Continue the work" },
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
    backend?: string;
    threadId?: string | null;
    archived?: boolean;
    afterAdmission?: () => void;
  } = {},
) => {
  const admitted: ProjectWorkspaceApplyInput[] = [];
  const starts: { threadId: string; prompt: string; overrides?: CodexTurnStartOverrides }[] = [];
  const seen = new Set<string>();
  return {
    admitted,
    starts,
    execute: make.pipe(
      Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
      Effect.provideService(CodexTurnAuthority, {
        capture: () => Effect.succeed({ ...authority, readOnly: options.readOnly ?? false }),
      } as never),
      Effect.provideService(CoreModules, {
        workspace: {
          read: () =>
            Effect.succeed({
              value: {
                kind: "agent_session",
                session: { archived: options.archived ?? false },
                thread:
                  options.threadId === null
                    ? null
                    : {
                        thread_id: options.threadId ?? "target-thread",
                        backend_binding: { kind: options.backend ?? "codex" },
                      },
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
              return { status: "no_op", receipt: { duplicate, affected_session_ids: ["target"] } };
            }),
        },
      } as never),
      Effect.provideService(CodexTurnCommands, {
        start: (threadId: string, prompt: string, overrides?: CodexTurnStartOverrides) =>
          Effect.gen(function* () {
            starts.push({ threadId, prompt, overrides });
            if (options.failure)
              return yield* coreRuntimeError({
                operation: "start",
                reason: "operation",
                retryable: false,
              });
            return { threadId, turnId: "accepted", status: "inProgress", itemIds: [] };
          }),
      } as never),
    ),
  };
};

it.effect("reserves one dispatch and never resends a repeated operation", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const execute = yield* fixture.execute;
    const first = yield* execute(input);
    assert.strictEqual(first.structuredContent?.deliveryState, "started");
    assert.strictEqual(first.structuredContent?.turnId, "accepted");
    const replay = yield* execute({
      ...input,
      arguments: { ...input.arguments, operationId: first.structuredContent?.operationId },
      caller: { ...input.caller, callId: "retry" },
    });
    assert.deepInclude(replay.structuredContent, { replay: true, deliveryState: "unconfirmed" });
    assert.lengthOf(fixture.starts, 1);
    assert.deepStrictEqual(fixture.admitted[0], fixture.admitted[1]);
    assert.deepNestedInclude(fixture.admitted[0], {
      "intent.kind": "agent_command",
      "intent.provenance.authority.turn_id": "turn",
      "intent.intent.kind": "admit_session_message",
      "intent.intent.session_id": "target",
      "intent.intent.thread_id": "target-thread",
    });
    assert.strictEqual(fixture.starts[0]?.threadId, "target-thread");
    assert.isUndefined(fixture.starts[0]?.overrides?.model);
  }),
);

it.effect("does not dispatch denied, inactive, unsupported or self-targeted messages", () =>
  Effect.gen(function* () {
    for (const options of [
      { denied: true },
      { readOnly: true },
      { archived: true },
      { backend: "acp" },
      { threadId: null },
      { threadId: "caller" },
    ]) {
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
      (yield* execute({ ...input, arguments: { ...input.arguments, threadId: "forged" } })).isError,
    );
    assert.lengthOf(fixture.admitted, 0);
    assert.isTrue(
      (yield* execute({ ...input, caller: { ...input.caller, isActive: () => active } })).isError,
    );
    assert.lengthOf(fixture.starts, 0);
  }),
);

it.effect(
  "retains the operation identity after an uncertain send and preserves requested model",
  () =>
    Effect.gen(function* () {
      const fixture = setup({ failure: true });
      const execute = yield* fixture.execute;
      const call = { ...input, arguments: { ...input.arguments, model: "chosen-model" } };
      const first = yield* execute(call);
      assert.isTrue(first.isError);
      assert.deepNestedInclude(first.structuredContent, {
        "error.code": "session_message_unconfirmed",
        "error.details.committed": true,
      });
      const replay = yield* execute(call);
      assert.strictEqual(replay.structuredContent?.deliveryState, "unconfirmed");
      assert.lengthOf(fixture.starts, 1);
      assert.strictEqual(fixture.starts[0]?.overrides?.model, "chosen-model");
    }),
);
