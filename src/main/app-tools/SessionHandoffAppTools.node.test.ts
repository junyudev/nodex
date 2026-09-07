import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import {
  CodexThreadHandoffRuntime,
  type CodexLaunchThreadHandoffInput,
} from "../codex-application/CodexThreadHandoffRuntime";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./SessionHandoffAppTools";

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
  name: "handoff_session",
  arguments: { sessionId: "target", followUpPrompt: "Continue the work" },
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
    wrongOperation?: boolean;
    backend?: string;
    threadId?: string | null;
    archived?: boolean;
    afterAdmission?: () => void;
  } = {},
) => {
  const admitted: ProjectWorkspaceApplyInput[] = [];
  const starts: CodexLaunchThreadHandoffInput[] = [];
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
                session: { archived: options.archived ?? false, display_title: "Target session" },
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
      Effect.provideService(CodexThreadHandoffRuntime, {
        get: () =>
          Effect.succeed(
            options.failure ? null : { sourceThreadId: "target-thread", status: "success" },
          ),
        launch: (request: CodexLaunchThreadHandoffInput) =>
          Effect.sync(() => {
            starts.push(request);
            return {
              sourceThreadId: options.wrongOperation ? "unrelated" : request.threadId,
              status: "running",
            };
          }),
      } as never),
    ),
  };
};

it.effect("reserves one dispatch and never repeats a repeated operation", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const execute = yield* fixture.execute;
    const first = yield* execute(input);
    assert.strictEqual(first.structuredContent?.deliveryState, "started");
    assert.include(fixture.starts[0], {
      requestThreadId: input.caller.threadId,
      threadTitle: "Target session",
    });
    assert.deepNestedInclude(first.structuredContent, { "operation.status": "running" });
    const replay = yield* execute({
      ...input,
      arguments: { ...input.arguments, operationId: first.structuredContent?.operationId },
      caller: { ...input.caller, callId: "retry" },
    });
    assert.deepInclude(replay.structuredContent, { replay: true, deliveryState: "started" });
    assert.lengthOf(fixture.starts, 1);
    assert.deepStrictEqual(fixture.admitted[0], fixture.admitted[1]);
    assert.deepNestedInclude(fixture.admitted[0], {
      "intent.kind": "agent_command",
      "intent.provenance.authority.turn_id": "turn",
      "intent.intent.kind": "admit_session_handoff",
      "intent.intent.session_id": "target",
      "intent.intent.thread_id": "target-thread",
    });
    assert.strictEqual(fixture.starts[0]?.threadId, "target-thread");
    assert.isNull(fixture.starts[0]?.destinationHostId);
    assert.strictEqual(fixture.starts[0]?.followUpPrompt, "Continue the work");
  }),
);

it.effect("does not dispatch denied, inactive, unsupported or self-targeted handoffs", () =>
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

it.effect("does not launch again when a reserved handoff has no retained outcome", () =>
  Effect.gen(function* () {
    const fixture = setup({ failure: true });
    const execute = yield* fixture.execute;
    const call = { ...input, arguments: { ...input.arguments, destinationHostId: "remote" } };
    yield* execute(call);
    const replay = yield* execute(call);
    assert.deepInclude(replay.structuredContent, {
      replay: true,
      deliveryState: "unconfirmed",
      operation: null,
    });
    assert.lengthOf(fixture.starts, 1);
    assert.strictEqual(fixture.starts[0]?.destinationHostId, "remote");
  }),
);

it.effect("does not expose another Thread's operation when an identity is already occupied", () =>
  Effect.gen(function* () {
    const fixture = setup({ wrongOperation: true });
    const execute = yield* fixture.execute;
    const result = yield* execute(input);
    assert.isTrue(result.isError);
    assert.deepNestedInclude(result.structuredContent, { "error.code": "handoff_binding_changed" });
    assert.isUndefined(result.structuredContent?.operation);
  }),
);
