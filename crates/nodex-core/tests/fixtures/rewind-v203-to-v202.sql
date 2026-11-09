-- Test support: rewinds a v203 Store to the v202 schema so predecessor upgrades can be reproduced
-- from Stores built at the current schema. Editor history lifetimes lose their Host start time.
DROP INDEX idx_editor_history_owners_peer;
ALTER TABLE editor_history_owners DROP COLUMN peer_started;
CREATE INDEX idx_editor_history_owners_peer ON editor_history_owners(peer_pid);
