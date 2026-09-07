import { assert, it } from "@effect/vitest";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { CoreAutomationRun } from "../automation-application/AutomationProjection";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { AutomationRoutingIndex } from "../core-runtime/AutomationRoutingIndex";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexHeartbeatTurnCompletion } from "./CodexHeartbeatTurnCompletion";
import { CodexAutomationTurnCompletion, live } from "./CodexAutomationTurnCompletion";

const turn = (status: Turn["status"]): Turn => ({
  id: "turn",
  status,
  items: [],
  itemsView: "full",
  error: null,
  startedAt: 1,
  completedAt: 2,
  durationMs: 1000,
});

it.effect("applies a cron preference only until the run is accepted for manual conversation", () =>
  Effect.gen(function* () {
    let status: CoreAutomationRun["status"] = "PENDING_REVIEW";
    let definitionReads = 0;
    let heartbeatDecision: { readonly decision: null } | null = null;
    const context = yield* Layer.build(
      live.pipe(
        Layer.provide(
          Layer.succeed(
            CoreModules,
            CoreModules.of({
              automation: {
                read: (query: Parameters<CoreModuleClients["automation"]["read"]>[0]) => {
                  if (query.kind === "definition") definitionReads += 1;
                  return Effect.succeed({
                    contract_version: 5,
                    store_epoch: "epoch",
                    commit_head: 1,
                    value:
                      query.kind === "run"
                        ? {
                            kind: "run",
                            item: { thread_id: "thread", automation_id: "cron", status },
                          }
                        : {
                            kind: "definition",
                            item: { notification_policy: "failed_runs_only" },
                          },
                  });
                },
                apply: () => Effect.die("A completed or accepted run must not complete again"),
              },
            } as unknown as CoreModuleClients),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            AutomationRoutingIndex,
            AutomationRoutingIndex.of({
              commit: () => undefined,
              synchronize: Effect.void,
              activeHeartbeatAutomationId: () => null,
              runAutomationId: () => null,
            }),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            CodexApplicationEventHub,
            CodexApplicationEventHub.of({
              events: Stream.empty,
              publish: () => undefined,
            }),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            CodexHeartbeatTurnCompletion,
            CodexHeartbeatTurnCompletion.of({
              notificationDecision: () => Effect.succeed(heartbeatDecision),
              start: () => Effect.die("unused"),
              startAndWait: () => Effect.die("unused"),
            }),
          ),
        ),
      ),
    );
    const service = Context.get(context, CodexAutomationTurnCompletion);
    assert.strictEqual(yield* service.complete("thread", turn("completed")), "DONT_NOTIFY");
    assert.strictEqual(yield* service.complete("thread", turn("failed")), "NOTIFY");
    assert.strictEqual(definitionReads, 2);
    status = "ACCEPTED";
    assert.strictEqual(yield* service.complete("thread", turn("completed")), null);
    assert.strictEqual(definitionReads, 2);
    status = "PENDING_REVIEW";
    heartbeatDecision = { decision: null };
    assert.strictEqual(yield* service.complete("thread", turn("completed")), null);
    assert.strictEqual(definitionReads, 2);
  }),
);
