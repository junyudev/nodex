import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { CodexScheduledAutomation } from "../../shared/types";
import {
  AutomationApplication,
  AutomationApplicationError,
  type AutomationDefinitions,
} from "../automation-application/AutomationApplication";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { createStableOperationId } from "../core-runtime/operation-identity";
import {
  ProjectWorkspace,
  type ProjectWorkspaceService,
} from "../project-application/ProjectWorkspace";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./AutomationAppTools";

const authority: FrozenNodexAgentTurnAuthority = {
  threadId: "thread:a",
  turnId: "turn:a",
  rootThreadId: "thread:a",
  actorProjectId: "project:a",
  libraryId: "library:a",
  storeEpoch: "epoch:a",
  frozenAtMs: 1_000,
  readOnly: false,
  scope: "project",
  source: "project_turn",
};
const provenance = {
  profile_id: "profile:a",
  authority: {
    thread_id: "thread:a",
    turn_id: "turn:a",
    root_thread_id: "thread:a",
    actor_project_id: "project:a",
    library_id: "library:a",
    store_epoch: "epoch:a",
    scope: "project",
    source: "project_turn",
  },
};
const input = (args: Record<string, unknown>): AppToolInvocation => ({
  name: "automation_update",
  arguments: args,
  caller: {
    threadId: "thread:a",
    turnId: "turn:a",
    callId: "call:a",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
});
const cron = {
  kind: "cron",
  name: "Check release builds",
  prompt: "Check release builds and report failed jobs.",
  rrule: "FREQ=HOURLY;INTERVAL=24",
  projectId: "project:a",
  executionEnvironment: "local",
  cwds: ["/workspace/project-a"],
  notificationPolicy: "failed_runs_only",
  model: "chosen-model",
  reasoningEffort: "ultra",
  serviceTier: "priority",
};
const item: CodexScheduledAutomation = {
  id: "automation:a",
  definitionRevision: 1,
  kind: "cron",
  status: "ACTIVE",
  projectId: "project:a",
  targetSessionId: null,
  targetThreadId: null,
  notificationPolicy: "failed_runs_only",
  name: "Check release builds",
  prompt: "Check release builds and report failed jobs.",
  rrule: "FREQ=HOURLY;INTERVAL=24",
  model: "chosen-model",
  reasoningEffort: "ultra",
  serviceTier: "priority",
  backendBinding: { kind: "codex" },
  cwds: ["/workspace/project-a"],
  executionEnvironment: "local",
  localEnvironmentConfigPath: null,
  nextRunAt: 60_000,
  lastRunAt: null,
  createdAt: 1_000,
  updatedAt: 1_000,
};
const setup = (
  definitions: Partial<AutomationDefinitions>,
  options: {
    readOnly?: boolean;
    workspace?: Partial<ProjectWorkspaceService>;
  } = {},
) =>
  make.pipe(
    Effect.provideService(AutomationApplication, { definitions } as never),
    Effect.provideService(ProjectWorkspace, (options.workspace ?? {}) as ProjectWorkspaceService),
    Effect.provideService(CoreAuthority, { identity: { profileId: "profile:a" } } as never),
    Effect.provideService(CodexTurnAuthority, {
      capture: () => Effect.succeed({ ...authority, readOnly: options.readOnly ?? false }),
    } as never),
  );

it.effect("allows authorized discovery on read-only Turns and rejects every mutation", () =>
  Effect.gen(function* () {
    const reads: unknown[] = [];
    const execute = yield* setup(
      {
        listWindow: (query) =>
          Effect.gen(function* () {
            reads.push({ query, provenance: yield* CoreApplicationAgent });
            return { items: [item], nextCursor: "older" };
          }),
        get: (id) =>
          Effect.gen(function* () {
            reads.push({ id, provenance: yield* CoreApplicationAgent });
            return item;
          }),
      },
      { readOnly: true },
    );
    const listed = yield* execute(
      input({ mode: "list", query: "build", cursor: "page", limit: 7 }),
    );
    assert.deepStrictEqual(listed.structuredContent, { items: [item], nextCursor: "older" });
    const viewed = yield* execute(input({ mode: "view", id: item.id }));
    assert.deepStrictEqual(viewed.structuredContent, { item });
    assert.deepStrictEqual(reads, [
      { query: { query: "build", cursor: "page", limit: 7 }, provenance },
      { id: item.id, provenance },
    ]);
    for (const args of [
      { ...cron, mode: "create" },
      { ...cron, mode: "update", id: item.id, expectedRevision: 1, status: "PAUSED" },
      { mode: "delete", id: item.id, expectedRevision: 1 },
    ]) {
      const rejected = yield* execute(input(args));
      assert.isTrue(rejected.isError);
      assert.deepStrictEqual(rejected.structuredContent, { error: { code: "read_only_turn" } });
    }
    const forged = yield* execute(
      input({ ...cron, mode: "create", authority: { scope: "library" } }),
    );
    assert.deepStrictEqual(forged.structuredContent, { error: { code: "invalid_arguments" } });
    assert.strictEqual(yield* CoreApplicationAgent, null);
  }),
);

it.effect("relays exact definition commands, revision fences, and stable retry provenance", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const execute = yield* setup({
      create: (definition, command) =>
        Effect.gen(function* () {
          calls.push({
            mode: "create",
            definition,
            command,
            provenance: yield* CoreApplicationAgent,
          });
          return item;
        }),
      update: (definition, command) =>
        Effect.gen(function* () {
          calls.push({
            mode: "update",
            definition,
            command,
            provenance: yield* CoreApplicationAgent,
          });
          return { ...item, status: "PAUSED", definitionRevision: 2 };
        }),
      delete: (id, command) =>
        Effect.gen(function* () {
          calls.push({ mode: "delete", id, command, provenance: yield* CoreApplicationAgent });
          return { item: null, success: true, status: "deleted", deletedRunCount: 3 };
        }),
    });
    const call = input({ ...cron, mode: "create" });
    const operationId = createStableOperationId("app.automation_update", authority.frozenAtMs, [
      "profile:a",
      "thread:a",
      "turn:a",
      "call:a",
    ]);
    const first = yield* execute(call);
    assert.deepStrictEqual(first.structuredContent, { operationId, item });
    assert.deepStrictEqual(yield* execute(call), first);
    const retry = yield* execute({
      ...call,
      arguments: { ...call.arguments, operationId },
      caller: { ...call.caller, callId: "retry:a" },
    });
    assert.deepStrictEqual(retry, first);
    assert.deepStrictEqual(calls[0], calls[1]);
    assert.deepStrictEqual(calls[0], calls[2]);
    assert.deepStrictEqual(calls[0], {
      mode: "create",
      definition: cron,
      command: { operationId },
      provenance,
    });

    const updateId = createStableOperationId("automation-test", 1_000, "update");
    const updated = yield* execute(
      input({
        ...cron,
        mode: "update",
        id: item.id,
        status: "PAUSED",
        notificationPolicy: null,
        expectedRevision: 1,
        operationId: updateId,
      }),
    );
    assert.strictEqual(updated.structuredContent?.operationId, updateId);
    assert.deepStrictEqual(calls[3], {
      mode: "update",
      definition: { ...cron, id: item.id, status: "PAUSED", notificationPolicy: null },
      command: { operationId: updateId, expectedRevision: 1 },
      provenance,
    });
    const deleteId = createStableOperationId("automation-test", 1_000, "delete");
    const deleted = yield* execute(
      input({
        mode: "delete",
        id: item.id,
        expectedRevision: 2,
        operationId: deleteId,
      }),
    );
    assert.deepStrictEqual(deleted.structuredContent, {
      operationId: deleteId,
      item: null,
      success: true,
      status: "deleted",
      deletedRunCount: 3,
    });
    assert.deepStrictEqual(calls[4], {
      mode: "delete",
      id: item.id,
      command: { operationId: deleteId, expectedRevision: 2 },
      provenance,
    });
    assert.strictEqual(yield* CoreApplicationAgent, null);
  }),
);

