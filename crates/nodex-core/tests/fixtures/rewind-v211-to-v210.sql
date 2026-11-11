DROP TABLE inbox_decision_undo;
CREATE TABLE inbox_decision_undo (
  token TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  store_epoch TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES inbox_proposals(proposal_id) ON DELETE CASCADE,
  recipe_json TEXT NOT NULL CHECK(json_valid(recipe_json)),
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
) WITHOUT ROWID, STRICT;
DROP TABLE inbox_later_notifications;
DROP TABLE inbox_deferrals;
DROP TRIGGER turn_intake_added;
DROP TRIGGER turn_intake_removed;
DROP TRIGGER turn_intake_proposal;
DROP TRIGGER turn_intake_delivery;
DROP TRIGGER turn_intake_automation;
DROP VIEW inbox_member_rows;
DROP VIEW inbox_rows;
DROP VIEW inbox_intake;
DROP TRIGGER inbox_notes_cannot_archive;
DROP TRIGGER inbox_notes_cannot_delete;
DROP TABLE inbox_note_saves;
DROP TABLE inbox_notes;
DROP TRIGGER intake_disposition_confirmed;
CREATE TABLE inbox_entries_rewind (
  page_id TEXT PRIMARY KEY REFERENCES pages(block_id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  submitted_at TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('user', 'agent', 'command_line', 'automation', 'github')),
  source_session_id TEXT CHECK (source_session_id IS NULL OR length(source_session_id) BETWEEN 1 AND 512),
  source_thread_id TEXT CHECK (source_thread_id IS NULL OR length(source_thread_id) BETWEEN 1 AND 512),
  source_turn_id TEXT CHECK (source_turn_id IS NULL OR length(source_turn_id) BETWEEN 1 AND 512),
  source_project_id TEXT CHECK (source_project_id IS NULL OR length(source_project_id) BETWEEN 1 AND 512),
  source_label TEXT CHECK (source_label IS NULL OR length(source_label) BETWEEN 1 AND 512),
  provisional_title TEXT CHECK (provisional_title IS NULL OR length(provisional_title) BETWEEN 1 AND 512),
  kind TEXT CHECK (kind IS NULL OR kind IN ('note', 'todo', 'question')),
  kind_set_by_user INTEGER NOT NULL DEFAULT 0 CHECK (kind_set_by_user IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'kept', 'done')),
  suggestion_state TEXT NOT NULL DEFAULT 'none' CHECK (suggestion_state IN ('none', 'waiting', 'pending', 'settled', 'failed')),
  suggestion_error TEXT CHECK (suggestion_error IS NULL OR length(suggestion_error) BETWEEN 1 AND 2000),
  current_proposal_id TEXT CHECK (current_proposal_id IS NULL OR length(current_proposal_id) BETWEEN 1 AND 512),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  source_budget_key TEXT,
  scope_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE CHECK (scope_project_id IS NULL OR length(scope_project_id) BETWEEN 1 AND 512),
  outcome TEXT CHECK (outcome IN ('kept','done','moved','chat')),
  suggestion_request_id TEXT,
  important INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
  source_automation_id TEXT,
  source_dispatch_id TEXT,
  reply_to_page_id TEXT CHECK (reply_to_page_id IS NULL OR length(reply_to_page_id) BETWEEN 1 AND 512), status_fence INTEGER NOT NULL DEFAULT 0 CHECK(status_fence >= 0), actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json)), author_member_id TEXT REFERENCES members(id),
  UNIQUE (library_id, seq),
  CHECK (source_kind = 'agent' OR (source_session_id IS NULL AND source_thread_id IS NULL AND source_turn_id IS NULL)),
  CHECK (source_kind <> 'user' OR (source_project_id IS NULL AND source_label IS NULL)),
  CHECK (source_kind = 'user' OR source_label IS NOT NULL),
  CHECK (suggestion_state = 'failed' OR suggestion_error IS NULL)
) WITHOUT ROWID, STRICT;
INSERT INTO inbox_entries_rewind(page_id,library_id,seq,submitted_at,source_kind,source_session_id,source_thread_id,source_turn_id,source_project_id,source_label,provisional_title,kind,kind_set_by_user,suggestion_state,suggestion_error,current_proposal_id,revision,updated_at,source_budget_key,scope_project_id,suggestion_request_id,important,source_automation_id,source_dispatch_id,reply_to_page_id,actor_json,author_member_id) SELECT page_id,library_id,seq,submitted_at,source_kind,source_session_id,source_thread_id,source_turn_id,source_project_id,source_label,provisional_title,kind,kind_set_by_user,suggestion_state,suggestion_error,current_proposal_id,revision,updated_at,source_budget_key,scope_project_id,suggestion_request_id,important,source_automation_id,source_dispatch_id,reply_to_page_id,actor_json,author_member_id FROM inbox_entries;
DROP TABLE inbox_entries;
ALTER TABLE inbox_entries_rewind RENAME TO inbox_entries;
CREATE INDEX idx_inbox_entries_suggestion ON inbox_entries(library_id, suggestion_state, seq);
CREATE INDEX idx_inbox_entries_source_budget ON inbox_entries(library_id, source_budget_key)
  WHERE source_budget_key IS NOT NULL;
