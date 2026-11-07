import { createHash } from "node:crypto";
import { OrchestratorMcpFailure } from "@nodex/runtime-contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const windowMs = 7 * 24 * 60 * 60 * 1_000;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  return Effect.fn("McpToolOperation.admit")(function* (
    scope: McpInvocationScope,
    tool: string,
    key: string,
    args: Record<string, unknown>,
  ) {
    const caller = scope.thread
      ? `thread:${scope.thread.threadId}`
      : `client:${scope.client?.sessionId}`;
    const { idempotencyKey: _key, ...payload } = args;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(payload, (_name, value) =>
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((key) => [key, value[key]]),
              )
            : value,
        ),
      )
      .digest("hex");
    const now = yield* Clock.currentTimeMillis;
    const entropy = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const operationId = `nodexop:v1:${now}:${now + windowMs}:runtime.tool:${entropy}`;
    // Execution owns its own durable receipts. Admission binds the root conversation and
    // exact arguments in that same SQL authority, independently of provider credentials,
    // Turns and process lifetime. The clock is always the host's admission clock.
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM orchestration_v2_mcp_tool_operations WHERE rowid IN
        (SELECT rowid FROM orchestration_v2_mcp_tool_operations WHERE expires_at<=${now} LIMIT 256)`;
          yield* sql`INSERT INTO orchestration_v2_mcp_tool_operations
        (caller,tool,idempotency_key,fingerprint,operation_id,expires_at)
        VALUES(${caller},${tool},${key},${fingerprint},${operationId},${now + windowMs})
        ON CONFLICT(caller,tool,idempotency_key) DO UPDATE SET
          fingerprint=excluded.fingerprint, operation_id=excluded.operation_id, expires_at=excluded.expires_at
        WHERE orchestration_v2_mcp_tool_operations.expires_at<=${now}`;
          const row = (yield* sql<{ readonly fingerprint: string; readonly operation_id: string }>`
        SELECT fingerprint,operation_id FROM orchestration_v2_mcp_tool_operations
        WHERE caller=${caller} AND tool=${tool} AND idempotency_key=${key} AND expires_at>${now}`)[0];
          if (row === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "orchestration_error",
              message:
                "Tool admission is unavailable; retry with the same idempotencyKey and identical arguments.",
            });
          if (row.fingerprint !== fingerprint)
            return yield* new OrchestratorMcpFailure({
              code: "idempotency_key_reused",
              message:
                "idempotencyKey is already bound to different arguments. Reuse it only for an identical retry.",
            });
          return row.operation_id;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message:
                "Tool admission is unavailable; retry with the same idempotencyKey and identical arguments.",
            }),
          ),
        ),
      );
  });
});
