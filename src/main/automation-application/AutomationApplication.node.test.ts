import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AutomationApplyResult, AutomationReadSnapshot } from "../core-client/types";
import { AutomationRoutingIndex } from "../core-runtime/AutomationRoutingIndex";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { make } from "./AutomationApplication";
import type {
  CoreAutomationDefinition,
  CoreAutomationRun,
  CoreScheduledPageOccurrence,
} from "./AutomationProjection";

const definition = (
  overrides: Partial<CoreAutomationDefinition> = {},
): CoreAutomationDefinition => ({
  automation_id: "daily-report",
  definition_revision: 1,
  kind: "heartbeat",
  status: "ACTIVE",
  target_thread_id: "thread:source",
  name: "Daily Report",
  prompt: "Summarize the workspace.",
  rrule: "FREQ=DAILY;BYHOUR=9",
  model: "gpt-5",
  reasoning_effort: "medium",
  service_tier: null,
  backend_binding: { kind: "codex" },
  cwds: ["/workspace"],
  execution_environment: "worktree",
  local_environment_config_path: null,
  next_run_at_ms: 200,
  last_run_at_ms: null,
  created_at_ms: 100,
  updated_at_ms: 100,
  ...overrides,
});

const run = (overrides: Partial<CoreAutomationRun> = {}): CoreAutomationRun => ({
  thread_id: "thread:run",
  automation_id: "daily-report",
  run_revision: 1,
  status: "IN_PROGRESS",
  read_at_ms: null,
  thread_title: "Daily Report run",
  source_cwd: "/workspace",
  inbox_title: null,
  inbox_summary: null,
  archived_user_message: null,
  archived_assistant_message: null,
  archived_reason: null,
  created_at_ms: 120,
  updated_at_ms: 120,
  ...overrides,
});

const occurrence = (
  overrides: Partial<CoreScheduledPageOccurrence> = {},
): CoreScheduledPageOccurrence => ({
  occurrence_id: "page:planning:2026-07-20T01:00:00.000Z",
  page_id: "page:planning",
  page_key: "LAB-13",
  status: "plan",
  status_name: "Plan",
  archived: false,
  title: "Planning session",
  rich_title: [{ type: "text", text: "Planning session", styles: {} }],
  description: "Plan the next milestone.",
  priority: "p1-high",
  estimate: "m",
  tags: ["planning"],
  due_date: "2026-07-20T03:00:00.000Z",
  occurrence_start_ms: Date.parse("2026-07-20T01:00:00.000Z"),
  occurrence_end_ms: Date.parse("2026-07-20T02:00:00.000Z"),
  is_all_day: false,
  recurrence: null,
  reminders: [{ offsetMinutes: 30 }],
  schedule_timezone: "Asia/Shanghai",
  assignee: null,
  run_in_target: "localProject",
  run_in_local_path: "/workspace",
  run_in_base_branch: null,
  run_in_worktree_path: null,
  run_in_environment_path: null,
  metadata_revision: 3,
  created_at: "2026-07-19T00:00:00.000Z",
  updated_at: "2026-07-19T01:00:00.000Z",
  order: 100,
  is_recurring: false,
  this_and_future_equivalent_to_all: false,
  ...overrides,
});

const readSnapshot = (value: AutomationReadSnapshot["value"]): AutomationReadSnapshot => ({
  contract_version: 3,
  store_epoch: "epoch:test",
  commit_head: 7,
  value,
});

const window = <A>(items: readonly A[], nextCursor: string | null = null) => ({
  items,
  next_cursor: nextCursor,
  authority: { projection_revision: 7 },
});

const committed = (outcome: Partial<AutomationApplyResult["outcome"]>): AutomationApplyResult => ({
  status: "committed",
  commit: {
    store_epoch: "epoch:test",
    commit_seq: 8,
    manifest_hash: "f".repeat(64),
  },
  receipt: {
    operation_id: "operation:test",
    duplicate: false,
    affected_automation_ids: [],
    affected_lease_ids: [],
    affected_run_ids: [],
    affected_reminder_lease_ids: [],
    affected_snooze_ids: [],
    affected_page_ids: [],
    affected_document_ids: [],
    affected_database_ids: [],
  },
  outcome: {
    affected_automation_ids: [],
    definitions: [],
    claimed_leases: [],
    runs: [],
    deleted_run_ids: [],
    reminder_leases: [],
    reminder_snoozes: [],
    ...outcome,
  },
});

const noOp = (outcome: Partial<AutomationApplyResult["outcome"]>): AutomationApplyResult => {
  const result = committed(outcome);
  if (result.status !== "committed") throw new Error("Committed fixture is invalid");
  const { commit: _, ...rest } = result;
  return {
    ...rest,
    status: "no_op",
    observed: { store_epoch: "epoch:observed", commit_head: 13 },
  };
};

