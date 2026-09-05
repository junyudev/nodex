import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { AutomationRoutingIndex } from "../core-runtime/AutomationRoutingIndex";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexAutomationInbox, live } from "./CodexAutomationInbox";

it.effect("commits Automation inbox directives with the request occurrence identity", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const applied: unknown[] = [];
    const routing: unknown[] = [];
    const events: unknown[] = [];
    const run = {
      automation_id: "automation-a",
      thread_id: "thread-a",
      run_revision: 4,
      status: "IN_PROGRESS",
      thread_title: null,
      inbox_title: null,
      inbox_summary: null,
      source_cwd: null,
      read_at_ms: null,
      archived_user_message: null,
      archived_assistant_message: null,
      archived_reason: null,
      created_at_ms: 1,
      updated_at_ms: 1,
    } as const;
    const core = CoreModules.of({
      automation: {
        read: () => Effect.succeed({ value: { kind: "run", item: run } } as never),
        apply: (input: Parameters<CoreModules["Service"]["automation"]["apply"]>[0]) =>
          Effect.sync(() => {
            applied.push(input);
            return {
              outcome: { runs: [{ ...run, run_revision: 5, inbox_title: "Review" }] },
            } as never;
          }),
      },
    } as unknown as CoreModules["Service"]);
    const context = yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CoreModules, core),
            Layer.succeed(
              AutomationRoutingIndex,
              AutomationRoutingIndex.of({
                commit: (input) => routing.push(input),
                synchronize: Effect.void,
                activeHeartbeatAutomationId: () => null,
                runAutomationId: () => null,
              }),
            ),
            Layer.succeed(
              CodexApplicationEventHub,
              CodexApplicationEventHub.of({
                publish: (event) => events.push(event),
                events: Stream.empty,
              }),
            ),
          ),
        ),
      ),
      scope,
    );
    const inbox = Context.get(context, CodexAutomationInbox);

    const response = yield* inbox.create(
      { conversationId: "thread-a", items: [{ title: "Review", summary: "Ready" }] },
      { occurrenceId: "local:1:inbox-a:42", occurrenceToken: 42 },
    );

    assert.deepEqual(response.items, [
      { id: "thread-a", title: "Review", description: "Ready", threadId: "thread-a" },
    ]);
    assert.strictEqual(
      (applied[0] as { operationId: string }).operationId,
      "codex:inbox-item:0:thread-a:local:1:inbox-a:42",
    );
    assert.strictEqual(routing.length, 1);
    assert.deepEqual(events, [
      {
        kind: "codex",
        value: {
          type: "automationRunsUpdated",
          event: {
            automationId: "automation-a",
            threadId: "thread-a",
            reason: "turn-completed",
          },
        },
      },
    ]);
    yield* Scope.close(scope, Exit.void);
  }),
);
