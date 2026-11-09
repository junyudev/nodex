import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { makeWithCapture } from "./MessageHandbackAppTools";
import { createHostedAppToolCaller } from "./AppToolCaller";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";

const fixture = Effect.gen(function* () {
  const authority: NodexAgentTurnContext = {
    threadId: "thread:work",
    rootThreadId: "thread:work",
    turnId: "run",
    actorProjectId: null,
    libraryId: "library",
    storeEpoch: "epoch",
    admittedAtMs: Date.now(),
    runtime: { sessionId: "work", runtimeId: "runtime", turnKind: "run" },
  };
  const caller = createHostedAppToolCaller({
    backend: "codex",
    authority,
    callId: "call",
    generation: 1,
    isActive: () => true,
    capture: Effect.succeed(authority),
    sessionContext: {
      sessionId: "work",
      projectId: null,
      runtimeId: "runtime",
      rootThreadId: "thread:work",
      threadId: "thread:work",
      runId: "run",
      inboundMessageId: "delivered",
      cwd: null,
    },
  });
  const commands: ProjectWorkspaceApplyInput[] = [];
  let answered = false;
  let reads = 0;
  let withdrawn = false;
  let withdrawOnRead = false;
  let receipt: null | { receipt_id: string; page_ids: string[] } = null;
  const execute = yield* makeWithCapture(() => Effect.succeed(withdrawn ? null : authority)).pipe(
    Effect.provideService(CoreModules, {
      workspace: {
        read: () =>
          Effect.succeed({
            value: {
              kind: "chat_message_inbound",
              inbound: {
                delivery_id: "delivered",
                session_id: "work",
                run_id: "run",
                original_page_ids: [],
                attachment_count: 0,
                question_answered: answered,
                receipt,
              },
            },
          }),
        apply: (command: ProjectWorkspaceApplyInput) =>
          Effect.sync(() => {
            commands.push(command);
            receipt = { receipt_id: "one-receipt", page_ids: ["returned"] };
            return {};
          }),
      },
    } as never),
    Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
    Effect.provideService(CoreSessionAccess, {} as never),
    Effect.provideService(AgentRuntimeApplication, {
      readRunMessage: () =>
        Effect.sync(() => {
          reads++;
          if (withdrawOnRead) withdrawn = true;
        }),
    } as never),
    Effect.provide(FileSystem.layerNoop({})),
  );
  return {
    caller,
    commands,
    execute,
    answer: () => {
      answered = true;
    },
    reads: () => reads,
    withdrawDuringRead: () => {
      withdrawOnRead = true;
    },
  };
});
it.effect("uses only the Host's current inbound message and reuses its handback receipt", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const request = {
      caller: f.caller,
      name: "hand_back_message",
      arguments: { reason: "The documentation chat owns this." },
    };
    const first = yield* f.execute(request);
    assert.deepEqual(first.structuredContent, {
      recorded: true,
      receiptId: "one-receipt",
      pageIds: ["returned"],
    });
    const command = f.commands[0]!.intent;
    assert.equal(command.kind, "agent_command");
    if (command.kind !== "agent_command") throw new Error("Missing captured authority");
    assert.equal(command.provenance.authority.runtime?.session_id, "work");
    assert.equal(command.intent.kind, "hand_back_message");
    if (command.intent.kind !== "hand_back_message") throw new Error("Wrong command");
    assert.deepEqual(command.intent.message, { text: "Keep my words unchanged.", files: [] });
    const retry = yield* f.execute(request);
    assert.deepEqual(retry.structuredContent, first.structuredContent);
    assert.equal(f.reads(), 1);
  }),
);
it.effect("rejects a supplied inbound identity and a copied Host caller", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const supplied = yield* f.execute({
      caller: f.caller,
      name: "hand_back_message",
      arguments: { reason: "Wrong destination", inboundMessageId: "another-message" },
    });
    assert.isTrue(supplied.isError);
    const copied = yield* f.execute({
      caller: { ...f.caller },
      name: "hand_back_message",
      arguments: { reason: "Wrong destination" },
    });
    assert.isTrue(copied.isError);
    assert.isEmpty(f.commands);
    assert.equal(f.reads(), 0);
  }),
);
it.effect("does not reopen an already-answered question", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.answer();
    const result = yield* f.execute({
      caller: f.caller,
      name: "hand_back_message",
      arguments: { reason: "Wrong destination" },
    });
    assert.isTrue(result.isError);
    assert.deepEqual(result.structuredContent?.error, { code: "question_answered" });
    assert.isEmpty(f.commands);
    assert.equal(f.reads(), 0);
  }),
);

it.effect("rechecks the Host authority after reading the original message", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.withdrawDuringRead();
    const result = yield* f.execute({
      caller: f.caller,
      name: "hand_back_message",
      arguments: { reason: "Wrong destination" },
    });
    assert.isTrue(result.isError);
    assert.deepEqual(result.structuredContent?.error, {
      code: "authority_unavailable",
    });
    assert.equal(f.reads(), 1);
    assert.isEmpty(f.commands);
  }),
);
