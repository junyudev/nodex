DROP TABLE inbox_decision_undo;
CREATE TABLE inbox_decision_undo (
  token TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  recipe_json TEXT NOT NULL CHECK(json_valid(recipe_json)),
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
) WITHOUT ROWID, STRICT;
DROP VIEW inbox_member_rows;
DROP VIEW inbox_rows;
DROP TRIGGER intake_disposition_recorded;
DROP TRIGGER intake_disposition_confirmed;
ALTER TABLE inbox_entries DROP COLUMN state;
ALTER TABLE inbox_entries DROP COLUMN outcome;
ALTER TABLE inbox_entries DROP COLUMN status_fence;
CREATE TABLE inbox_notes (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id),
  UNIQUE(library_id,project_id)
) WITHOUT ROWID, STRICT;
CREATE UNIQUE INDEX inbox_notes_library ON inbox_notes(library_id) WHERE project_id IS NULL;
CREATE TABLE inbox_note_saves (
  page_id TEXT PRIMARY KEY REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  origin_data_source_id TEXT NOT NULL,
  origin_project_id TEXT
) WITHOUT ROWID, STRICT;
CREATE TRIGGER inbox_notes_cannot_archive BEFORE UPDATE OF lifecycle ON blocks
WHEN OLD.lifecycle='active' AND NEW.lifecycle<>'active' AND EXISTS(SELECT 1 FROM inbox_notes WHERE page_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'This Page is the Inbox Notes page'); END;
CREATE TRIGGER inbox_notes_cannot_delete BEFORE DELETE ON blocks
WHEN EXISTS(SELECT 1 FROM inbox_notes WHERE page_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'This Page is the Inbox Notes page'); END;
CREATE VIEW inbox_intake AS
SELECT entry.page_id, entry.library_id, CASE WHEN page.parent_kind='data_source' THEN scope.project_id ELSE note.origin_project_id END AS project_id,
       json_extract(status.value_json,'$') AS stage,
       COALESCE(json_extract(status.value_json,'$')='triage' AND active.page_id IS NULL
         AND NOT(proposal.state IS 'dispatching' AND proposal.failure_kind IS NOT 'unknown')
         AND NOT EXISTS(SELECT 1 FROM automation_decisions decision
           WHERE decision.page_id=entry.page_id AND decision.status='admitted'),0) AS triage,
       COALESCE(proposal.state='failed' OR (proposal.state='dispatching' AND proposal.failure_kind='unknown'),0)
         AND COALESCE(json_extract(status.value_json,'$') NOT IN ('done','canceled'),1) AS recovery
FROM inbox_entries entry JOIN blocks block ON block.id=entry.page_id AND block.lifecycle='active'
JOIN pages page ON page.block_id=entry.page_id
JOIN activity_page_scopes scope ON scope.page_id=entry.page_id
LEFT JOIN inbox_note_saves note ON note.page_id=entry.page_id
LEFT JOIN data_source_page_memberships membership ON page.parent_kind='data_source'
  AND membership.data_source_id=page.parent_id AND membership.page_block_id=page.block_id AND membership.removed_at IS NULL
LEFT JOIN data_source_property_values status ON status.data_source_id=membership.data_source_id
  AND status.membership_id=membership.id AND status.property_id='status'
LEFT JOIN page_active_chats active ON active.page_id=entry.page_id
LEFT JOIN inbox_proposals proposal ON proposal.proposal_id=entry.current_proposal_id
LEFT JOIN projects project ON project.id=CASE WHEN page.parent_kind='data_source' THEN scope.project_id ELSE note.origin_project_id END
WHERE project.id IS NULL OR project.lifecycle='active';
CREATE VIEW inbox_rows AS
SELECT 'intake' AS row_kind, intake.page_id, intake.library_id, intake.project_id,
       CASE WHEN json_extract(episode.signature,'$[1]') IN ('triage','delivery_recovery')
         THEN episode.since ELSE entry.submitted_at END AS sort_at,
       'intake:'||entry.page_id AS row_id,
       json_extract(episode.signature,'$[1]') IS 'triage' OR json_extract(episode.signature,'$[1]') IS 'delivery_recovery' AS actionable,
       json_extract(episode.signature,'$[1]') IS 'triage' OR json_extract(episode.signature,'$[1]') IS 'delivery_recovery' AS in_inbox,
       episode.episode
