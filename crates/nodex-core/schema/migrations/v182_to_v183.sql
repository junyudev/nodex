ALTER TABLE inbox_entries ADD COLUMN scope_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE CHECK (scope_project_id IS NULL OR length(scope_project_id) BETWEEN 1 AND 512);
CREATE INDEX idx_inbox_entries_scope ON inbox_entries(library_id, scope_project_id, seq);
-- Leaving the Inbox Database used to handle a message implicitly. The decision is now
-- explicit, so a message already filed elsewhere stays handled.
UPDATE inbox_entries SET state = 'kept', revision = revision + 1
WHERE state = 'open' AND NOT EXISTS (
  SELECT 1 FROM pages page
  JOIN inbox_registry home ON home.library_id = inbox_entries.library_id
  WHERE page.block_id = inbox_entries.page_id AND page.parent_kind = 'data_source'
    AND page.parent_id = home.data_source_id
);
