import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as SqlClient from "effect/sql/SqlClient";

const identity = Schema.NonEmptyString.check(Schema.isMaxLength(512));
export const NativeMessageResult = Schema.Struct({
  messageId: identity,
  runId: Schema.NullOr(identity),
  status: Schema.String,
  delivery: Schema.Literals([
    "started",
    "steered",
    "queued",
    "restarted",
    "replayed",
    "unconfirmed",
  ]),
});
export type NativeMessageResult = typeof NativeMessageResult.Type;
const command = {
  messageId: identity,
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
};
export const NativeMessageLookup = Schema.Struct({ ...command, sessionId: identity });
export type NativeMessageLookup = typeof NativeMessageLookup.Type;
export const NativeMessageReserve = Schema.Struct({
  ...command,
  sessionId: identity,
  hostId: identity,
  threadId: identity,
  attemptId: identity,
  expiresAt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export const NativeMessageSettle = Schema.Struct({
  ...command,
  sessionId: identity,
  attemptId: identity,
  phase: Schema.Literals(["confirmed", "unconfirmed", "rejected"]),
  result: Schema.optional(NativeMessageResult),
});
export type NativeMessageReserve = typeof NativeMessageReserve.Type;
export type NativeMessageSettle = typeof NativeMessageSettle.Type;
export interface NativeMessageReceipt {
  readonly admitted: boolean;
  readonly sessionId: string;
  readonly hostId: string;
  readonly threadId: string;
  readonly phase: "pending" | "confirmed" | "unconfirmed" | "rejected";
  readonly attemptId: string;
  readonly result: NativeMessageResult | null;
}
export class NativeMessageReceiptError extends Schema.TaggedError<NativeMessageReceiptError>()(
  "NativeMessageReceiptError",
  {
    message: Schema.String,
  },
) {}
interface Row {
  readonly session_id: string;
  readonly host_id: string;
  readonly thread_id: string;
  readonly fingerprint: string;
  readonly attempt_id: string;
  readonly phase: NativeMessageReceipt["phase"];
  readonly result_json: string | null;
  readonly expires_at: number;
}
const resultCodec = Schema.decodeUnknownSync(NativeMessageResult);
const project = (row: Row, admitted = false): NativeMessageReceipt => ({
  admitted,
  sessionId: row.session_id,
  hostId: row.host_id,
  threadId: row.thread_id,
  phase: row.phase,
  attemptId: row.attempt_id,
  result: row.result_json === null ? null : resultCodec(JSON.parse(row.result_json)),
});

/** Native delivery remains producer-owned; Runtime persists admission before any host write. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = (messageId: string) =>
    sql<Row>`SELECT session_id,host_id,thread_id,fingerprint,attempt_id,phase,result_json,expires_at FROM orchestration_v2_native_message_receipts WHERE message_id=${messageId}`;
  const lookup = Effect.fn("NativeMessageReceipts.lookup")(function* (input: NativeMessageLookup) {
    const row = (yield* read(input.messageId))[0];
    if (!row || row.expires_at <= (yield* Clock.currentTimeMillis)) return null;
    if (row.session_id !== input.sessionId || row.fingerprint !== input.fingerprint)
      return yield* new NativeMessageReceiptError({
        message: "Native message identity belongs to different arguments",
      });
    return row.phase === "rejected" ? null : project(row);
  });
  const reserve = Effect.fn("NativeMessageReceipts.reserve")(function* (
    input: NativeMessageReserve,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (input.expiresAt <= now)
      return yield* new NativeMessageReceiptError({ message: "Native message operation expired" });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM orchestration_v2_native_message_receipts WHERE message_id IN
          (SELECT message_id FROM orchestration_v2_native_message_receipts WHERE expires_at < ${now} ORDER BY expires_at LIMIT 100)`;
        const inserted = yield* sql`INSERT INTO orchestration_v2_native_message_receipts
        (message_id,session_id,host_id,thread_id,fingerprint,attempt_id,phase,result_json,expires_at,updated_at)
        VALUES(${input.messageId},${input.sessionId},${input.hostId},${input.threadId},${input.fingerprint},${input.attemptId},'pending',NULL,${input.expiresAt},${now})
        ON CONFLICT(message_id) DO NOTHING RETURNING message_id`;
        const row = (yield* read(input.messageId))[0];
        if (!row || row.fingerprint !== input.fingerprint || row.session_id !== input.sessionId)
          return yield* new NativeMessageReceiptError({
            message: "Native message identity belongs to different arguments",
          });
        if (inserted.length > 0) return project(row, true);
        if (row.phase !== "rejected") return project(row);
        // A proved pre-dispatch refusal may use the Session's newly authorized binding.
        yield* sql`UPDATE orchestration_v2_native_message_receipts SET host_id=${input.hostId},thread_id=${input.threadId},attempt_id=${input.attemptId},phase='pending',updated_at=${now}
        WHERE message_id=${input.messageId} AND phase='rejected'`;
        return project((yield* read(input.messageId))[0]!, true);
      }),
    );
  });
  const settle = Effect.fn("NativeMessageReceipts.settle")(function* (input: NativeMessageSettle) {
    if (
      (input.phase === "confirmed") !== Boolean(input.result) ||
      input.result?.delivery === "unconfirmed"
    )
      return yield* new NativeMessageReceiptError({
        message: "Confirmed Native delivery requires its exact result",
      });
    const now = yield* Clock.currentTimeMillis;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = (yield* read(input.messageId))[0];
        if (
          !row ||
          row.session_id !== input.sessionId ||
          row.fingerprint !== input.fingerprint ||
          row.attempt_id !== input.attemptId
        )
          return yield* new NativeMessageReceiptError({
            message: "Native delivery attempt no longer owns this receipt",
          });
        if (row.phase === "confirmed") return project(row);
        if (row.phase === "rejected" && input.phase === "rejected") return project(row);
        if (row.phase === "rejected" || (row.phase === "unconfirmed" && input.phase === "rejected"))
          return yield* new NativeMessageReceiptError({
            message: "An uncertain Native delivery cannot be released for resend",
          });
        if (input.result && input.result.messageId !== input.messageId)
          return yield* new NativeMessageReceiptError({
            message: "Native delivery confirmed another message",
          });
        yield* sql`UPDATE orchestration_v2_native_message_receipts SET phase=${input.phase},result_json=${input.result ? JSON.stringify(input.result) : null},updated_at=${now} WHERE message_id=${input.messageId}`;
        return project((yield* read(input.messageId))[0]!);
      }),
    );
  });
  return {
    lookup: (input: NativeMessageLookup) =>
      lookup(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    reserve: (input: NativeMessageReserve) =>
      reserve(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    settle: (input: NativeMessageSettle) =>
      settle(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  };
});
