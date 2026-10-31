import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";

export const SessionQueueInput = Schema.Struct({
  threadId: ThreadId,
  action: Schema.Literals(["list", "read", "edit", "remove", "reorder", "steer"]),
  queuedId: Schema.optional(RunId),
  text: Schema.optional(Schema.String),
  beforeId: Schema.optional(Schema.NullOr(RunId)),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
  commandId: CommandId,
});
export type SessionQueueInput = typeof SessionQueueInput.Type;
export interface SessionQueueEntry {
  readonly queuedId: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly kind: "message" | "delegated_completion" | "notification";
  readonly held: boolean;
}
export type SessionQueueResult =
  | { readonly items: readonly SessionQueueEntry[]; readonly nextCursor: string | null }
  | SessionQueueEntry
  | { readonly sequence: number };
export class SessionQueueError extends Schema.TaggedError<SessionQueueError>()(
  "SessionQueueError",
  {
    reason: Schema.Literals([
      "not_queued",
      "invalid_cursor",
      "protected_entry",
      "unsupported",
      "invalid_arguments",
    ]),
    message: Schema.String,
  },
) {}
const fail = (reason: SessionQueueError["reason"], message: string) =>
  new SessionQueueError({ reason, message });
interface Row {
  readonly run_id: string;
  readonly message_id: string;
  readonly text: string;
  readonly total_chars: number;
  readonly priority: number;
  readonly position: number;
  readonly ordinal: number;
  readonly held: number;
  readonly kind: SessionQueueEntry["kind"];
}
const entry = (row: Row): SessionQueueEntry => ({
  queuedId: row.run_id,
  text: row.text,
  truncated: Array.from(row.text).length < row.total_chars,
  kind: row.kind,
  held: row.held === 1,
});
const cursorSchema = Schema.Tuple([
  Schema.String,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.String,
]);

/** Queue reads share delivery ordering; writes cross the same command owner as chat controls. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService;
  const orchestrator = yield* OrchestratorV2;
  const rows = (
    threadId: string,
    queuedId: string | undefined,
    chars: number,
    limit: number,
    anchor: readonly [string, number, number, number, string] | null = null,
  ) => sql<Row>`SELECT * FROM (
    SELECT run.run_id, json_extract(run.payload_json,'$.userMessageId') AS message_id,
      substr(json_extract(message.payload_json,'$.text'),1,${chars}) AS text,
      length(json_extract(message.payload_json,'$.text')) AS total_chars,
      CASE WHEN json_type(message.payload_json,'$.delegatedCompletion') IS NOT NULL THEN 0 ELSE 1 END AS priority,
      COALESCE(json_extract(run.payload_json,'$.queuePosition'),run.ordinal) AS position, run.ordinal,
      COALESCE(json_extract(run.payload_json,'$.queueHeld'),0) AS held,
      CASE WHEN json_type(message.payload_json,'$.delegatedCompletion') IS NOT NULL THEN 'delegated_completion'
        WHEN json_type(message.payload_json,'$.notification') IS NOT NULL THEN 'notification' ELSE 'message' END AS kind
    FROM orchestration_v2_projection_runs run JOIN orchestration_v2_projection_messages message
      ON message.thread_id=run.thread_id AND message.message_id=json_extract(run.payload_json,'$.userMessageId')
    WHERE run.thread_id=${threadId} AND run.status='queued' AND (${queuedId ?? null} IS NULL OR run.run_id=${queuedId ?? null})
    ) WHERE (${anchor === null ? 1 : 0}=1 OR (priority,position,ordinal,run_id)>(${anchor?.[1] ?? 0},${anchor?.[2] ?? 0},${anchor?.[3] ?? 0},${anchor?.[4] ?? ""}))
    ORDER BY priority,position,ordinal,run_id LIMIT ${limit}`;
  const dispatch = (command: Parameters<typeof threads.dispatch>[0]) =>
    threads.dispatch(command).pipe(Effect.map(({ sequence }) => ({ sequence })));
  return Effect.fn("SessionQueue.execute")(function* (input: SessionQueueInput) {
    if (input.action === "list") {
      const limit = input.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20)
        return yield* fail("invalid_arguments", "Queue limit is invalid");
      const anchor =
        input.cursor === undefined
          ? null
          : yield* Effect.try({
              try: () =>
                Schema.decodeUnknownSync(cursorSchema)(
                  JSON.parse(Buffer.from(input.cursor!, "base64url").toString("utf8")),
                ),
              catch: () => fail("invalid_cursor", "Queue cursor is invalid"),
            });
      if (anchor && anchor[0] !== input.threadId)
        return yield* fail("invalid_cursor", "Queue cursor belongs to another execution");
      const page = yield* rows(input.threadId, undefined, 250, limit + 1, anchor);
      const items = page.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map(entry),
        nextCursor:
          page.length > limit && last
            ? Buffer.from(
                JSON.stringify([
                  input.threadId,
                  last.priority,
                  last.position,
                  last.ordinal,
                  last.run_id,
                ]),
              ).toString("base64url")
            : null,
      };
    }
    if (!input.queuedId) return yield* fail("invalid_arguments", "Queued identity is required");
    const queued = (yield* rows(
      input.threadId,
      input.queuedId,
      input.action === "read" ? 6000 : 0,
      1,
    ))[0];
    if (!queued) return yield* fail("not_queued", "The message is no longer queued");
    if (input.action === "read") return entry(queued);
    if (input.action !== "remove" && queued.kind !== "message")
      return yield* fail("protected_entry", "Automatic queue entries cannot be changed or steered");
    const base = { commandId: input.commandId, threadId: input.threadId };
    switch (input.action) {
      case "edit":
        if (!input.text?.trim() || input.text.length > 120000)
          return yield* fail("invalid_arguments", "Queue text is invalid");
        return yield* dispatch({
          ...base,
          type: "queued-run.edit",
          runId: input.queuedId,
          text: input.text,
        });
      case "remove":
        return yield* dispatch({ ...base, type: "queued-run.cancel", runId: input.queuedId });
      case "reorder":
        if (input.beforeId === undefined)
          return yield* fail("invalid_arguments", "beforeId is required");
        return yield* dispatch({
          ...base,
          type: "queued-run.reorder",
          runId: input.queuedId,
          beforeRunId: input.beforeId,
        });
      case "steer": {
        const target = yield* orchestrator.getThreadShell(input.threadId);
        if (!target?.activeRunId)
          return yield* fail("unsupported", "There is no active turn to steer");
        return yield* dispatch({
          ...base,
          type: "queued-message.promote-to-steer",
          queuedRunId: input.queuedId,
          targetRunId: target.activeRunId,
        });
      }
    }
  });
});