const routingIndex = () => {
  const activeHeartbeats = new Map<string, string>();
  const runs = new Map<string, string>();
  return AutomationRoutingIndex.of({
    commit: (input) => {
      for (const automationId of input.definitions?.removeIds ?? []) {
        for (const [threadId, currentAutomationId] of activeHeartbeats) {
          if (currentAutomationId === automationId) activeHeartbeats.delete(threadId);
        }
      }
      for (const item of input.definitions?.upsert ?? []) {
        for (const [threadId, automationId] of activeHeartbeats) {
          if (automationId === item.automation_id) activeHeartbeats.delete(threadId);
        }
        if (item.kind === "heartbeat" && item.status === "ACTIVE" && item.target_thread_id) {
          activeHeartbeats.set(item.target_thread_id, item.automation_id);
        }
      }
      for (const threadId of input.runs?.removeThreadIds ?? []) runs.delete(threadId);
      for (const item of input.runs?.upsert ?? []) {
        runs.set(item.thread_id, item.automation_id);
      }
    },
    synchronize: Effect.void,
    activeHeartbeatAutomationId: (threadId) => activeHeartbeats.get(threadId) ?? null,
    runAutomationId: (threadId) => runs.get(threadId) ?? null,
  });
};

const coreModules = (automation: CoreModuleClients["automation"]): CoreModules["Service"] =>
  CoreModules.of({ automation } as unknown as CoreModuleClients);

it.effect("commits Definition and Run routing before mutations return", () =>
  Effect.gen(function* () {
    const reads: AutomationReadSnapshot[] = [readSnapshot({ kind: "definition", item: null })];
    const applies: AutomationApplyResult[] = [
      committed({ definitions: [definition()] }),
      committed({ runs: [run()] }),
    ];
    const routing = routingIndex();
    const application = yield* make.pipe(
      Effect.provideService(
        CoreModules,
        coreModules({
          read: () => Effect.succeed(reads.shift()!),
          apply: () => Effect.succeed(applies.shift()!),
        }),
      ),
      Effect.provideService(AutomationRoutingIndex, routing),
    );

    const created = yield* application.definitions.create({
      kind: "heartbeat",
      name: "Daily Report",
      prompt: "Summarize the workspace.",
      targetThreadId: "thread:source",
      cwds: ["/workspace"],
    });
    assert.strictEqual(created.id, "daily-report");
    assert.strictEqual(routing.activeHeartbeatAutomationId("thread:source"), "daily-report");

    assert.isTrue(
      yield* application.runs.begin({
        threadId: "thread:run",
        automationId: "daily-report",
      }),
    );
    assert.strictEqual(routing.runAutomationId("thread:run"), "daily-report");
  }),
);

it.effect("rejects unsupported backend bindings before Definition mutations reach Core", () =>
  Effect.gen(function* () {
    let reads = 0;
    let applies = 0;
    const application = yield* make.pipe(
      Effect.provideService(
        CoreModules,
        coreModules({
          read: () => {
            reads += 1;
            return Effect.succeed(
              readSnapshot({
                kind: "definition",
                item: definition({
                  backend_binding: {
                    kind: "acp",
                    agent_definition_id: "claude-agent-acp",
                    instance_config_id: "claude:default",
                  },
                }),
              }),
            );
          },
          apply: () => {
            applies += 1;
            return Effect.die("Unsupported backend mutation reached Core");
          },
        }),
      ),
      Effect.provideService(AutomationRoutingIndex, routingIndex()),
    );
    const binding = {
      kind: "acp",
      agentDefinitionId: "claude-agent-acp",
      instanceConfigId: "claude:default",
    } as const;

    const createError = yield* Effect.flip(
      application.definitions.create({
        kind: "cron",
        name: "Unsupported",
        prompt: "Do not run.",
        backendBinding: binding,
      }),
    );
    assert.strictEqual(createError.operation, "definitions.create");
    assert.match(String(createError.cause), /only the Codex Agent Backend/);
    assert.strictEqual(reads, 0);

    const updateError = yield* Effect.flip(
      application.definitions.update({
        id: "daily-report",
        kind: "heartbeat",
        status: "ACTIVE",
        name: "Unsupported",
        prompt: "Do not run.",
        backendBinding: binding,
      }),
    );
    assert.strictEqual(updateError.operation, "definitions.update");
    assert.match(String(updateError.cause), /only the Codex Agent Backend/);
    assert.strictEqual(reads, 1);
    assert.strictEqual(applies, 0);
  }),
);

it.effect("rejects unsupported durable Definitions at the projection boundary", () =>
  Effect.gen(function* () {
    const application = yield* make.pipe(
      Effect.provideService(
        CoreModules,
        coreModules({
          read: () =>
            Effect.succeed(
              readSnapshot({
                kind: "definitions",
                window: window([
                  definition({
                    backend_binding: {
                      kind: "acp",
                      agent_definition_id: "claude-agent-acp",
                      instance_config_id: null,
                    },
                  }),
                ]),
              }),
            ),
          apply: () => Effect.die("Projection attempted an Automation mutation"),
        }),
      ),
      Effect.provideService(AutomationRoutingIndex, routingIndex()),
    );

    const projectionError = yield* Effect.flip(application.definitions.list());
    assert.strictEqual(projectionError.operation, "definitions.list");
    assert.match(String(projectionError.cause), /only the Codex Agent Backend/);
  }),
);

