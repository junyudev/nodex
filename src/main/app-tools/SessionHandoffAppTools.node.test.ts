import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import {
  CodexThreadHandoffRuntime,
  type CodexLaunchThreadHandoffInput,
} from "../codex-application/CodexThreadHandoffRuntime";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { createHostedAppToolCaller, captureHostedAppToolAuthority } from "./AppToolCaller";
import { make, makeWithCapture } from "./SessionHandoffAppTools";

const authority: NodexAgentTurnContext = {
  threadId: "caller",
  turnId: "turn",
  rootThreadId: "caller",
  actorProjectId: "project",
  libraryId: "library",
  storeEpoch: "epoch",
  admittedAtMs: Date.now(),
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
        capture: () => Effect.succeed({ ...authority }),
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

const runtimeFixture = (
  options: { withdrawOnInspect?: boolean; wrongOperation?: boolean } = {},
) => {
  let active = true;
  const starts: CodexLaunchThreadHandoffInput[] = [];
  const inspections: unknown[] = [];
  const operations = new Map<string, { sourceThreadId: string; status: string }>();
  const caller = createHostedAppToolCaller({
    backend: "claude",
    authority,
    callId: "host-call",
    generation: 3,
    isActive: () => active,
    capture: Effect.succeed(authority),
    sessionContext: {
      sessionId: "source-session",
      projectId: "source-project",
      runtimeId: "runtime",
      rootThreadId: "source-root",
      threadId: "source-child",
      runId: null,
      cwd: "/source",
    },
  });
  const execute = makeWithCapture(captureHostedAppToolAuthority).pipe(
    Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
    Effect.provideService(CoreModules, {
      workspace: {
        read: () =>
          Effect.succeed({
            value: {
              kind: "agent_session",
              session: {
                archived: false,
                execution_ref: { runtime_id: "runtime", thread_id: "target-root" },
              },
              thread: null,
            },
          }),
        apply: () => Effect.die("Runtime handoffs are admitted by the handoff journal"),
      },
    } as never),
    Effect.provideService(AgentRuntimeApplication, {
      inspect: (target: unknown) =>
        Effect.gen(function* () {
          inspections.push({ target, agent: yield* CoreApplicationAgent });
          if (options.withdrawOnInspect) active = false;
          return {
            sessionId: "target",
            threadId: "target-root",
            thread: { title: "Runtime target" },
          };
        }),
    } as never),
    Effect.provideService(CodexThreadHandoffRuntime, {
      get: (operationId: string) => Effect.succeed(operations.get(operationId) ?? null),
      launch: (request: CodexLaunchThreadHandoffInput) =>
        Effect.sync(() => {
          const previous = operations.get(request.operationId);
          if (previous) return previous;
          starts.push(request);
          const operation = {
            sourceThreadId: options.wrongOperation ? "other" : request.threadId,
            status: "running",
          };
          operations.set(request.operationId, operation);
          return operation;
        }),
    } as never),
  );
  return { caller, execute, starts, inspections };
};

it.effect("routes hosted handoffs through the bound Runtime root and journal replay", () =>
  Effect.gen(function* () {
    const f = runtimeFixture();
    const execute = yield* f.execute;
    const first = yield* execute({ ...input, caller: f.caller });
    assert.isFalse(first.isError ?? false);
    assert.include(f.starts[0], {
      threadId: "target-root",
      requestThreadId: "source-child",
      threadTitle: "Runtime target",
    });
    assert.deepNestedInclude(f.inspections[0], {
      "target.sessionId": "target",
      "agent.authority.thread_id": authority.threadId,
    });
    const replay = yield* execute({
      ...input,
      caller: f.caller,
      arguments: {
        ...input.arguments,
        operationId: first.structuredContent?.operationId,
      },
    });
    assert.deepInclude(replay.structuredContent, { replay: true, deliveryState: "started" });
    assert.lengthOf(f.starts, 1);
  }),
);

it.effect("rejects a hosted child's own Session, withdrawn sources and unrelated outcomes", () =>
  Effect.gen(function* () {
    const self = runtimeFixture();
    const execute = yield* self.execute;
    const result = yield* execute({
      ...input,
      caller: self.caller,
      arguments: { sessionId: "source-session" },
    });
    assert.deepNestedInclude(result.structuredContent, {
      "error.code": "cannot_handoff_calling_session",
    });
    assert.lengthOf(self.starts, 0);
    for (const options of [{ withdrawOnInspect: true }, { wrongOperation: true }]) {
      const f = runtimeFixture(options);
      const run = yield* f.execute;
      const result = yield* run({ ...input, caller: f.caller });
      assert.isTrue(result.isError);
      assert.lengthOf(f.starts, options.withdrawOnInspect ? 0 : 1);
    }
  }),
);
