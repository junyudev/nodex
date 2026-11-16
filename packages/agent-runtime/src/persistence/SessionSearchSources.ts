import type * as SqlClient from "effect/sql/SqlClient";

type Sql = SqlClient.SqlClient;

/** Runtime-eligible roots. Core can further scope them to admitted Sessions. */
export const searchableThread = (sql: Sql, alias: string) => {
  const field = (name: string) => sql.literal(`${alias}.${name}`);
  return sql`${field("deleted_at")} IS NULL AND json_extract(${field("payload_json")},'$.sideChat') IS NULL
    AND COALESCE(json_extract(${field("payload_json")},'$.lineage.relationshipToParent'),'') <> 'subagent'`;
};

export const searchableRun = (sql: Sql) => sql`run.status IS NOT 'rolled_back'`;
export const searchableMessageItem = (sql: Sql) =>
  sql`NOT (item.type='user_message' AND run.status IS 'cancelled'
    AND json_extract(item.payload_json,'$.inputIntent') IS 'queued_turn')`;

/** Search commands up to 4,096 Unicode characters. Output and diffs are outside the corpus. */
export const actionSearchText = (sql: Sql, alias: string) => {
  const payload = sql.literal(`${alias}.payload_json`);
  return sql`CASE WHEN json_valid(${payload}) THEN CASE ${sql.literal(`${alias}.type`)}
    WHEN 'command_execution' THEN CASE WHEN json_type(${payload},'$.input')='text'
      THEN substr(json_extract(${payload},'$.input'),1,4096) END
    WHEN 'file_change' THEN COALESCE(
      (SELECT group_concat(paths.path,char(10)) FROM (
        SELECT json_extract(value,'$.path') AS path FROM json_each(${payload},'$.changes') WHERE type='object'
        UNION ALL
        SELECT json_extract(value,'$.oldPath') AS path FROM json_each(${payload},'$.changes') WHERE type='object'
      ) paths),json_extract(${payload},'$.fileName'))
    END END`;
};

export const actionSearchSource = (sql: Sql) => sql`(
  SELECT rowid AS row_id,thread_id,turn_item_id,run_id,type,updated_at,
    ${actionSearchText(sql, "item")} AS text
  FROM orchestration_v2_projection_turn_items item
  WHERE type IN ('command_execution','file_change') AND status='completed'
)`;

/** Most folded items stay inline as text. Large items may use the Store's zstd codec. */
export const readSearchSegments = (sql: Sql, alias: string) => {
  const segments = sql.literal(`${alias}.segments`);
  return sql`CASE typeof(${segments}) WHEN 'blob' THEN zstd_text(${segments}) ELSE ${segments} END`;
};