FROM inbox_intake intake JOIN inbox_entries entry ON entry.page_id=intake.page_id
LEFT JOIN page_turn_episodes episode ON episode.page_id=intake.page_id
UNION ALL
SELECT 'turn', page.block_id, page.library_id, scope.project_id, episode.since,
       'turn:'||page.block_id||':'||episode.episode, 1, 1, episode.episode
FROM page_turn_episodes episode JOIN pages page ON page.block_id=episode.page_id
JOIN blocks block ON block.id=page.block_id AND block.lifecycle='active'
JOIN activity_page_scopes scope ON scope.page_id=page.block_id
LEFT JOIN projects project ON project.id=scope.project_id
WHERE json_extract(episode.signature,'$[0].kind')='member'
  AND (scope.project_id IS NULL OR project.lifecycle='active')
  AND (json_extract(episode.signature,'$[1]') IN ('question','approval','review','blocked','failed','stalled')
       OR (json_extract(episode.signature,'$[1]')='ready_to_start' AND EXISTS(
         SELECT 1 FROM data_source_page_memberships membership JOIN data_source_relation_edges edge ON edge.source_membership_id=membership.id AND edge.property_id='blocked_by'
         WHERE membership.page_block_id=page.block_id AND membership.data_source_id=page.parent_id AND membership.removed_at IS NULL)))
UNION ALL
SELECT 'answer', answer.page_id, answer.library_id, answer.scope_project_id, answer.created_at, 'answer:'||answer.page_id, 0, answer.handled_at IS NULL, NULL
FROM inbox_answers answer JOIN blocks block ON block.id=answer.page_id AND block.lifecycle='active'
LEFT JOIN projects project ON project.id=answer.scope_project_id
WHERE answer.scope_project_id IS NULL OR project.lifecycle='active'
UNION ALL
SELECT 'problem', problem.id, problem.library_id, problem.project_id,
       strftime('%Y-%m-%dT%H:%M:%fZ',problem.opened_at_ms/1000.0,'unixepoch'), 'problem:'||problem.id, 1, 1, NULL
FROM problems problem LEFT JOIN projects project ON project.id=problem.project_id
WHERE problem.opened_at_ms IS NOT NULL AND problem.resolved_at_ms IS NULL
  AND (problem.project_id IS NULL OR project.lifecycle='active');
CREATE VIEW inbox_member_rows AS
SELECT rows.*,member.id AS member_id FROM inbox_rows rows
JOIN members member ON member.library_id=rows.library_id AND member.lifecycle='active'
LEFT JOIN inbox_answers answer ON answer.page_id=rows.page_id
LEFT JOIN page_turn_episodes episode ON episode.page_id=rows.page_id
LEFT JOIN inbox_entries entry ON entry.page_id=rows.page_id
LEFT JOIN block_properties work ON work.block_id=rows.page_id AND work.property_key='work'
WHERE (rows.row_kind='turn' AND member.id=json_extract(episode.signature,'$[0].member_id'))
 OR (rows.row_kind='answer' AND member.id=answer.member_id)
 OR (rows.row_kind='intake' AND CASE WHEN rows.in_inbox THEN
        json_extract(episode.signature,'$[0].kind')='members' OR member.id=json_extract(episode.signature,'$[0].member_id')
      ELSE member.id IN (entry.author_member_id,json_extract(work.value_json,'$.owner'))
        OR NOT EXISTS(SELECT 1 FROM members owner WHERE owner.id=json_extract(work.value_json,'$.owner') AND owner.lifecycle='active') END)
 OR rows.row_kind='problem';
