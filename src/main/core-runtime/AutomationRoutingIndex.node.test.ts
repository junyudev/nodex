import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import type { AutomationRead, AutomationReadSnapshot } from "../core-client/types";
import {
  AutomationRoutingIndex,
  type AutomationRoutingDefinition,
  type AutomationRoutingRun,
  live,
} from "./AutomationRoutingIndex";
import { CoreModules, type CoreModuleClients } from "./CoreModules";

const definition = (input: {
  readonly automationId: string;
  readonly targetThreadId: string;
}): AutomationRoutingDefinition => ({
  automation_id: input.automationId,
  definition_revision: 1,
  kind: "heartbeat",
  status: "ACTIVE",
  target_thread_id: input.targetThreadId,
  name: input.automationId,
  prompt: "Check for updates",
  rrule: "FREQ=HOURLY",
  model: null,
  reasoning_effort: null,
  service_tier: null,
  backend_binding: { kind: "codex" },
  cwds: [],
  execution_environment: "local",
  local_environment_config_path: null,
  next_run_at_ms: null,
  last_run_at_ms: null,
  created_at_ms: 1,
  updated_at_ms: 1,
});

const run = (input: {
  readonly automationId: string;
  readonly threadId: string;
}): AutomationRoutingRun => ({
  thread_id: input.threadId,
  automation_id: input.automationId,
  run_revision: 1,
  status: "IN_PROGRESS",
  read_at_ms: null,
  thread_title: null,
  source_cwd: null,
  inbox_title: null,
  inbox_summary: null,
  archived_user_message: null,
  archived_assistant_message: null,
  archived_reason: null,
  created_at_ms: 1,
  updated_at_ms: 1,
});

const snapshot = (value: AutomationReadSnapshot["value"]): AutomationReadSnapshot => ({
  contract_version: 3,
  store_epoch: "epoch:test",
  commit_head: 1,
  value,
});

const definitionsSnapshot = (
  items: readonly AutomationRoutingDefinition[],
  nextCursor: string | null = null,
): AutomationReadSnapshot =>
  snapshot({
    kind: "definitions",
    window: { items, next_cursor: nextCursor, authority: { projection_revision: 1 } },
  });

const runsSnapshot = (
  items: readonly AutomationRoutingRun[],
  nextCursor: string | null = null,
): AutomationReadSnapshot =>
  snapshot({
    kind: "runs",
    window: {
      items,
      next_cursor: nextCursor,
      authority: { projection_revision: 1 },
    },
  });

it.effect("owns routing lookups and fences a stale rebuild behind a committed mutation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const staleDefinitions = yield* Deferred.make<AutomationReadSnapshot>();
      const staleRuns = yield* Deferred.make<AutomationReadSnapshot>();
      const staleReadsStarted = yield* Deferred.make<void>();
      let reads = 0;
      let staleReads = 0;
      let phase: "initial" | "stale" = "initial";
      const committedDefinition = definition({
        automationId: "heartbeat:new",
        targetThreadId: "thread:new-heartbeat",
      });
      const committedRun = run({
        automationId: "heartbeat:new",
        threadId: "thread:new-run",
      });

      const read = (request: AutomationRead): Effect.Effect<AutomationReadSnapshot> =>
        Effect.suspend(() => {
          reads += 1;
          if (request.kind !== "definitions" && request.kind !== "runs") {
            return Effect.die(new Error(`Unexpected Automation read: ${request.kind}`));
          }
          if (phase === "initial") {
            if (request.window.after === null) {
              return Effect.succeed(
                request.kind === "definitions"
                  ? definitionsSnapshot([], "definitions:2")
                  : runsSnapshot([], "runs:2"),
              );
            }
            return Effect.succeed(
              request.kind === "definitions"
                ? definitionsSnapshot([
                    definition({
                      automationId: "heartbeat:old",
                      targetThreadId: "thread:old-heartbeat",
                    }),
                  ])
                : runsSnapshot([
                    run({ automationId: "heartbeat:old", threadId: "thread:old-run" }),
                  ]),
            );
          }
          if (staleReads < 2) {
            staleReads += 1;
            if (staleReads === 2) Deferred.doneUnsafe(staleReadsStarted, Effect.void);
            return request.kind === "definitions"
              ? Deferred.await(staleDefinitions)
              : Deferred.await(staleRuns);
          }
          return Effect.succeed(
            request.kind === "definitions"
              ? definitionsSnapshot([committedDefinition])
              : runsSnapshot([committedRun]),
          );
        });
      const core = CoreModules.of({
        automation: { read },
      } as unknown as CoreModuleClients);
      const context = yield* Layer.build(
        live.pipe(Layer.provide(Layer.succeed(CoreModules, core))),
      );
      const routing = Context.get(context, AutomationRoutingIndex);

      yield* routing.synchronize;
      assert.strictEqual(
        routing.activeHeartbeatAutomationId("thread:old-heartbeat"),
        "heartbeat:old",
      );
      assert.strictEqual(routing.runAutomationId("thread:old-run"), "heartbeat:old");

      phase = "stale";
      const rebuilding = yield* Effect.forkChild(routing.synchronize);
      yield* Deferred.await(staleReadsStarted);
      routing.commit({
        definitions: { upsert: [committedDefinition] },
        runs: { upsert: [committedRun] },
      });
      yield* Deferred.succeed(staleDefinitions, definitionsSnapshot([]));
      yield* Deferred.succeed(staleRuns, runsSnapshot([]));
      yield* Fiber.join(rebuilding);

      assert.strictEqual(
        routing.activeHeartbeatAutomationId("thread:new-heartbeat"),
        "heartbeat:new",
      );
      assert.strictEqual(routing.runAutomationId("thread:new-run"), "heartbeat:new");
      assert.strictEqual(reads, 8);
    }),
  ),
);