CREATE INDEX idx_inbox_entries_scope ON inbox_entries(library_id, scope_project_id, seq);
CREATE VIEW inbox_rows AS
SELECT 'intake' AS row_kind, entry.page_id, entry.library_id, entry.scope_project_id AS project_id,
       entry.submitted_at AS sort_at, 'intake:'||entry.page_id AS row_id,
       (entry.state='open' AND NOT(COALESCE(proposal.state,'')='dispatching' AND COALESCE(proposal.failure_kind,'')<>'unknown')
        AND NOT(COALESCE(proposal.state,'')='completed' AND COALESCE(json_extract(proposal.action_json,'$.type'),'') IN ('new_chat','send_to_chat','execute_decision'))) AS actionable,
       (entry.state='open' AND NOT(COALESCE(proposal.state,'')='dispatching' AND COALESCE(proposal.failure_kind,'')<>'unknown')
        AND NOT(COALESCE(proposal.state,'')='completed' AND COALESCE(json_extract(proposal.action_json,'$.type'),'') IN ('new_chat','send_to_chat','execute_decision'))) AS in_inbox
FROM inbox_entries entry JOIN blocks block ON block.id=entry.page_id AND block.lifecycle='active'
LEFT JOIN inbox_proposals proposal ON proposal.proposal_id=entry.current_proposal_id
LEFT JOIN projects project ON project.id=entry.scope_project_id
WHERE entry.scope_project_id IS NULL OR project.lifecycle='active'
UNION ALL
SELECT 'turn', page.block_id, page.library_id, project.id, episode.since, 'turn:'||page.block_id||':'||episode.episode, 1, 1
FROM page_turn_episodes episode JOIN pages page ON page.block_id=episode.page_id
JOIN blocks block ON block.id=page.block_id AND block.lifecycle='active'
LEFT JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id
LEFT JOIN project_database_bindings binding ON binding.database_block_id=source.home_database_block_id AND binding.lifecycle='active'
LEFT JOIN projects project ON project.id=binding.project_id
WHERE json_extract(episode.signature,'$[0].kind')='member'
  AND (project.id IS NULL OR project.lifecycle='active')
  AND (json_extract(episode.signature,'$[1]') IN ('question','approval','review','blocked','failed','stalled')
       OR (json_extract(episode.signature,'$[1]')='ready_to_start' AND EXISTS(
         SELECT 1 FROM data_source_page_memberships membership JOIN data_source_relation_edges edge ON edge.source_membership_id=membership.id AND edge.property_id='blocked_by'
         WHERE membership.page_block_id=page.block_id AND membership.data_source_id=page.parent_id AND membership.removed_at IS NULL)))
  AND NOT EXISTS(SELECT 1 FROM inbox_entries intake WHERE intake.page_id=page.block_id AND intake.state='open' AND intake.current_proposal_id IS NULL)
