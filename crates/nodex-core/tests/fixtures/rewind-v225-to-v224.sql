DROP INDEX IF EXISTS idx_inbox_entries_source_session;

DROP TRIGGER intake_disposition_confirmed;
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
