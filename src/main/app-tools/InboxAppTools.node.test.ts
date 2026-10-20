import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make, makeWithCapture } from "./InboxAppTools";

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
  name: "send_to_inbox",
  arguments: { body: "Settings buttons need accessible labels" },
  caller: {
    threadId: "caller",
    turnId: "turn",
    callId: "call",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
};

const setup = (options: { rejectWith?: string } = {}) => {
  const applied: ProjectWorkspaceApplyInput[] = [];
  const seen = new Set<string>();
  return {
    applied,
    execute: make.pipe(
      Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
      Effect.provideService(CodexTurnAuthority, {
        capture: () => Effect.succeed(authority),
      } as never),
      Effect.provideService(CoreModules, {
        workspace: {
          apply: (command: ProjectWorkspaceApplyInput) =>
            Effect.gen(function* () {
              applied.push(command);
              if (options.rejectWith)
                return yield* coreRuntimeError({
                  operation: "workspace.apply",
                  reason: "operation",
                  retryable: false,
                  cause: new CoreModuleResponseError({
                    code: options.rejectWith,
                    message: options.rejectWith,
                    retryable: false,
                  } as never),
                });
              const duplicate = seen.has(command.operationId);
              seen.add(command.operationId);
              return { status: "committed", receipt: { duplicate } };
            }),
        },
      } as never),
    ),
  };
};

it.effect("drops one message under the calling Turn and replays it without a second entry", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const execute = yield* fixture.execute;
    const first = yield* execute(input);
    const replay = yield* execute(input);
    assert.isUndefined(first.isError);
    assert.strictEqual(fixture.applied.length, 2);
    const [sent, again] = fixture.applied;
    assert.deepInclude(sent!.intent, { kind: "agent_command" });
    const intent = sent!.intent.kind === "agent_command" ? sent!.intent : null;
    assert.strictEqual(intent?.provenance.authority.turn_id, "turn");
    assert.deepInclude(intent?.intent, {
      kind: "send_inbox_message",
      body: "Settings buttons need accessible labels",
    });
    // The same call derives the same operation and Page, so Core sees an idempotent replay.
    assert.deepEqual(again, sent);
    assert.include(replay.structuredContent, { replay: true });
  }),
);

it.effect("withdraws a call cancelled while its source is captured", () =>
  Effect.gen(function* () {
    let active = true;
    let writes = 0;
    const execute = yield* makeWithCapture(() =>
      Effect.sync(() => {
        active = false;
        return authority;
      }),
    ).pipe(
      Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
      Effect.provideService(CoreModules, {
        workspace: {
          apply: () =>
            Effect.sync(() => {
              writes++;
              return {};
            }),
        },
      } as never),
    );
    const result = yield* execute({
      ...input,
      caller: { ...input.caller, isActive: () => active },
    });
    assert.deepEqual(result.structuredContent, { error: { code: "call_withdrawn" } });
    assert.strictEqual(writes, 0);
  }),
);

it.effect("reports the captured source's message cap as its own failure", () =>
  Effect.gen(function* () {
    const fixture = setup({ rejectWith: "resource_exhausted" });
    const result = yield* (yield* fixture.execute)(input);
    assert.isTrue(result.isError);
    assert.strictEqual(
      (result.structuredContent as { error: { code: string } }).error.code,
      "inbox_message_limit",
    );
  }),
);
