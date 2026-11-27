DROP TABLE page_run_block_changes;
DROP TABLE page_discussion_anchor_blocks;
DROP TABLE page_discussion_comments;
DROP TABLE page_discussions;
ALTER TABLE pages DROP COLUMN nodex_answers_questions;
PRAGMA legacy_alter_table=ON;
ALTER TABLE members RENAME TO members_v225;
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 256),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'removed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1), role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  UNIQUE (id, library_id)
) WITHOUT ROWID, STRICT;

INSERT INTO members SELECT * FROM members_v225;
DROP TABLE members_v225;
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
ALTER TABLE space_invites RENAME TO space_invites_v225;
CREATE TABLE space_invites (
 id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id),
 code_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('owner','member')),
 member_id TEXT REFERENCES members(id),
 expires_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES members(id), redeemed_at INTEGER
, device_link INTEGER NOT NULL DEFAULT 0 CHECK(device_link IN (0,1)), created_at INTEGER NOT NULL DEFAULT 0) STRICT;

INSERT INTO space_invites SELECT * FROM space_invites_v225;
DROP TABLE space_invites_v225;
