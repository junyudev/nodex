-- Historical entries have no evidence of their attaching actor or time.
ALTER TABLE page_file_entries ADD COLUMN attached_by_json TEXT NOT NULL DEFAULT '{"kind":"unknown"}'
  CHECK (json_valid(attached_by_json) AND COALESCE(json_extract(attached_by_json, '$.kind') IN ('person', 'agent', 'external', 'unknown'), 0));
ALTER TABLE page_file_entries ADD COLUMN attached_at TEXT CHECK (
  (json_extract(attached_by_json, '$.kind') = 'unknown' AND attached_at IS NULL) OR
  (json_extract(attached_by_json, '$.kind') <> 'unknown' AND attached_at IS NOT NULL AND length(attached_at) > 0)
);
