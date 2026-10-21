-- The user can mark an Inbox message important, so it stays in view while it waits.
ALTER TABLE inbox_entries ADD COLUMN important INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1));