UNION ALL
SELECT 'answer', answer.page_id, answer.library_id, answer.scope_project_id, answer.created_at, 'answer:'||answer.page_id, 0, answer.handled_at IS NULL
FROM inbox_answers answer JOIN blocks block ON block.id=answer.page_id AND block.lifecycle='active'
LEFT JOIN projects project ON project.id=answer.scope_project_id
WHERE answer.scope_project_id IS NULL OR project.lifecycle='active'
UNION ALL
SELECT 'problem', problem.id, problem.library_id, problem.project_id,
       strftime('%Y-%m-%dT%H:%M:%fZ',problem.opened_at_ms/1000.0,'unixepoch'), 'problem:'||problem.id, 1, 1
FROM problems problem LEFT JOIN projects project ON project.id=problem.project_id
WHERE problem.opened_at_ms IS NOT NULL AND problem.resolved_at_ms IS NULL
  AND (problem.project_id IS NULL OR project.lifecycle='active');
CREATE VIEW inbox_member_rows AS
SELECT rows.*,member.id AS member_id FROM inbox_rows rows
JOIN members member ON member.library_id=rows.library_id AND member.lifecycle='active'
LEFT JOIN inbox_entries entry ON entry.page_id=rows.page_id
LEFT JOIN inbox_answers answer ON answer.page_id=rows.page_id
LEFT JOIN page_turn_episodes episode ON episode.page_id=rows.page_id
WHERE (rows.row_kind='turn' AND member.id=json_extract(episode.signature,'$[0].member_id'))
 OR (rows.row_kind='answer' AND member.id=answer.member_id)
 OR (rows.row_kind='intake' AND (entry.source_kind<>'automation' OR member.id=entry.author_member_id))
 OR rows.row_kind='problem';
CREATE TRIGGER intake_disposition_recorded AFTER UPDATE OF state ON inbox_entries
WHEN OLD.state<>NEW.state AND NOT EXISTS(SELECT 1 FROM intake_dispositions fact
  WHERE fact.page_id=NEW.page_id AND fact.proposal_id=NEW.current_proposal_id AND fact.at=NEW.updated_at)
BEGIN
  INSERT INTO intake_dispositions(library_id,page_id,project_id,disposition,at) VALUES(NEW.library_id,NEW.page_id,NEW.scope_project_id,NEW.state,NEW.updated_at);
END;
CREATE TRIGGER intake_disposition_confirmed AFTER UPDATE OF confirmed_at ON inbox_proposals
WHEN NEW.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at
BEGIN
  INSERT INTO intake_dispositions(library_id,page_id,project_id,disposition,proposal_id,at)
  SELECT entry.library_id,entry.page_id,entry.scope_project_id,
    CASE json_extract(NEW.action_json,'$.type') WHEN 'move_to_project' THEN 'filed' WHEN 'keep' THEN 'kept' WHEN 'plan' THEN 'done' ELSE 'chat' END,
    NEW.proposal_id,NEW.confirmed_at
  FROM inbox_proposal_pages link JOIN inbox_entries entry ON entry.page_id=link.page_id
  WHERE link.proposal_id=NEW.proposal_id;
END;
DROP VIEW activity_facts;
DROP TRIGGER intake_dispositions_capture_actor;
CREATE TABLE intake_dispositions_next (
  id INTEGER PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE,
  project_id TEXT,
  disposition TEXT NOT NULL CHECK(disposition IN ('chat','filed','kept','done','open')),
  proposal_id TEXT REFERENCES inbox_proposals(proposal_id) ON DELETE SET NULL,
  at TEXT NOT NULL,
  actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json))
) STRICT;
INSERT INTO intake_dispositions_next(id,library_id,page_id,project_id,disposition,proposal_id,at,actor_json) SELECT id,library_id,page_id,project_id,disposition,proposal_id,at,actor_json FROM intake_dispositions;
DROP TABLE intake_dispositions;
ALTER TABLE intake_dispositions_next RENAME TO intake_dispositions;
CREATE INDEX intake_dispositions_page ON intake_dispositions(page_id,proposal_id,at);
CREATE TRIGGER intake_dispositions_capture_actor AFTER INSERT ON intake_dispositions
BEGIN
 UPDATE intake_dispositions SET actor_json=COALESCE((SELECT actor_json FROM local_commits WHERE finalized=0 ORDER BY commit_seq DESC LIMIT 1),CASE WHEN EXISTS(SELECT 1 FROM inbox_entries WHERE page_id=NEW.page_id AND source_kind='automation') THEN json_object('type','service','kind','automations') END) WHERE id=NEW.id;
 SELECT CASE WHEN (SELECT actor_json FROM intake_dispositions WHERE id=NEW.id) IS NULL THEN RAISE(ABORT,'Activity facts require an admitted mutation actor') END;