CREATE TABLE inbox_deferrals (
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  episode TEXT NOT NULL,
  set_at TEXT NOT NULL,
  until_at TEXT NOT NULL,
  PRIMARY KEY(page_id,member_id,episode)
) WITHOUT ROWID, STRICT;
CREATE INDEX inbox_deferrals_due ON inbox_deferrals(until_at,page_id,member_id);
CREATE TABLE inbox_later_notifications (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  episode TEXT NOT NULL,
  returned_at TEXT NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0 CHECK(claimed IN (0,1)),
  push_claimed INTEGER NOT NULL DEFAULT 0 CHECK(push_claimed IN (0,1)),
  UNIQUE(page_id,member_id,episode),
  FOREIGN KEY(page_id,member_id,episode) REFERENCES inbox_deferrals(page_id,member_id,episode) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE INDEX inbox_later_notifications_member ON inbox_later_notifications(library_id,member_id,claimed,returned_at);
CREATE TRIGGER turn_intake_added AFTER INSERT ON inbox_entries
BEGIN INSERT OR IGNORE INTO page_turn_dirty VALUES(NEW.page_id); END;
CREATE TRIGGER turn_intake_removed AFTER DELETE ON inbox_entries
BEGIN INSERT OR IGNORE INTO page_turn_dirty VALUES(OLD.page_id); END;
CREATE TRIGGER turn_intake_proposal AFTER UPDATE OF current_proposal_id ON inbox_entries
WHEN NEW.current_proposal_id IS NOT OLD.current_proposal_id
BEGIN INSERT OR IGNORE INTO page_turn_dirty VALUES(NEW.page_id); END;
CREATE TRIGGER turn_intake_delivery AFTER UPDATE OF state,failure_kind ON inbox_proposals
WHEN NEW.state IS NOT OLD.state OR NEW.failure_kind IS NOT OLD.failure_kind
BEGIN INSERT OR IGNORE INTO page_turn_dirty SELECT page_id FROM inbox_proposal_pages WHERE proposal_id=NEW.proposal_id; END;
CREATE TRIGGER turn_intake_automation AFTER UPDATE OF status ON automation_decisions
WHEN NEW.status IS NOT OLD.status AND NEW.page_id IS NOT NULL
BEGIN INSERT OR IGNORE INTO page_turn_dirty VALUES(NEW.page_id); END;
CREATE TRIGGER intake_disposition_confirmed AFTER UPDATE OF confirmed_at ON inbox_proposals
WHEN NEW.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at
 AND json_extract(NEW.action_json,'$.type') IN ('move_to_project','keep','save_to_notes','plan','new_chat','send_to_chat','execute_decision')
BEGIN
  INSERT INTO intake_dispositions(library_id,page_id,project_id,disposition,proposal_id,at)
  SELECT entry.library_id,entry.page_id,COALESCE(note.origin_project_id,scope.project_id),
    CASE json_extract(NEW.action_json,'$.type') WHEN 'move_to_project' THEN 'filed' WHEN 'keep' THEN 'kept' WHEN 'save_to_notes' THEN 'kept' WHEN 'plan' THEN 'done' ELSE 'chat' END,
    NEW.proposal_id,NEW.confirmed_at
  FROM inbox_proposal_pages link JOIN inbox_entries entry ON entry.page_id=link.page_id
  JOIN activity_page_scopes scope ON scope.page_id=entry.page_id
  LEFT JOIN inbox_note_saves note ON note.page_id=entry.page_id
  WHERE link.proposal_id=NEW.proposal_id;
END;
ALTER TABLE intake_dispositions ADD COLUMN commit_seq INTEGER;
DROP TRIGGER intake_dispositions_capture_actor;
CREATE TRIGGER intake_dispositions_capture_actor AFTER INSERT ON intake_dispositions
BEGIN
 UPDATE intake_dispositions SET commit_seq=(SELECT max(commit_seq) FROM local_commits WHERE finalized=0),actor_json=COALESCE((SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1),CASE WHEN EXISTS(SELECT 1 FROM inbox_entries WHERE page_id=NEW.page_id AND source_kind='automation') THEN json_object('type','service','kind','automations') END) WHERE id=NEW.id;
 SELECT CASE WHEN (SELECT actor_json FROM intake_dispositions WHERE id=NEW.id) IS NULL THEN RAISE(ABORT,'Activity facts require an admitted mutation actor') END;
END;
