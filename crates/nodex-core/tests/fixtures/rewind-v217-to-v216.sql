DROP TRIGGER project_sessions_clear_member_attention;

DROP TABLE session_attention_dirty;
DROP TABLE member_session_wakes;
DROP INDEX inbox_deferrals_linked_session;
ALTER TABLE inbox_deferrals DROP COLUMN linked_session_id;
ALTER TABLE member_session_snoozes DROP COLUMN snoozed_at;

ALTER TABLE member_session_snoozes RENAME TO member_session_reminders;
ALTER TABLE member_session_reminders RENAME COLUMN snoozed_until TO remind_at;
DROP INDEX member_session_snooze_due;
CREATE INDEX member_session_reminder_due ON member_session_reminders(remind_at,session_id,member_id);

ALTER TABLE member_session_snooze_deliveries RENAME TO member_session_reminder_deliveries;
ALTER TABLE member_session_reminder_deliveries RENAME COLUMN snoozed_until TO remind_at;
DROP INDEX member_session_snooze_delivery_due;
CREATE INDEX member_session_reminder_delivery_due ON member_session_reminder_deliveries(next_attempt_at,delivery_id);

ALTER TABLE inbox_snooze_notifications RENAME TO inbox_later_notifications;
DROP INDEX inbox_snooze_notifications_member;
CREATE INDEX inbox_later_notifications_member ON inbox_later_notifications(library_id,member_id,claimed,returned_at);

UPDATE inbox_proposals
SET action_json=json_object('type','later','remind_at',json_extract(action_json,'$.snoozed_until'))
WHERE json_extract(action_json,'$.type')='snooze';

CREATE TRIGGER project_sessions_clear_member_attention AFTER UPDATE OF archived ON project_sessions
WHEN NEW.archived=1
BEGIN
  DELETE FROM member_session_unread WHERE session_id=NEW.id;
  DELETE FROM member_session_pins WHERE session_id=NEW.id;
  DELETE FROM member_session_reminders WHERE session_id=NEW.id;
  DELETE FROM member_session_reminder_deliveries WHERE session_id=NEW.id;
END;
DROP INDEX member_session_settled_order;
DROP TABLE member_session_settled;
ALTER TABLE project_sessions DROP COLUMN returned_at;