END;
CREATE VIEW activity_facts AS
SELECT 'message:'||d.id AS id,d.library_id,d.page_id,d.project_id,d.at,
 d.actor_json AS actor_json,
 CASE d.disposition WHEN 'chat' THEN 'Sent message to chat' WHEN 'filed' THEN 'Filed message' WHEN 'kept' THEN 'Kept message' WHEN 'done' THEN 'Marked message done' ELSE 'Returned message to Inbox' END AS description,
 p.rationale AS reason,CASE d.disposition WHEN 'chat' THEN COALESCE(p.dispatch_session_id,json_extract(p.action_json,'$.session_id')) END AS session_id,NULL AS url,
 json_object('disposition',d.disposition,'proposal_id',d.proposal_id,'confirmed_by',p.confirmed_by,
   'answered',json(CASE WHEN d.disposition='done' AND EXISTS(SELECT 1 FROM inbox_answers answer
     WHERE answer.question_page_id=d.page_id AND answer.created_at=d.at) THEN 'true' ELSE 'false' END),
   'action',json_object('type',json_extract(p.action_json,'$.type'),'session_id',json_extract(p.action_json,'$.session_id'),
     'project_id',json_extract(p.action_json,'$.project_id'),'decision_id',json_extract(p.action_json,'$.decision_id'),
     'steps',json_array_length(p.action_json,'$.steps'))) AS evidence_json,'messages' AS category
FROM intake_dispositions d JOIN inbox_entries entry ON entry.page_id=d.page_id
JOIN blocks block ON block.id=d.page_id AND block.lifecycle='active'
LEFT JOIN inbox_proposals p ON p.proposal_id=d.proposal_id
UNION ALL
SELECT 'launch:'||l.launch_id,s.library_id,l.page_id,l.project_id,l.created_at,l.actor_json,
 CASE l.automatic WHEN 1 THEN 'Automatically started work' ELSE 'Started work' END,l.rejection,l.session_id,NULL,json_object('launch_id',l.launch_id,'accepted_at',l.accepted_at,'automatic',json(CASE l.automatic WHEN 1 THEN 'true' ELSE 'false' END)),'decisions'
FROM page_work_launches l JOIN activity_page_scopes s ON s.page_id=l.page_id
UNION ALL
SELECT 'trigger:'||t.id||':'||COALESCE(d.page_id,intake.page_id,''),t.library_id,COALESCE(d.page_id,intake.page_id),COALESCE(s.project_id,entry.scope_project_id),strftime('%Y-%m-%dT%H:%M:%fZ',t.received_at_ms/1000.0,'unixepoch'),json_object('type','service','kind','sources'),
 CASE t.disposition WHEN 'followed' THEN 'Routed GitHub update to followed cards' WHEN 'intake' THEN 'Sent GitHub request to Inbox' ELSE 'Ignored GitHub update' END,
 CASE t.disposition WHEN 'followed' THEN 'Thread is followed; no new assessment' WHEN 'intake' THEN 'Discovery matched an unwatched request' ELSE 'No followed card or enabled discovery matched' END,d.session_id,json_extract(t.event_json,'$.url'),json_object('trigger_id',t.id,'kind',json_extract(t.event_json,'$.kind'),'actor',json_extract(t.event_json,'$.actor_login'),'event',json(t.event_json),'disposition',t.disposition,'delivery_state',d.state),'decisions'
