ALTER TABLE database_view_personal_presentations
  RENAME TO database_view_personal_preferences;

ALTER TABLE database_view_personal_preferences
  RENAME COLUMN presentation_override_json TO preferences_json;

PRAGMA user_version = 146;
