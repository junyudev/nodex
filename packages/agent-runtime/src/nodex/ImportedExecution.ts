import { createHash } from "node:crypto";
import {
  EventId,
  OrchestrationV2ProviderThread,
  ProviderSessionId,
  ThreadId,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { detachNativeConversation } from "../orchestration-v2/NativeConversation.ts";
import * as ImportedExecutionSettlement from "./ImportedExecutionSettlement.ts";
import { profilePathSource, relocateProfilePath } from "./ImportedExecutionPaths.ts";
import { syncDirectory } from "../platform/node/filesystem-durability.ts";

const utcTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return (
      Option.isSome(parsed) && DateTime.formatIso(parsed.value).slice(0, 19) === value.slice(0, 19)
    );
  }),
);
const Marker = Schema.Struct({
  version: Schema.Literal(1),
  sourceProfileHome: Schema.NonEmptyString,
  importedAt: utcTimestamp,
});
const decodeMarker = Schema.decodeEffect(Schema.fromJsonString(Marker));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeProviderThread = Schema.decodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ProviderThread)),
);

export class ImportedExecutionError extends Schema.TaggedError<ImportedExecutionError>()(
  "ImportedExecutionError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const threadEvents = [
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.auto-settle-set",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.active-reordered",
  "thread.visited",
  "thread.marked-unread",
  "thread.metadata-updated",
  "thread.pull-request-synced",
  "thread.runtime-mode-updated",
  "thread.interaction-mode-updated",
  "thread.model-selection-updated",
  "thread.provider-switched",
];
const locationPaths = [
  "cwd",
  "managedWorktreePath",
  "projectlessOutputDirectory",
  "projectlessWorkspaceBrowserRoot",
  "workspaceRoots.*",
];
const threadPaths = [
  "worktreePath",
  ...["executionLocation", "executionHandoff.sourceLocation"].flatMap((prefix) =>
    locationPaths.map((field) => `${prefix}.${field}`),
  ),
];
const workflowPaths = ["workflow.runHandles.transcriptDir", "workflow.runHandles.scriptPath"];
const eventPaths = (type: string): readonly string[] => {
  if (threadEvents.includes(type)) return threadPaths;
  if (["project.created", "project.meta-updated"].includes(type))
    return ["workspaceRoot", "faviconPath", "repositoryIdentity.rootPath"];
  if (
    ["provider-session.attached", "provider-session.updated", "checkpoint-scope.created"].includes(
      type,
    )
  )
    return ["cwd"];
  if (type === "subagent.updated") return workflowPaths;
  return [];
};

/** Only schema-owned path selectors participate; conversation text and native identities are opaque. */
const relocateAt = (
  value: unknown,
  [field, ...tail]: readonly string[],
  relocate: (path: string) => string,
): unknown => {
  if (field === undefined) return typeof value === "string" ? relocate(value) : value;
  if (field === "*" && Array.isArray(value))
    return value.map((item) => relocateAt(item, tail, relocate));
  if (!Predicate.isObject(value) || Array.isArray(value) || !(field in value)) return value;
  const object = value as Record<string, unknown>;
  return { ...object, [field]: relocateAt(object[field], tail, relocate) };
};

const relocateJsonTable = Effect.fnUntraced(function* (
  table: string,
  field: string,
  selectors: readonly string[],
  relocate: (value: string) => string,
  source: string,
  caseInsensitive: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  let after = 0;
  const jsonText = JSON.stringify(source).slice(1, -1);
  const containsSource = caseInsensitive
    ? `instr(lower(${field}), lower(?)) > 0`
    : `instr(${field}, ?) > 0`;
  const isEvents = table === "orchestration_events" || table === "orchestration_v2_events";
  const types = [
    ...threadEvents,
    "project.created",
    "project.meta-updated",
    "provider-session.attached",
    "provider-session.updated",
    "checkpoint-scope.created",
    "subagent.updated",
  ];
  while (true) {
    const rows = yield* sql.unsafe<{ row_id: number; value: string; event_type?: string }>(
      // Only a row whose JSON text contains the source home can change, so a production-size
      // event log is filtered in SQLite instead of decoding every payload before readiness.
      `SELECT rowid AS row_id, ${field} AS value ${isEvents ? ", event_type" : ""} FROM ${table} WHERE rowid > ? AND ${containsSource} ${isEvents ? `AND event_type IN (${types.map(() => "?").join(",")})` : ""} ORDER BY rowid LIMIT 200`,
      isEvents ? [after, jsonText, ...types] : [after, jsonText],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const original = yield* decodeJson(row.value);
      const paths = isEvents ? eventPaths(row.event_type!) : selectors;
      if (
        table === "scheduled_tasks" &&
        (!Predicate.hasProperty(original, "type") || original.type !== "existing_worktree")
      )
        continue;
      const relocated = paths.reduce<unknown>(
        (value, selector) => relocateAt(value, selector.split("."), relocate),
        original,
      );
      const value = yield* encodeJson(relocated);
      if (value !== row.value)
        yield* sql.unsafe(`UPDATE ${table} SET ${field} = ? WHERE rowid = ?`, [value, row.row_id]);
    }
    after = rows.at(-1)!.row_id;
  }
});