it.effect("defaults Heartbeats to the caller's stable Session and preserves explicit targets", () =>
  Effect.gen(function* () {
    const targets: unknown[] = [];
    const lookups: unknown[] = [];
    const execute = yield* setup(
      {
        create: (definition) =>
          Effect.sync(() => {
            targets.push(definition);
            return item;
          }),
      },
      {
        workspace: {
          getThread: (threadId) =>
            Effect.gen(function* () {
              lookups.push({ threadId, provenance: yield* CoreApplicationAgent });
              return { sessionId: "session:caller" } as never;
            }),
        },
      },
    );
    const definition = {
      kind: "heartbeat",
      name: "Watch the build",
      prompt: "Report build changes.",
      rrule: "FREQ=MINUTELY;INTERVAL=30",
    };
    assert.isUndefined((yield* execute(input({ ...definition, mode: "create" }))).isError);
    assert.isUndefined(
      (yield* execute(
        input({
          ...definition,
          mode: "create",
          targetSessionId: "session:other",
        }),
      )).isError,
    );
    assert.deepStrictEqual(lookups, [{ threadId: "thread:a", provenance }]);
    assert.deepStrictEqual(targets, [
      { ...definition, targetSessionId: "session:caller" },
      { ...definition, targetSessionId: "session:other" },
    ]);
  }),
);

