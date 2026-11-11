ALTER TABLE automation_execution_runs ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0 CHECK (quiet IN (0, 1) AND (quiet = 0 OR (read_at IS NOT NULL AND status <> 'IN_PROGRESS')));
