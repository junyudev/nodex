CREATE TABLE automations (
  id TEXT PRIMARY KEY, name TEXT, prompt TEXT, status TEXT, rrule TEXT, cwds TEXT,
  updated_at INTEGER, kind TEXT, target_thread_id TEXT, model TEXT, reasoning_effort TEXT,
  execution_environment TEXT, local_environment_config_path TEXT, notification_policy TEXT,
  account_id TEXT, user_id TEXT, installation_id TEXT, legacy_automation_id TEXT, remote_host TEXT
);
CREATE TABLE automation_runs (
  thread_id TEXT PRIMARY KEY, automation_id TEXT, status TEXT, thread_title TEXT,
  source_cwd TEXT, created_at INTEGER, updated_at INTEGER
);
INSERT INTO automations VALUES
  ('daily', 'Database task', 'Check the latest builds.', 'ACTIVE', 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
   '["/work/project"]', 9, 'cron', NULL, 'test-model', 'high', 'worktree', '/work/environment.toml',
   'failed_runs_only', 'account', 'user', 'installation', 'daily-old', NULL),
  ('beat', 'Heartbeat', 'Follow up.', 'PAUSED', 'FREQ=MINUTELY;INTERVAL=30', '[]', 8, 'heartbeat',
   'native-target', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('deleted', 'Deleted', 'Deleted', 'DELETED', 'FREQ=DAILY', '[]', 7, 'cron',
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('other', 'Other account', 'Check another build.', 'ACTIVE', 'FREQ=DAILY', '[]', 6, 'cron',
   NULL, NULL, NULL, NULL, NULL, NULL, 'other-account', 'user', 'installation', NULL, NULL),
  ('remote', 'Remote task', 'Check a remote build.', 'ACTIVE', 'FREQ=DAILY', '[]', 6, 'cron',
   NULL, NULL, NULL, NULL, NULL, NULL, 'account', 'user', 'installation', NULL, 'remote-host');
INSERT INTO automation_runs VALUES
  ('run-earlier', 'daily', 'ARCHIVED', 'Earlier', '/work/project', 1, 15),
  ('run-newest', 'daily', 'PENDING_REVIEW', 'Newest', '/work/project', 2, 12),
  ('pending:daily', 'daily', 'IN_PROGRESS', NULL, NULL, 3, 13),
  ('legacy-run', 'legacy-only', 'PENDING_REVIEW', 'Legacy', NULL, 4, 14),
  ('wrong-beat-run', 'beat', 'PENDING_REVIEW', 'Not a heartbeat run', NULL, 5, 15);
