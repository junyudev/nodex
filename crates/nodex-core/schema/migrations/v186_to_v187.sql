-- A message sent to a chat carries its images. Each handoff freezes the Library images of the
-- messages it delivers beside its text; earlier handoffs delivered text only.
ALTER TABLE inbox_handoffs ADD COLUMN image_sources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(image_sources_json) AND json_type(image_sources_json) = 'array');
