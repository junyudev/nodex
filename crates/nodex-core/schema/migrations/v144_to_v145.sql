CREATE TABLE retired_data_source_property_ids (
  data_source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  retired_at TEXT NOT NULL,
  PRIMARY KEY (data_source_id, property_id),
  CHECK (length(property_id) BETWEEN 1 AND 128),
  CHECK (length(retired_at) > 0)
) WITHOUT ROWID, STRICT;

PRAGMA user_version = 145;
