/**
 * OrchestrationCommandReceiptRepository - Repository interface for command receipts.
 *
 * Owns persistence operations for deduplication and status tracking of
 * orchestration command handling.
 *
 * @module OrchestrationCommandReceiptRepository
 */
import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  toPersistenceSqlError,
  type OrchestrationCommandReceiptRepositoryError,
} from "./Errors.ts";

export const OrchestrationCommandReceipt = Schema.Struct({
  commandId: CommandId,
  aggregateKind: Schema.Literals(["project", "thread"]),
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  commandType: Schema.String,
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: Schema.Literals(["accepted", "rejected"]),
  error: Schema.NullOr(Schema.String),
  requestFingerprint: Schema.optional(Schema.String),
  messageId: Schema.optional(MessageId),
  messageFingerprint: Schema.optional(Schema.String),
});
export type OrchestrationCommandReceipt = typeof OrchestrationCommandReceipt.Type;

export const GetByCommandIdInput = Schema.Struct({
  commandId: CommandId,
});
export type GetByCommandIdInput = typeof GetByCommandIdInput.Type;

const GetByMessageIdInput = Schema.Struct({ messageId: MessageId });

function omitMissingIdentityFields(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([key, value]) =>
        value !== null || !["requestFingerprint", "messageId", "messageFingerprint"].includes(key),
    ),
  );
}

/**
 * OrchestrationCommandReceiptRepository - Service tag for command receipt persistence.
 */
export class OrchestrationCommandReceiptRepository extends Context.Service<
  OrchestrationCommandReceiptRepository,
  {
    readonly insertIfAbsent: (
      receipt: OrchestrationCommandReceipt,
    ) => Effect.Effect<boolean, OrchestrationCommandReceiptRepositoryError>;

    /**
     * Insert or replace a command receipt row.
     *
     * Upserts by `commandId` for idempotent command-result tracking.
     */
    readonly upsert: (
      receipt: OrchestrationCommandReceipt,
    ) => Effect.Effect<void, OrchestrationCommandReceiptRepositoryError>;

    /**
     * Read a command receipt by command id.
     */
    readonly getByCommandId: (
      input: GetByCommandIdInput,
    ) => Effect.Effect<
      Option.Option<OrchestrationCommandReceipt>,
      OrchestrationCommandReceiptRepositoryError
    >;
    readonly getByMessageId: (
      input: typeof GetByMessageIdInput.Type,
    ) => Effect.Effect<
      Option.Option<OrchestrationCommandReceipt>,
      OrchestrationCommandReceiptRepositoryError
    >;
  }
>()("t3/persistence/OrchestrationCommandReceipts/OrchestrationCommandReceiptRepository") {}

const makeOrchestrationCommandReceiptRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertReceiptRow = SqlSchema.void({
    Request: OrchestrationCommandReceipt,
    execute: (receipt) =>
      sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          command_type,
          accepted_at,
          result_sequence,
          status,
          error,
          request_fingerprint,
          message_id,
          message_fingerprint
        )
        VALUES (
          ${receipt.commandId},
          ${receipt.aggregateKind},
          ${receipt.aggregateId},
          ${receipt.commandType},
          ${receipt.acceptedAt},
          ${receipt.resultSequence},
          ${receipt.status},
          ${receipt.error},
          ${receipt.requestFingerprint ?? null},
          ${receipt.messageId ?? null},
          ${receipt.messageFingerprint ?? null}
        )
        ON CONFLICT (command_id)
        DO UPDATE SET
          aggregate_kind = excluded.aggregate_kind,
            aggregate_id = excluded.aggregate_id,
            command_type = excluded.command_type,
          accepted_at = excluded.accepted_at,
          result_sequence = excluded.result_sequence,
          status = excluded.status,
          error = excluded.error,
          request_fingerprint = excluded.request_fingerprint,
          message_id = excluded.message_id,
          message_fingerprint = excluded.message_fingerprint
      `,
  });

  const findReceiptByCommandId = SqlSchema.findOneOption({
    Request: GetByCommandIdInput,
    Result: OrchestrationCommandReceipt,
    execute: ({ commandId }) =>
      sql`
        SELECT
          command_id AS "commandId",
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          command_type AS "commandType",
          accepted_at AS "acceptedAt",
          result_sequence AS "resultSequence",
          status,
          error,
          request_fingerprint AS "requestFingerprint",
          message_id AS "messageId",
          message_fingerprint AS "messageFingerprint"
        FROM orchestration_command_receipts
        WHERE command_id = ${commandId}
      `.pipe(Effect.map((rows) => rows.map(omitMissingIdentityFields))),
  });

  const findReceiptByMessageId = SqlSchema.findOneOption({
    Request: GetByMessageIdInput,
    Result: OrchestrationCommandReceipt,
    execute: ({ messageId }) =>
      sql`
      SELECT command_id AS "commandId", aggregate_kind AS "aggregateKind",
        aggregate_id AS "aggregateId", command_type AS "commandType", accepted_at AS "acceptedAt",
        result_sequence AS "resultSequence", status, error,
        request_fingerprint AS "requestFingerprint", message_id AS "messageId",
        message_fingerprint AS "messageFingerprint"
      FROM orchestration_command_receipts WHERE message_id = ${messageId}
    `.pipe(Effect.map((rows) => rows.map(omitMissingIdentityFields))),
  });

  const upsert: OrchestrationCommandReceiptRepository["Service"]["upsert"] = (receipt) =>
    upsertReceiptRow(receipt).pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationCommandReceiptRepository.upsert:query")),
    );

  const insertIfAbsent: OrchestrationCommandReceiptRepository["Service"]["insertIfAbsent"] = (
    receipt,
  ) =>
    sql<{ readonly command_id: string }>`
      INSERT INTO orchestration_command_receipts (
        command_id,
        aggregate_kind,
        aggregate_id,
        command_type,
        accepted_at,
        result_sequence,
        status,
        error,
        request_fingerprint,
        message_id,
        message_fingerprint
      )
      VALUES (
        ${receipt.commandId},
        ${receipt.aggregateKind},
        ${receipt.aggregateId},
        ${receipt.commandType},
        ${receipt.acceptedAt},
        ${receipt.resultSequence},
        ${receipt.status},
        ${receipt.error},
        ${receipt.requestFingerprint ?? null},
        ${receipt.messageId ?? null},
        ${receipt.messageFingerprint ?? null}
      )
      ON CONFLICT(command_id) DO NOTHING
      RETURNING command_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.insertIfAbsent:query"),
      ),
    );

  const getByCommandId: OrchestrationCommandReceiptRepository["Service"]["getByCommandId"] = (
    input,
  ) =>
    findReceiptByCommandId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.getByCommandId:query"),
      ),
    );

  return {
    insertIfAbsent,
    upsert,
    getByCommandId,
    getByMessageId: (input) =>
      findReceiptByMessageId(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("OrchestrationCommandReceiptRepository.getByMessageId:query"),
        ),
      ),
  } satisfies OrchestrationCommandReceiptRepository["Service"];
});

export const layer = Layer.effect(
  OrchestrationCommandReceiptRepository,
  makeOrchestrationCommandReceiptRepository,
);