it.effect("routes occurrence reads and mutations through the exact Project scope", () =>
  Effect.gen(function* () {
    const calls: Array<{
      readonly kind: "read" | "apply";
      readonly projectId: string | undefined;
      readonly input: unknown;
    }> = [];
    const application = yield* make.pipe(
      Effect.provideService(
        CoreModules,
        coreModules({
          read: (input, _options, projectId) => {
            calls.push({ kind: "read", projectId, input });
            return Effect.succeed(
              readSnapshot({ kind: "occurrences", window: window([occurrence()]) }),
            );
          },
          apply: (input, _options, projectId) => {
            calls.push({ kind: "apply", projectId, input });
            return Effect.succeed(
              noOp({
                page_occurrence_mutation: {
                  operation_id: "calendar:update:1",
                  duplicate: true,
                  success: true,
                  created_page_id: null,
                },
              }),
            );
          },
        }),
      ),
      Effect.provideService(AutomationRoutingIndex, routingIndex()),
    );

    const listed = yield* application.occurrences.list({
      projectId: "project:one",
      windowStart: new Date("2026-07-20T00:00:00.000Z"),
      windowEnd: new Date("2026-07-21T00:00:00.000Z"),
      searchQuery: " planning ",
    });
    assert.strictEqual(listed.items[0]?.pageKey, "LAB-13");

    const updated = yield* application.occurrences.update("project:one", {
      operationId: "calendar:update:1",
      pageId: "page:planning",
      occurrenceStart: new Date("2026-07-20T01:00:00.000Z"),
      source: "calendar",
      scope: "all",
      updates: { scheduledStart: new Date("2026-07-20T04:00:00.000Z") },
    });
    assert.deepEqual(updated, {
      success: true,
      commitCursor: { storeEpoch: "epoch:observed", commitSeq: 13 },
    });
    assert.deepEqual(
      calls.map((call) => [call.kind, call.projectId]),
      [
        ["read", "project:one"],
        ["apply", "project:one"],
      ],
    );
    assert.deepInclude(calls[1]?.input as object, { operationId: "calendar:update:1" });
  }),
);

it.effect("keeps Inbox and Reminder scheduler traffic on the root background lane", () =>
  Effect.gen(function* () {
    const calls: Array<{
      readonly kind: "read" | "apply";
      readonly requestClass: string | undefined;
      readonly projectId: string | undefined;
    }> = [];
    const application = yield* make.pipe(
      Effect.provideService(
        CoreModules,
        coreModules({
          read: (_input, options, projectId) => {
            calls.push({ kind: "read", requestClass: options?.class, projectId });
            return Effect.succeed(
              readSnapshot({
                kind: "inbox",
                window: window([
                  {
                    automation_id: "daily-report",
                    automation_name: "Daily Report",
                    title: "Report ready",
                    description: "Review the report.",
                    archived_assistant_message: null,
                    archived_user_message: null,
                    archived_reason: null,
                    source_cwd: "/workspace",
                    thread_id: "thread:run",
                    read_at_ms: null,
                    created_at_ms: 120,
                    status: "PENDING_REVIEW",
                  },
                ]),
                unread_counts: { total: 1 },
              }),
            );
          },
          apply: (_input, options, projectId) => {
            calls.push({ kind: "apply", requestClass: options?.class, projectId });
            return Effect.succeed(
              committed({
                reminder_leases: [
                  {
                    lease_id: "reminder:1",
                    project_id: "project:one",
                    receipt_project_id: "project:owner",
                    page_id: "page:planning",
                    occurrence_start_ms: 200,
                    reminder_offset_minutes: 30,
                    due_at_ms: 170,
                    title: "Planning session",
                    claimed_at_ms: 171,
                    expires_at_ms: 300,
                    attempt: 1,
                    status: "claimed",
                    settled_at_ms: null,
                    retry_at_ms: null,
                    reason_code: null,
                    snooze_id: null,
                  },
                ],
              }),
            );
          },
        }),
      ),
      Effect.provideService(AutomationRoutingIndex, routingIndex()),
    );

    const inbox = yield* application.inbox.read(25, "background");
    assert.deepEqual(inbox.unreadRunCounts, {
      total: 1,
      automationIds: ["daily-report"],
      unreadRuns: [{ automationId: "daily-report", threadId: "thread:run" }],
    });

    const reminders = yield* application.reminders.claimDue("reminders:due", 12, 120_000);
    assert.deepInclude(reminders[0]!, {
      leaseId: "reminder:1",
      projectId: "project:one",
      pageId: "page:planning",
    });
    assert.deepEqual(calls, [
      { kind: "read", requestClass: "background", projectId: undefined },
      { kind: "apply", requestClass: "background", projectId: undefined },
    ]);
  }),
);
