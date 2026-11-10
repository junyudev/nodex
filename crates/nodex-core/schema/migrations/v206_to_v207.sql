ALTER TABLE inbox_handoffs ADD COLUMN skill_invocations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skill_invocations_json) AND json_type(skill_invocations_json) = 'array');
ALTER TABLE inbox_routing_deliveries ADD COLUMN skill_offers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skill_offers_json) AND json_type(skill_offers_json) = 'array');
ALTER TABLE inbox_handoffs ADD COLUMN unavailable_skills_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(unavailable_skills_json) AND json_type(unavailable_skills_json) = 'array');
