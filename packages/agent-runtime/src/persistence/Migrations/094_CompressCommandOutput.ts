import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  boundStoredCommandOutput,
  compressCommandOutput,
} from "../../orchestration-v2/commandOutputStorage.ts";

const OUTPUT_PAGE_SIZE = 200;

/** Moves command output out of the JSON that SQL reads and into a compressed column. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN output_zstd BLOB`;
  yield* sql`ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN output_bytes INTEGER NOT NULL DEFAULT 0`;

  let after = 0;
  for (;;) {
    const rows = yield* sql<{ readonly row_id: number; readonly output: string }>`
      SELECT rowid AS row_id, json_extract(payload_json, '$.output') AS output
      FROM orchestration_v2_projection_turn_items
      WHERE rowid > ${after}
        AND type = 'command_execution'
        -- One unreadable row is reported where it is read; it must not stop every later start.
        AND CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.output') END = 'text'
      ORDER BY rowid ASC
      LIMIT ${OUTPUT_PAGE_SIZE}`;
    for (const row of rows) {
      const output = compressCommandOutput(boundStoredCommandOutput(row.output));
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET output_zstd = ${output.zstd}, output_bytes = ${output.bytes},
          payload_json = json_remove(payload_json, '$.output')
        WHERE rowid = ${row.row_id}`;
    }
    if (rows.length < OUTPUT_PAGE_SIZE) break;
    after = rows.at(-1)?.row_id ?? after;
    yield* Effect.yieldNow;
  }
});
