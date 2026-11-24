DROP TRIGGER project_sessions_clear_member_attention;

ALTER TABLE member_session_reminders RENAME TO member_session_snoozes;
ALTER TABLE member_session_snoozes RENAME COLUMN remind_at TO snoozed_until;
ALTER TABLE member_session_snoozes ADD COLUMN snoozed_at INTEGER CHECK(snoozed_at >= 0);
DROP INDEX member_session_reminder_due;
CREATE INDEX member_session_snooze_due ON member_session_snoozes(snoozed_until,session_id,member_id);

ALTER TABLE member_session_reminder_deliveries RENAME TO member_session_snooze_deliveries;
ALTER TABLE member_session_snooze_deliveries RENAME COLUMN remind_at TO snoozed_until;
DROP INDEX member_session_reminder_delivery_due;
CREATE INDEX member_session_snooze_delivery_due ON member_session_snooze_deliveries(next_attempt_at,delivery_id);

ALTER TABLE inbox_later_notifications RENAME TO inbox_snooze_notifications;
DROP INDEX inbox_later_notifications_member;
CREATE INDEX inbox_snooze_notifications_member ON inbox_snooze_notifications(library_id,member_id,claimed,returned_at);

UPDATE inbox_proposals
SET action_json=json_object('type','snooze','snoozed_until',json_extract(action_json,'$.remind_at'))
WHERE json_extract(action_json,'$.type')='later';

-- When a chat's Agent last stopped and asked for a person, shared by every Member like its activity.
ALTER TABLE project_sessions ADD COLUMN returned_at INTEGER NOT NULL DEFAULT 0 CHECK (returned_at >= 0);

-- Each Member settles a chat when its work is finished for them.
CREATE TABLE member_session_settled (
 member_id TEXT NOT NULL REFERENCES members(id),
 session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
 settled_at INTEGER NOT NULL CHECK(settled_at >= 0),
 PRIMARY KEY(member_id,session_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX member_session_settled_order ON member_session_settled(member_id,settled_at DESC,session_id);

CREATE TABLE member_session_wakes (
 member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
 woke_at INTEGER NOT NULL CHECK(woke_at >= 0),
 PRIMARY KEY(member_id,session_id)
) WITHOUT ROWID, STRICT;

ALTER TABLE inbox_deferrals ADD COLUMN linked_session_id TEXT REFERENCES project_sessions(id) ON DELETE SET NULL;
CREATE INDEX inbox_deferrals_linked_session ON inbox_deferrals(linked_session_id,member_id)
 WHERE linked_session_id IS NOT NULL;

-- Cross-surface changes publish their invalidation when the enclosing commit seals.
CREATE TABLE session_attention_dirty (
 session_id TEXT PRIMARY KEY,
 inbox_changed INTEGER NOT NULL CHECK(inbox_changed IN (0,1))
) WITHOUT ROWID, STRICT;

-- An archived chat clears each Member's attention.
CREATE TRIGGER project_sessions_clear_member_attention AFTER UPDATE OF archived ON project_sessions
WHEN NEW.archived=1
BEGIN
  DELETE FROM member_session_unread WHERE session_id=NEW.id;
  DELETE FROM member_session_pins WHERE session_id=NEW.id;
  DELETE FROM member_session_snoozes WHERE session_id=NEW.id;
  DELETE FROM member_session_snooze_deliveries WHERE session_id=NEW.id;
  DELETE FROM member_session_wakes WHERE session_id=NEW.id;
  DELETE FROM member_session_settled WHERE session_id=NEW.id;
END;
