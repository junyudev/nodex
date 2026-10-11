import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./InboxAppTools";

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
  name: "send_to_inbox",
  arguments: { text: "Settings buttons need accessible labels" },
  caller: {
    threadId: "caller",
    turnId: "turn",
    callId: "call",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
};

const setup = (options: { readOnly?: boolean; rejectWith?: string } = {}) => {
  const applied: ProjectWorkspaceApplyInput[] = [];
  const seen = new Set<string>();
  return {
    applied,
    execute: make.pipe(
      Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
      Effect.provideService(CodexTurnAuthority, {
        capture: () => Effect.succeed({ ...authority, readOnly: options.readOnly ?? false }),
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
      text: "Settings buttons need accessible labels",
    });
    // The same call derives the same operation and Page, so Core sees an idempotent replay.
    assert.deepEqual(again, sent);
    assert.include(replay.structuredContent, { replay: true });
  }),
);

it.effect("refuses read-only Turns before touching Core", () =>
  Effect.gen(function* () {
    const fixture = setup({ readOnly: true });
    const result = yield* (yield* fixture.execute)(input);
    assert.deepEqual(result.structuredContent, { error: { code: "read_only_turn" } });
    assert.strictEqual(fixture.applied.length, 0);
  }),
);

it.effect("reports the per-Turn message cap as its own failure", () =>
  Effect.gen(function* () {
    const fixture = setup({ rejectWith: "resource_exhausted" });
    const result = yield* (yield* fixture.execute)(input);
    assert.isTrue(result.isError);
    assert.strictEqual(
      (result.structuredContent as { error: { code: string } }).error.code,
      "inbox_turn_limit",
    );
  }),
);
