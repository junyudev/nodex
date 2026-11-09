ALTER TABLE editor_history_owners ADD COLUMN peer_started INTEGER NOT NULL DEFAULT 0 CHECK (peer_started >= 0);
DROP INDEX idx_editor_history_owners_peer;
CREATE INDEX idx_editor_history_owners_peer ON editor_history_owners(peer_pid, peer_started);
