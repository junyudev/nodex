import {
  ChatAttachment,
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationMessageContext,
  OrchestrationV2RunStatus,
  ProviderInteractionMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { readOnly } from "@t3tools/shared/nodeSqliteClient";
import {
  importChatAttachments,
  ImportChatAttachmentsInput,
} from "../assets/ImportChatAttachments.ts";

export const RuntimeMessageIdentity = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export type RuntimeMessageIdentity = typeof RuntimeMessageIdentity.Type;
export const RuntimeMessageAdmission = Schema.Struct({
  ...RuntimeMessageIdentity.fields,
  mode: Schema.Literals(["auto", "queue", "steer", "restart"]),
});
export type RuntimeMessageAdmission = typeof RuntimeMessageAdmission.Type;
export const RuntimeMessageLaunch = Schema.Struct({
  ...RuntimeMessageIdentity.fields,
  launchId: Schema.String,
  sessionId: Schema.String,
  acceptedAt: Schema.Number,
  title: Schema.String,
  modelSelection: ModelSelection,
  interactionMode: ProviderInteractionMode,
  message: Schema.Struct({
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    context: Schema.optional(OrchestrationMessageContext),
    modelSelection: Schema.optional(ModelSelection),
    interactionMode: Schema.optional(ProviderInteractionMode),
  }),
});
export type RuntimeMessageLaunch = typeof RuntimeMessageLaunch.Type;
export const RuntimeMessageLaunchStage = Schema.Struct({
  ...RuntimeMessageLaunch.fields,
  resources: ImportChatAttachmentsInput.fields.attachments,
});
export type RuntimeMessageLaunchStage = typeof RuntimeMessageLaunchStage.Type;
export class RuntimeMessageReceiptError extends Schema.TaggedError<RuntimeMessageReceiptError>()(
  "RuntimeMessageReceiptError",
  { message: Schema.String },
) {}

const result = Schema.Struct({
  messageId: MessageId,
  runId: Schema.String,
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  taskId: Schema.optional(Schema.String),
});
interface IdentityRow {
  readonly thread_id: string;
  readonly command_id: string;
  readonly fingerprint: string;
  readonly mode: RuntimeMessageAdmission["mode"];
  readonly launch_json: string | null;
}

/** Binds immutable intake arguments; delivery and Run state remain canonical orchestration facts. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = Effect.fn("RuntimeMessageReceipts.identity")(function* (
    input: RuntimeMessageIdentity,
  ) {
    const row = (yield* sql<IdentityRow>`SELECT thread_id,command_id,fingerprint,mode,launch_json
      FROM orchestration_v2_message_admissions WHERE message_id=${input.messageId}`)[0];
    if (
      row &&
      (row.thread_id !== input.threadId ||
        row.command_id !== input.commandId ||
        row.fingerprint !== input.fingerprint)
    )
      return yield* new RuntimeMessageReceiptError({
        message: "Message operation identity belongs to different arguments",
      });
    return row ?? null;
  });
  const admit = Effect.fn("RuntimeMessageReceipts.admit")(function* (
    input: RuntimeMessageAdmission,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO orchestration_v2_message_admissions
        (message_id,thread_id,command_id,fingerprint,mode)
        VALUES(${input.messageId},${input.threadId},${input.commandId},${input.fingerprint},${input.mode})
        ON CONFLICT(message_id) DO NOTHING`;
        yield* identity(input);
      }),
    );
    return { admitted: true };
  });
  const replay = Effect.fn("RuntimeMessageReceipts.replay")(function* (
    input: RuntimeMessageIdentity,
  ) {
    const admitted = yield* identity(input);
    if (!admitted) return null;
    const receipt = (yield* sql<{
      readonly aggregate_kind: string;
      readonly aggregate_id: string;
      readonly command_type: string;
      readonly status: string;
      readonly error: string | null;
    }>`SELECT aggregate_kind,aggregate_id,command_type,status,error FROM orchestration_command_receipts
      WHERE command_id=${input.commandId}`)[0];
    if (!receipt) return null;
    if (
      receipt.aggregate_kind !== "thread" ||
      receipt.aggregate_id !== input.threadId ||
      receipt.command_type !== "message.dispatch"
    )
      return yield* new RuntimeMessageReceiptError({
        message: "Message receipt belongs to another command",
      });
    if (receipt.status !== "accepted")
      return yield* new RuntimeMessageReceiptError({
        message: receipt.error ?? "Message operation was rejected",
      });
    // Read compact facts from the original immutable command, not current attachment/config state
    // or a later message edit. SQLite extracts these fields without hydrating message bodies.
    const message = (yield* sql<{ readonly run_id: string | null }>`
      SELECT json_extract(payload_json,'$.runId') AS run_id FROM orchestration_events
      WHERE command_id=${input.commandId} AND aggregate_kind='thread' AND stream_id=${input.threadId}
        AND event_type='message.updated' AND json_extract(payload_json,'$.id')=${input.messageId}
      ORDER BY sequence ASC LIMIT 1`)[0];
    if (!message?.run_id)
      return yield* new RuntimeMessageReceiptError({
        message: "Accepted message has no durable Run",
      });
    const run = (yield* sql<{ readonly status: string; readonly task_id: string | null }>`
      SELECT status,json_extract(payload_json,'$.delegatedTaskId') AS task_id
      FROM orchestration_v2_projection_runs WHERE thread_id=${input.threadId} AND run_id=${message.run_id}`)[0];
    if (!run)
      return yield* new RuntimeMessageReceiptError({
        message: "Accepted message Run is unavailable",
      });
    const item = (yield* sql<{ readonly intent: string | null }>`
      SELECT json_extract(payload_json,'$.inputIntent') AS intent FROM orchestration_events
      WHERE command_id=${input.commandId} AND aggregate_kind='thread' AND stream_id=${input.threadId}
        AND event_type='turn-item.updated' AND json_extract(payload_json,'$.type')='user_message'
        AND json_extract(payload_json,'$.messageId')=${input.messageId}
      ORDER BY sequence DESC LIMIT 1`)[0];
    const delivery =
      !item || item.intent === "queued_turn"
        ? "queued"
        : item.intent === "turn_start"
          ? "started"
          : admitted.mode === "restart"
            ? "restarted"
            : "steered";
    return yield* Schema.decodeUnknownEffect(result)({
      messageId: input.messageId,
      runId: message.run_id,
      status: run.status,
      delivery,
      ...(run.task_id ? { taskId: run.task_id } : {}),
    });
  });
  const launch = Effect.fn("RuntimeMessageReceipts.launch")(function* (
    input: RuntimeMessageIdentity,
  ) {
    const row = yield* identity(input);
    return row?.launch_json
      ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeMessageLaunch))(
          row.launch_json,
        )
      : null;
  });
  const stage = Effect.fn("RuntimeMessageReceipts.stage")(function* (
    input: RuntimeMessageLaunchStage,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* launch(input);
        if (existing) return existing;
        if (input.message.messageId !== input.messageId)
          return yield* new RuntimeMessageReceiptError({
            message: "Launch message identity does not match its admission",
          });
        const attachments = yield* importChatAttachments({
          threadId: input.threadId,
          messageId: input.messageId,
          attachments: input.resources,
        });
        const staged = yield* Schema.decodeUnknownEffect(RuntimeMessageLaunch)({
          ...input,
          message: {
            ...input.message,
            attachments: [...input.message.attachments, ...attachments],
          },
        });
        yield* admit({ ...input, mode: "auto" });
        const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(RuntimeMessageLaunch))(
          staged,
        );
        yield* sql`UPDATE orchestration_v2_message_admissions SET launch_json=${JSON.stringify(encoded)} WHERE message_id=${input.messageId}
        AND NOT EXISTS(SELECT 1 FROM orchestration_command_receipts WHERE command_id=${input.commandId} AND status='accepted')`;
        return staged;
      }),
    );
  });
  return {
    admit: (input: RuntimeMessageAdmission) =>
      admit(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    replay: (input: RuntimeMessageIdentity) =>
      readOnly(sql.withTransaction(replay(input))).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    launch: (input: RuntimeMessageIdentity) =>
      readOnly(sql.withTransaction(launch(input))).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    stage: (input: RuntimeMessageLaunchStage) =>
      stage(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  };
});
