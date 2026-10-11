CREATE TABLE block_erasure_requests (
  root_block_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  requested_at TEXT NOT NULL,
  CHECK (length(root_block_id) BETWEEN 1 AND 512),
  CHECK (length(requested_at) > 0)
) WITHOUT ROWID, STRICT;
