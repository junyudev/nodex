import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const identity = Schema.NonEmptyString.check(Schema.isMaxLength(512));
export const SessionControlReceiptInput = Schema.Struct({
  sessionId: identity,
  operationId: identity,
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  expiresAt: Schema.Number,
  resultJson: Schema.optional(Schema.String.check(Schema.isMaxLength(32768))),
});
export type SessionControlReceiptInput = typeof SessionControlReceiptInput.Type;
export interface SessionControlReceipt {
  readonly admitted: boolean;
  readonly resultJson: string | null;
}
export class SessionControlReceiptError extends Schema.TaggedError<SessionControlReceiptError>()(
  "SessionControlReceiptError",
  { message: Schema.String },
) {}

/** A durable reservation fences uncertain native controls as well as accepted mutations. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return Effect.fn("SessionControlReceipts.apply")(function* (input: SessionControlReceiptInput) {
    const now = yield* Clock.currentTimeMillis;
    if (input.expiresAt <= now)
      return yield* new SessionControlReceiptError({ message: "Session operation expired" });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM orchestration_v2_session_control_receipts WHERE operation_id IN (SELECT operation_id FROM orchestration_v2_session_control_receipts WHERE expires_at < ${now} LIMIT 100)`;
        const inserted =
          input.resultJson === undefined
            ? yield* sql`INSERT INTO orchestration_v2_session_control_receipts (operation_id,session_id,fingerprint,result_json,expires_at) VALUES (${input.operationId},${input.sessionId},${input.fingerprint},NULL,${input.expiresAt}) ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`
            : [];
        const row = (yield* sql<{
          readonly session_id: string;
          readonly fingerprint: string;
          readonly result_json: string | null;
        }>`SELECT session_id,fingerprint,result_json FROM orchestration_v2_session_control_receipts WHERE operation_id=${input.operationId}`)[0];
        if (!row || row.session_id !== input.sessionId || row.fingerprint !== input.fingerprint)
          return yield* new SessionControlReceiptError({
            message: "Session operation belongs to different arguments",
          });
        if (input.resultJson === undefined)
          return { admitted: inserted.length > 0, resultJson: row.result_json };
        if (row.result_json !== null && row.result_json !== input.resultJson)
          return yield* new SessionControlReceiptError({
            message: "Session operation already has a different result",
          });
        yield* sql`UPDATE orchestration_v2_session_control_receipts SET result_json=${input.resultJson} WHERE operation_id=${input.operationId}`;
        return { admitted: false, resultJson: input.resultJson };
      }),
    );
  });
});