it.effect("rejects a caller withdrawn during target lookup before committing a Heartbeat", () =>
  Effect.gen(function* () {
    let active = true;
    let writes = 0;
    const execute = yield* setup(
      {
        create: () =>
          Effect.sync(() => {
            writes++;
            return item;
          }),
      },
      {
        workspace: {
          getThread: () =>
            Effect.sync(() => {
              active = false;
              return { sessionId: "session:caller" } as never;
            }),
        },
      },
    );
    const call = input({
      mode: "create",
      kind: "heartbeat",
      name: "Build",
      prompt: "Check builds.",
      rrule: "FREQ=MINUTELY;INTERVAL=30",
    });
    const result = yield* execute({ ...call, caller: { ...call.caller, isActive: () => active } });
    assert.isTrue(result.isError);
    assert.strictEqual(writes, 0);
  }),
);

it.effect(
  "represents missing definitions and safely rejects denied owners or withdrawn results",
  () =>
    Effect.gen(function* () {
      const missing = yield* setup({ get: () => Effect.succeed(null) });
      assert.deepStrictEqual(
        (yield* missing(input({ mode: "view", id: "missing" }))).structuredContent,
        { item: null },
      );
      const denied = yield* setup({
        get: () =>
          Effect.fail(
            new AutomationApplicationError({
              operation: "get",
              cause: new Error("private persisted authority detail"),
            }),
          ),
      });
      const rejected = yield* denied(input({ mode: "view", id: "private" }));
      assert.isTrue(rejected.isError);
      assert.notInclude(JSON.stringify(rejected), "private persisted authority detail");
      let active = true;
      const withdrawn = yield* setup({
        create: () =>
          Effect.sync(() => {
            active = false;
            return item;
          }),
      });
      const call = input({ ...cron, mode: "create" });
      assert.isTrue(
        (yield* withdrawn({
          ...call,
          caller: { ...call.caller, isActive: () => active },
        })).isError,
      );
    }),
);

it.effect("returns review proposals without mutation and rejects stale update proposals", () =>
  Effect.gen(function* () {
    const execute = yield* setup({ get: () => Effect.succeed(item) }, { readOnly: true });
    const created = yield* execute(input({ ...cron, mode: "suggested_create" }));
    assert.deepStrictEqual(created.structuredContent, {
      proposal: { ...cron, mode: "suggested_create" },
      committed: false,
    });
    const args = {
      ...cron,
      mode: "suggested_update",
      id: item.id,
      expectedRevision: 1,
      status: "PAUSED",
    };
    assert.deepStrictEqual((yield* execute(input(args))).structuredContent, {
      proposal: args,
      committed: false,
    });
    assert.deepStrictEqual(
      (yield* execute(input({ ...args, expectedRevision: 2 }))).structuredContent,
      {
        error: { code: "conflict" },
      },
    );
  }),
);
