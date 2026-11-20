PRAGMA legacy_alter_table=ON;
ALTER TABLE members RENAME TO members_v214;
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 256),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'removed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1), role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member','commenter')),
  UNIQUE (id, library_id)
) WITHOUT ROWID, STRICT;

INSERT INTO members SELECT * FROM members_v214;
DROP TABLE members_v214;
CREATE INDEX members_library ON members(library_id, lifecycle, display_name, id);
CREATE TRIGGER members_name_insert BEFORE INSERT ON members
WHEN lower(trim(NEW.display_name))='you'
BEGIN SELECT RAISE(ABORT,'A Member name cannot be You'); END;
CREATE TRIGGER members_name_update BEFORE UPDATE OF display_name ON members
WHEN lower(trim(NEW.display_name))='you'
BEGIN SELECT RAISE(ABORT,'A Member name cannot be You'); END;
CREATE TRIGGER turn_members_update AFTER UPDATE ON members

BEGIN
  INSERT INTO page_turn_dirty SELECT block_id FROM block_properties WHERE property_key='work' ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER personal_space_member_insert BEFORE INSERT ON members
WHEN (SELECT space_kind FROM libraries WHERE id=NEW.library_id)='personal'
 AND (NEW.role<>'owner' OR NEW.lifecycle<>'active' OR EXISTS(SELECT 1 FROM members WHERE library_id=NEW.library_id))
BEGIN SELECT RAISE(ABORT,'Personal Space requires one active Owner'); END;
CREATE TRIGGER personal_space_member_update BEFORE UPDATE OF role,lifecycle,library_id ON members
WHEN ((SELECT space_kind FROM libraries WHERE id=OLD.library_id)='personal'
 AND (NEW.role<>'owner' OR NEW.lifecycle<>'active' OR NEW.library_id<>OLD.library_id))
 OR ((SELECT space_kind FROM libraries WHERE id=NEW.library_id)='personal'
 AND (NEW.role<>'owner' OR NEW.lifecycle<>'active' OR EXISTS(SELECT 1 FROM members WHERE library_id=NEW.library_id AND id<>OLD.id)))
BEGIN SELECT RAISE(ABORT,'Personal Space requires one active Owner'); END;
CREATE TRIGGER personal_space_member_delete BEFORE DELETE ON members
WHEN (SELECT space_kind FROM libraries WHERE id=OLD.library_id)='personal'
BEGIN SELECT RAISE(ABORT,'Personal Space requires one active Owner'); END;
CREATE TRIGGER automations_owner_removed AFTER UPDATE OF lifecycle ON members WHEN NEW.lifecycle='removed'
BEGIN
 UPDATE automations SET status='DELETED',next_run_at=NULL,automation_revision=automation_revision+1,updated_at=MAX(updated_at,CAST(unixepoch('subsec')*1000 AS INTEGER)) WHERE owner_member_id=NEW.id AND status<>'DELETED';
 UPDATE automation_execution_leases SET status='cancelled',settled_at_ms=MAX(claimed_at_ms,CAST(unixepoch('subsec')*1000 AS INTEGER)),reason_code='automation_owner_removed' WHERE status='claimed' AND (automation_id IN(SELECT automation_id FROM automations WHERE owner_member_id=NEW.id) OR dispatch_id IN(SELECT dispatch_id FROM automation_decisions WHERE json_extract(frozen_authority_json,'$.owner_member_id')=NEW.id));
 UPDATE automation_decisions SET status='withdrawn',waiting_in_inbox=0,due_at_ms=NULL,reason='Automation Owner is unavailable',updated_at_ms=MAX(created_at_ms,CAST(unixepoch('subsec')*1000 AS INTEGER)) WHERE (status IN('held','admitted') OR waiting_in_inbox=1) AND (automation_id IN(SELECT automation_id FROM automations WHERE owner_member_id=NEW.id) OR dispatch_id IN(SELECT dispatch_id FROM automation_decisions WHERE json_extract(frozen_authority_json,'$.owner_member_id')=NEW.id));
END;
ALTER TABLE space_invites RENAME TO space_invites_v214;
CREATE TABLE space_invites (
 id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id),
 code_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('owner','member','commenter')),
 member_id TEXT REFERENCES members(id),
 expires_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), redeemed_at INTEGER
, device_link INTEGER NOT NULL DEFAULT 0 CHECK(device_link IN (0,1)), created_at INTEGER NOT NULL DEFAULT 0) STRICT;

INSERT INTO space_invites SELECT * FROM space_invites_v214;
DROP TABLE space_invites_v214;
ALTER TABLE pages ADD COLUMN nodex_answers_questions INTEGER NOT NULL DEFAULT 0 CHECK(nodex_answers_questions IN (0,1));

CREATE TABLE page_discussions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  anchor_json TEXT NOT NULL CHECK(json_valid(anchor_json)),
  creation_hash TEXT NOT NULL,
  anchor_state TEXT NOT NULL CHECK(anchor_state IN ('live','orphaned')),
  quote TEXT NOT NULL CHECK(length(quote) <= 500),
  created_by_json TEXT NOT NULL CHECK(json_valid(created_by_json)),
  created_at TEXT NOT NULL,
  resolved_by_json TEXT CHECK(json_valid(resolved_by_json)),
  resolved_at TEXT,
  last_activity_at TEXT NOT NULL,
  CHECK ((resolved_by_json IS NULL) = (resolved_at IS NULL))
) WITHOUT ROWID, STRICT;
CREATE INDEX page_discussions_page_activity ON page_discussions(page_id, last_activity_at DESC, id DESC);
CREATE INDEX page_discussions_activity ON page_discussions(last_activity_at DESC, id DESC);
CREATE TABLE page_discussion_comments (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL REFERENCES page_discussions(id) ON DELETE CASCADE,
  author_json TEXT NOT NULL CHECK(json_valid(author_json)),
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  body TEXT NOT NULL,
  mentions_json TEXT NOT NULL CHECK(json_valid(mentions_json)),
  ask_json TEXT CHECK(json_valid(ask_json)),
  queued_at TEXT,
  verdict_json TEXT CHECK(json_valid(verdict_json)),
  suggested_edit_json TEXT CHECK(json_valid(suggested_edit_json)),
  question_for TEXT REFERENCES members(id)
) WITHOUT ROWID, STRICT;
CREATE INDEX page_discussion_comments_order ON page_discussion_comments(discussion_id, created_at, id);
CREATE INDEX page_discussion_queued_asks ON page_discussion_comments(queued_at,id) WHERE queued_at IS NOT NULL;
CREATE TABLE page_discussion_anchor_blocks (
  discussion_id TEXT NOT NULL REFERENCES page_discussions(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  PRIMARY KEY(discussion_id, block_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX page_discussion_anchor_block ON page_discussion_anchor_blocks(block_id, discussion_id);
CREATE TABLE page_run_block_changes (
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  before_json TEXT CHECK(json_valid(before_json)),
  after_json TEXT CHECK(json_valid(after_json)),
  interleaved INTEGER NOT NULL DEFAULT 0 CHECK(interleaved IN (0,1)),
  PRIMARY KEY(page_id, run_id, session_id, block_id)
) WITHOUT ROWID, STRICT;