FROM source_triggers t LEFT JOIN thread_deliveries d ON d.trigger_id=t.id
LEFT JOIN activity_page_scopes s ON s.page_id=d.page_id
LEFT JOIN github_intake_triggers intake_link ON intake_link.trigger_id=t.id
LEFT JOIN github_intakes intake ON intake.external_thread_id=intake_link.external_thread_id
LEFT JOIN inbox_entries entry ON entry.page_id=intake.page_id
UNION ALL
SELECT 'milestone:'||m.page_id||':'||m.fact_identity,s.library_id,m.page_id,s.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',t.received_at_ms/1000.0,'unixepoch'),json_object('type','service','kind','sources'),
 CASE m.status_moved WHEN 1 THEN 'Moved card to ' ELSE 'Skipped move to ' END||CASE m.destination WHEN 'doing' THEN 'In Progress' WHEN 'review' THEN 'In Review' WHEN 'done' THEN 'Done' ELSE 'Canceled' END,m.reason,NULL,json_extract(t.event_json,'$.url'),json_object('trigger_id',t.id,'fact',m.fact_identity,'moved',m.status_moved,'destination',m.destination,'stage',m.stage,'event',json(t.event_json)),'decisions'
FROM thread_milestones m JOIN source_triggers t ON t.id=m.trigger_id JOIN activity_page_scopes s ON s.page_id=m.page_id
UNION ALL
SELECT 'delivery:'||d.id,s.library_id,d.page_id,s.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(b.settled_at_ms,t.received_at_ms)/1000.0,'unixepoch'),json_object('type','service','kind','sources'),
 CASE d.state WHEN 'accepted' THEN 'Delivered GitHub update to chat' WHEN 'suppressed' THEN 'Ignored GitHub update on closed work' WHEN 'unresolved' THEN 'GitHub update needs a chat' WHEN 'rejected' THEN 'Chat rejected GitHub update' ELSE 'Queued GitHub update for chat' END,d.reason,d.session_id,json_extract(t.event_json,'$.url'),json_object('delivery_id',d.id,'message_id',d.message_id,'state',d.state,'event',json(t.event_json)),'all'
FROM thread_deliveries d JOIN source_triggers t ON t.id=d.trigger_id JOIN activity_page_scopes s ON s.page_id=d.page_id LEFT JOIN thread_delivery_batches b ON b.message_id=d.message_id
UNION ALL
SELECT 'channel:'||o.id,o.library_id,o.page_id,s.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',o.updated_at_ms/1000.0,'unixepoch'),o.actor_json,
 CASE o.state WHEN 'sent' THEN 'Replied to origin on GitHub' WHEN 'dropped' THEN 'GitHub reply could not be sent' WHEN 'failed' THEN 'GitHub reply needs retry' ELSE 'Queued reply to origin' END,o.terminal_reason,NULL,COALESCE(o.remote_url,json_extract(o.thread_json,'$.url')),json_object('outbox_id',o.id,'state',o.state,'body',o.body,'comment_id',o.remote_comment_id,'thread',json(o.thread_json)),'all'