export const relocatePaths = Effect.fnUntraced(function* (source: string, target: string) {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  if (source === target) return;
  const selectedSource = profilePathSource(path, source);
  const caseInsensitive = path.sep === "\\";
  // Match both ordinary UNC paths and their canonical namespace representation.
  const searchSource = caseInsensitive ? selectedSource.replace(/^\\\\/u, "") : selectedSource;
  const relocate = (value: string) => relocateProfilePath(path, selectedSource, target, value);
  for (const [table, field] of [
    ["projection_projects", "workspace_root"],
    ["projection_projects", "favicon_path"],
    ["orchestration_v2_thread_launch_workflows", "worktree_path"],
  ]) {
    const rows = yield* sql.unsafe<{ row_id: number; value: string }>(
      `SELECT rowid AS row_id, ${field} AS value FROM ${table} WHERE ${caseInsensitive ? `instr(lower(${field}), lower(?))` : `instr(${field}, ?)`} > 0`,
      [searchSource],
    );
    for (const row of rows) {
      const value = relocate(row.value);
      if (value !== row.value)
        yield* sql.unsafe(`UPDATE ${table} SET ${field} = ? WHERE rowid = ?`, [value, row.row_id]);
    }
  }
  for (const [table, field, selectors] of [
    ["orchestration_v2_projection_threads", "payload_json", threadPaths],
    ["orchestration_v2_projection_provider_sessions", "payload_json", ["cwd"]],
    ["orchestration_v2_projection_checkpoint_scopes", "payload_json", ["cwd"]],
    ["orchestration_v2_projection_subagents", "payload_json", workflowPaths],
    ["scheduled_tasks", "workspace_strategy_json", ["worktreePath"]],
    ["orchestration_events", "payload_json", []],
    ["orchestration_v2_events", "payload_json", []],
  ] as const) {
    yield* relocateJsonTable(table, field, selectors, relocate, searchSource, caseInsensitive);
  }
});

/** Runs before recovery or command admission; the receipt makes commit-before-unlink crashes harmless. */
export const consume = Effect.fn("ImportedExecution.consume")(function* (runtimeHome: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markerPath = path.join(runtimeHome, "imported-execution.json");
  if (!(yield* fs.exists(markerPath))) return;
  yield* Effect.gen(function* () {
    const marker = yield* fs.readFileString(markerPath).pipe(
      Effect.flatMap((text) => decodeMarker(text, { onExcessProperty: "error" })),
      Effect.mapError(
        (cause) =>
          new ImportedExecutionError({
            message:
              "Invalid imported-execution.json: expected version 1, an absolute canonical sourceProfileHome, and an ISO-8601 UTC importedAt.",
            cause,
          }),
      ),
    );
    if (
      !path.isAbsolute(marker.sourceProfileHome) ||
      path.normalize(marker.sourceProfileHome) !== marker.sourceProfileHome
    )
      return yield* new ImportedExecutionError({
        message:
          "Invalid imported-execution.json: sourceProfileHome must be an absolute canonical Profile path.",
      });
    const target = path.dirname(runtimeHome);
    const importKey = createHash("sha256")
      .update(JSON.stringify([marker, target]))
      .digest("hex");
    const sql = yield* SqlClient.SqlClient;
    const events = yield* EventSinkV2;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const applied =
          yield* sql`SELECT import_key FROM execution_store_imports WHERE import_key = ${importKey}`;
        if (applied.length > 0) return;
        yield* relocatePaths(marker.sourceProfileHome, target);
        const now = yield* DateTime.now;
        yield* ImportedExecutionSettlement.settle(importKey, now);
        const rows = yield* sql<{ payload_json: string; thread_id: string | null }>`
        SELECT thread.payload_json, COALESCE(thread.thread_id,
          (SELECT node.thread_id FROM orchestration_v2_projection_nodes node WHERE node.node_id = thread.owner_node_id),
          (SELECT event.stream_id FROM orchestration_events event
            WHERE event.event_type = 'provider-thread.updated' AND json_extract(event.payload_json, '$.id') = thread.provider_thread_id
            ORDER BY event.sequence DESC LIMIT 1)) AS thread_id
        FROM orchestration_v2_projection_provider_threads thread`;
        for (const row of rows) {
          const thread = yield* decodeProviderThread(row.payload_json);
          const threadId =
            thread.appThreadId ?? (row.thread_id === null ? null : ThreadId.make(row.thread_id));
          if (threadId === null)
            return yield* new ImportedExecutionError({
              message: `Imported native conversation ${thread.id} has no execution owner.`,
            });
          yield* events.write({
            events: [
              {
                id: EventId.make(`execution-import:${importKey}:thread:${thread.id}`),
                type: "provider-thread.updated",
                threadId,
                driver: thread.driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: now,
                payload: { ...detachNativeConversation(thread, now), providerSessionId: null },
              },
            ],
          });
        }
        const sessions = yield* sql<{ provider_session_id: string; thread_id: string }>`
        SELECT provider_session_id, thread_id FROM orchestration_v2_projection_provider_sessions`;
        for (const session of sessions)
          yield* events.write({
            events: [
              {
                id: EventId.make(
                  `execution-import:${importKey}:session:${session.provider_session_id}`,
                ),
                type: "provider-session.detached",
                threadId: ThreadId.make(session.thread_id),
                occurredAt: now,
                payload: {
                  providerSessionId: ProviderSessionId.make(session.provider_session_id),
                  detachedAt: now,
                  reason: "Execution store imported into this Profile.",
                },
              },
            ],
          });
        yield* sql`UPDATE execution_store_state SET store_coordinate = NULL WHERE singleton = 1`;
        yield* sql`INSERT INTO execution_store_imports(import_key) VALUES (${importKey})`;
      }),
    );
    yield* fs.remove(markerPath);
    yield* syncDirectory(fs, runtimeHome);
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(ImportedExecutionError)(cause)
        ? cause
        : new ImportedExecutionError({
            message: "Could not apply imported execution store transition.",
            cause,
          }),
    ),
  );
});
