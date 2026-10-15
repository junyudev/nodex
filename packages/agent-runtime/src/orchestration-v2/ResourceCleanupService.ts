import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

import { ResourceCleanupError, ResourceCleanupService } from "./ResourceCleanup.ts";
export { ResourceCleanupError, ResourceCleanupService } from "./ResourceCleanup.ts";

const REFERENCE_BATCH_SIZE = 200;

/**
 * Attachment ids that a live Thread still shows: its own message or published item, or a fork
 * whose captured source prefix contains the referencing Run. Deleted Threads keep their rows for
 * fork ancestry, so liveness is decided here rather than by row existence.
 */
export const liveAttachmentReferences = Effect.fn("ResourceCleanup.liveAttachmentReferences")(
  function* (attachmentIds: ReadonlyArray<string>) {
    const sql = yield* SqlClient.SqlClient;
    const live = new Set<string>();
    const unique = [...new Set(attachmentIds)];
    for (let offset = 0; offset < unique.length; offset += REFERENCE_BATCH_SIZE) {
      const batch = unique.slice(offset, offset + REFERENCE_BATCH_SIZE);
      const rows = yield* sql<{ readonly attachment_id: string }>`
        WITH RECURSIVE holders(attachment_id, thread_id, visible_from) AS (
          SELECT ref.attachment_id, ref.thread_id, COALESCE(run.ordinal, -1)
          FROM orchestration_v2_projection_attachment_refs AS ref
          LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = ref.run_id
          WHERE ref.attachment_id IN ${sql.in(batch)}
          UNION
          SELECT holders.attachment_id, fork.thread_id, -1
          FROM holders
          INNER JOIN orchestration_v2_projection_threads AS fork
            ON json_extract(fork.payload_json, '$.forkedFrom.threadId') = holders.thread_id
          WHERE json_extract(fork.payload_json, '$.forkedFrom.type') = 'run'
            AND COALESCE((
              SELECT ordinal FROM orchestration_v2_projection_runs
              WHERE run_id = json_extract(fork.payload_json, '$.forkedFrom.runId')), -1)
              >= holders.visible_from
        )
        SELECT DISTINCT holders.attachment_id
        FROM holders
        INNER JOIN orchestration_v2_projection_threads AS thread
          ON thread.thread_id = holders.thread_id
        WHERE thread.deleted_at IS NULL
      `;
      for (const row of rows) live.add(row.attachment_id);
    }
    return live;
  },
);

/**
 * Nodex cleanup. Terminals and previews are host capabilities outside the execution runtime, so
 * their per-Thread cleanup has nothing to release here. Attachment files are shared by forks and
 * reused message references; a file is removed only when no live Thread still shows it.
 */
export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    return {
      cleanupTerminals: () => Effect.void,
      cleanupPreviews: () => Effect.void,
      cleanupAttachments: (attachmentIds: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const live = yield* liveAttachmentReferences(attachmentIds).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "attachment", cause }),
            ),
          );
          yield* Effect.forEach(
            attachmentIds.filter((attachmentId) => !live.has(attachmentId)),
            (attachmentId) => {
              const path = resolveAttachmentPathById({
                attachmentsDir: config.attachmentsDir,
                attachmentId,
              });
              return path === null
                ? Effect.void
                : fileSystem.remove(path, { force: true }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ResourceCleanupError({
                          operation: "attachment",
                          attachmentId,
                          cause,
                        }),
                    ),
                  );
            },
            { discard: true, concurrency: 4 },
          );
        }),
    };
  }),
);
