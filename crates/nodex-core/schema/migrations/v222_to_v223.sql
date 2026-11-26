CREATE TABLE automation_import_origins (
  automation_id TEXT PRIMARY KEY REFERENCES automations(automation_id) ON DELETE CASCADE,
  agent TEXT NOT NULL CHECK (agent IN ('codex', 'claude')),
  source_home TEXT NOT NULL CHECK (length(source_home) > 0),
  source_automation_id TEXT NOT NULL CHECK (length(source_automation_id) > 0),
  UNIQUE (agent, source_home, source_automation_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE automation_run_session_adoptions (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

-- Keep run chats that already have evidence of a person's follow-up in the chat lists.
INSERT INTO automation_run_session_adoptions (session_id)
SELECT DISTINCT run.session_id
FROM automation_execution_runs run
JOIN automations definition ON definition.automation_id = run.automation_id
JOIN project_session_user_message_receipts receipt ON receipt.session_id = run.session_id
WHERE definition.kind = 'cron' AND definition.trigger_kind = 'clock'
  AND NOT EXISTS (
    SELECT 1 FROM automation_execution_runs sent
    WHERE sent.session_id = run.session_id AND sent.message_id = receipt.message_id
  );
