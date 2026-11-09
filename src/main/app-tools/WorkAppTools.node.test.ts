import { startWorkSchema } from "../../shared/nodex-app-tools/work-schema";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { reportWorkSchema } from "../../shared/nodex-app-tools/work-schema";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { createAppToolAdmissionFixture } from "./app-tool-operation.test-fixtures";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { makeWithCapture } from "./WorkAppTools";
const authority: NodexAgentTurnContext = {
  threadId: "caller",
  turnId: "turn",
  rootThreadId: "caller",
  actorProjectId: null,
  libraryId: "library",
  storeEpoch: "epoch",
  admittedAtMs: 1,
};
const input: AppToolInvocation = {
  name: "report_work",
  arguments: { outcome: "ready", summary: "Fixed and tested.", idempotencyKey: "report:one" },
  caller: {
    threadId: "caller",
    turnId: "turn",
    callId: "call",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
};
it.effect(
  "preserves verified provenance, rejects an unlinked caller, and records the linked report",
  () =>
    Effect.gen(function* () {
      let linked = false;
      const applied: ProjectWorkspaceApplyInput[] = [];
      const execute = yield* makeWithCapture(() => Effect.succeed(authority)).pipe(
        Effect.provideService(WorkApplication, {} as never),
        Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
        Effect.provideService(CoreModules, {
          workspace: {
            admitToolOperation: createAppToolAdmissionFixture().admitToolOperation,
            apply: (command: ProjectWorkspaceApplyInput) =>
              Effect.gen(function* () {
                applied.push(command);
                if (!linked)
                  return yield* coreRuntimeError({
                    operation: "workspace.apply",
                    reason: "operation",
                    retryable: false,
                    cause: new CoreModuleResponseError({
                      code: "unauthorized",
                      message: "Session is not linked to this Page",
                      retryable: false,
                    } as never),
                  });
                return { receipt: { duplicate: false } };
              }),
          },
        } as never),
      );
      assert.isTrue((yield* execute(input)).isError);
      linked = true;
      const recorded = yield* execute(input);
      assert.isUndefined(recorded.isError);
      assert.deepInclude(recorded.structuredContent, { recorded: true });
      assert.deepEqual(applied[0], applied[1]);
      const command = applied[1]!.intent;
      assert.equal(command.kind, "agent_command");
      if (command.kind !== "agent_command") return;
      assert.equal(command.provenance.authority.root_thread_id, "caller");
      assert.deepEqual(command.intent, {
        kind: "report_page_work",
        page_id: null,
        outcome: "ready",
        summary: "Fixed and tested.",
      });
    }),
);
it("uses a strict bounded tool schema without caller-authored identity", () => {
  assert.isTrue(reportWorkSchema.safeParse(input.arguments).success);
  for (const patch of [
    { sessionId: "forged" },
    { outcome: "done" },
    { summary: " " },
    { summary: "a".repeat(4001) },
  ])
    assert.isFalse(reportWorkSchema.safeParse({ ...input.arguments, ...patch }).success);
});

it.effect("start_work admits the caller's stable operation and records a valid Page start", () =>
  Effect.gen(function* () {
    const inputs: unknown[] = [];
    const callers: unknown[] = [];
    let refusal: string | null = null;
    const execute = yield* makeWithCapture(() => Effect.succeed(authority)).pipe(
      Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
      Effect.provideService(CoreModules, {
        workspace: { admitToolOperation: createAppToolAdmissionFixture().admitToolOperation },
      } as never),
      Effect.provideService(WorkApplication, {
        // Core attributes the start, and checks Nodex's consent, from the ambient Turn provenance.
        startWork: (input: unknown) =>
          Effect.flatMap(CoreApplicationAgent, (caller) => {
            callers.push(caller);
            if (refusal)
              return Effect.fail(
                coreRuntimeError({
                  operation: "workspace.apply",
                  reason: "operation",
                  retryable: false,
                  cause: new CoreModuleResponseError({
                    code: "unauthorized",
                    message: refusal,
                    retryable: false,
                  } as never),
                }),
              );
            inputs.push(input);
            return Effect.succeed({
              value: { pageId: "page", sessionId: "session", launchId: "launch" },
            });
          }),
      } as never),
    );
    const invocation = {
      ...input,
      name: "start_work",
      arguments: {
        pageId: "page",
        agent: { instanceId: "codex", model: "model" },
        idempotencyKey: "start:page",
      },
    };
    const result = yield* execute(invocation);
    const replay = yield* execute(invocation);
    assert.isUndefined(result.isError);
    assert.deepInclude(result.structuredContent, {
      recorded: true,
      pageId: "page",
      sessionId: "session",
      launchId: "launch",
    });
    assert.deepEqual(inputs[0], inputs[1]);
    assert.deepEqual(result.structuredContent, replay.structuredContent);
    assert.isTrue(startWorkSchema.safeParse(invocation.arguments).success);
    assert.isFalse(startWorkSchema.safeParse({ ...invocation.arguments, again: true }).success);
    assert.deepInclude(callers[0] as object, { profile_id: "profile" });
    assert.deepInclude((callers[0] as { authority: object }).authority, {
      thread_id: "caller",
      turn_id: "turn",
    });

    refusal = "Nodex starts only Pages that start on their own";
    const refused = yield* execute({
      ...invocation,
      arguments: { pageId: "asked", idempotencyKey: "start:asked" },
    });
    assert.isTrue(refused.isError);
    assert.include(JSON.stringify(refused.content), refusal);
  }),
);
