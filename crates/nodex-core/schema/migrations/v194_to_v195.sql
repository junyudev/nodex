CREATE TABLE app_tool_operations (
  caller_identity TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (caller_identity, tool_name, idempotency_key)
) STRICT;
CREATE INDEX idx_app_tool_operations_expiry ON app_tool_operations(expires_at_ms);