FROM channel_outbox o JOIN activity_page_scopes s ON s.page_id=o.page_id
UNION ALL
SELECT 'note:'||n.note_id,s.library_id,n.page_id,s.project_id,n.created_at,n.actor_json,'Added Turn note',n.body,n.coordinator_session_id,NULL,json_object('note_id',n.note_id,'episode',n.episode),'all'
FROM page_turn_notes n JOIN activity_page_scopes s ON s.page_id=n.page_id
UNION ALL
SELECT 'handback:'||h.receipt_id||':'||link.page_id,d.library_id,link.page_id,s.project_id,h.created_at,h.actor_json,'Returned message to Inbox',h.reason,d.session_id,NULL,json_object('receipt_id',h.receipt_id,'delivery_id',h.delivery_id),'decisions'
FROM chat_message_handbacks h JOIN chat_message_deliveries d ON d.delivery_id=h.delivery_id JOIN chat_message_handback_pages link ON link.receipt_id=h.receipt_id JOIN activity_page_scopes s ON s.page_id=link.page_id
UNION ALL
SELECT 'problem-open:'||p.id,p.library_id,p.page_id,p.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',p.opened_at_ms/1000.0,'unixepoch'),json_object('type','service','kind','sources'),p.summary,json_extract(p.evidence_json,'$.reason'),NULL,json_extract(p.evidence_json,'$.url'),json_object('problem_id',p.id,'kind',p.kind,'fix',p.fix,'source_id',p.source_id,'count',p.consecutive_failures,'scope',p.scope),'problems'
FROM problems p WHERE p.opened_at_ms IS NOT NULL
UNION ALL
SELECT 'problem-resolved:'||p.id,p.library_id,p.page_id,p.project_id,strftime('%Y-%m-%dT%H:%M:%fZ',p.resolved_at_ms/1000.0,'unixepoch'),json_object('type','service','kind','sources'),'Resolved: '||p.summary,'Recovered successfully',NULL,json_extract(p.evidence_json,'$.url'),json_object('problem_id',p.id,'kind',p.kind,'source_id',p.source_id,'count',p.consecutive_failures,'scope',p.scope),'problems'
FROM problems p WHERE p.opened_at_ms IS NOT NULL AND p.resolved_at_ms IS NOT NULL
UNION ALL
SELECT phase.kind||':'||decision.dispatch_id,owner.library_id,decision.page_id,automation.scope_project_id,
 strftime('%Y-%m-%dT%H:%M:%fZ',(CASE phase.kind WHEN 'automation' THEN decision.created_at_ms ELSE decision.updated_at_ms END)/1000.0,'unixepoch'),
 decision.actor_json,'Automation decision',
 CASE WHEN phase.kind='automation' AND decision.status IN ('skipped','withdrawn','failed') THEN NULL
   ELSE COALESCE(decision.failure_message,NULLIF(decision.reason,'')) END,NULL,NULL,
 json_object('decision_id',decision.dispatch_id,'automation_id',decision.automation_id,
   'mode',decision.mode,'manual',json(CASE WHEN decision.admitted_at_ms IS NOT NULL AND decision.page_id IS NULL THEN 'true' ELSE 'false' END),'status',CASE WHEN phase.kind='automation' AND decision.admitted_at_ms IS NOT NULL AND decision.page_id IS NULL THEN 'admitted' WHEN phase.kind='automation' THEN CASE decision.mode WHEN 'dry_run' THEN 'completed' WHEN 'ask_first' THEN 'held' ELSE 'admitted' END ELSE decision.status END,'automation_revision',decision.automation_revision,
   'first_due_at_ms',decision.first_scheduled_for_ms,'last_due_at_ms',decision.last_scheduled_for_ms,
   'missed_count',decision.missed_count),'decisions'
FROM automation_decisions decision JOIN automations automation ON automation.automation_id=decision.automation_id
JOIN members owner ON owner.id=automation.owner_member_id
JOIN (SELECT 'automation' AS kind UNION ALL SELECT 'automation-settlement') phase
  ON phase.kind='automation' OR decision.status IN ('skipped','withdrawn','failed')
WHERE decision.assessment_json IS NULL AND (phase.kind='automation-settlement'
 OR (decision.mode='dry_run' AND decision.status='completed')
 OR decision.admitted_at_ms IS NOT NULL
 OR decision.page_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM automation_execution_leases lease
   WHERE lease.dispatch_id=decision.dispatch_id AND lease.automation_id=decision.automation_id AND lease.purpose='run')
 OR EXISTS(SELECT 1 FROM automation_execution_runs run
   WHERE run.dispatch_id=decision.dispatch_id AND run.automation_id=decision.automation_id))
UNION ALL
SELECT 'assessment:'||d.dispatch_id,m.library_id,d.page_id,r.scope_project_id,
 strftime('%Y-%m-%dT%H:%M:%fZ',d.created_at_ms/1000.0,'unixepoch'),
 d.actor_json,'Automation assessment',d.reason,NULL,NULL,
 json_set(d.assessment_json,'$.fact_kind','assessment','$.automation_id',d.automation_id,'$.decision_id',d.dispatch_id,'$.mode',d.mode,'$.status',d.status),'decisions'
FROM automation_decisions d JOIN automations r ON r.automation_id=d.automation_id JOIN members m ON m.id=r.owner_member_id WHERE d.assessment_json IS NOT NULL;
PRAGMA user_version=210;
