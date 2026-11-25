-- Retire former decision delivery while keeping the underlying pending requests.
DROP VIEW activity_facts;
DROP VIEW inbox_member_rows;
DROP VIEW inbox_rows;
DELETE FROM inbox_routing_deliveries;
DELETE FROM execution_hold_routing_clocks;
UPDATE automation_assessment_requests
SET coordinator_session_id=NULL,handed_over_at_ms=NULL,run_started_at_ms=NULL
WHERE coordinator_session_id IS NOT NULL;
DROP TABLE page_turn_note_events;
DROP TABLE page_turn_notes;
DROP TABLE coordinator_work_events;
DROP TABLE coordinator_event_batches;

CREATE TABLE nodex_decision_runs (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('routing','assessment')),
  request_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=1),
  created_at TEXT NOT NULL,
  execution_stopped INTEGER NOT NULL DEFAULT 0 CHECK(execution_stopped IN (0,1)),
  UNIQUE(kind, request_id, generation)
) WITHOUT ROWID, STRICT;
CREATE INDEX idx_decision_runs_unstopped ON nodex_decision_runs(session_id) WHERE execution_stopped=0;
CREATE TABLE managed_chats (
  session_id TEXT PRIMARY KEY REFERENCES project_sessions(id) ON DELETE CASCADE,
  since TEXT NOT NULL
) WITHOUT ROWID, STRICT;
INSERT INTO managed_chats(session_id,since)
SELECT session_id,since FROM coordinator_managed_sessions;
DROP TABLE coordinator_managed_sessions;
-- Schema rebuilds run with foreign-key actions disabled.
INSERT INTO nodex_agent_runtime_execution_cleanups(
  cleanup_id,library_id,session_id,project_id,runtime_id,runtime_thread_id,created_at
)
SELECT 'retire-nodex-chat:'||session_id,(SELECT id FROM libraries LIMIT 1),session_id,NULL,
  runtime_id,runtime_thread_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM project_session_execution_bindings WHERE session_id=(SELECT session_id FROM coordinator);
UPDATE inbox_deferrals SET linked_session_id=NULL WHERE linked_session_id=(SELECT session_id FROM coordinator);
DELETE FROM page_active_chats WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM member_session_pins WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM member_session_settled WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM member_session_snooze_deliveries WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM member_session_snoozes WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM member_session_unread WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM member_session_wakes WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM page_work_launches WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM project_session_chat_folders WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM project_session_execution_bindings WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM project_session_pages WHERE session_id=(SELECT session_id FROM coordinator);
-- Side chats have independent Runtime roots; keep their binding and historic fork lineage.
DELETE FROM project_session_side_chats
WHERE session_id=(SELECT session_id FROM coordinator)
   OR source_session_id=(SELECT session_id FROM coordinator);
DELETE FROM project_session_threads WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM project_session_usage WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM project_session_user_message_receipts WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM session_execution_observations WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM session_requesting_members WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM session_run_members WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM workspace_sidebar_section_items WHERE session_id=(SELECT session_id FROM coordinator);
DELETE FROM project_sessions WHERE id=(SELECT session_id FROM coordinator WHERE id=1);
DROP TABLE coordinator;

ALTER TABLE inbox_routing_deliveries RENAME COLUMN coordinator_session_id TO decision_session_id;
ALTER TABLE inbox_answers DROP COLUMN coordinator_session_id;
ALTER TABLE inbox_answers ADD COLUMN decision_session_id TEXT REFERENCES nodex_decision_runs(session_id) ON DELETE SET NULL;
ALTER TABLE automation_assessment_requests DROP COLUMN coordinator_session_id;
ALTER TABLE automation_assessment_requests ADD COLUMN decision_session_id TEXT REFERENCES nodex_decision_runs(session_id) ON DELETE SET NULL;
ALTER TABLE inbox_proposals ADD COLUMN decision_session_id TEXT REFERENCES nodex_decision_runs(session_id) ON DELETE SET NULL;
ALTER TABLE automation_decisions ADD COLUMN decision_session_id TEXT REFERENCES nodex_decision_runs(session_id) ON DELETE SET NULL;
UPDATE session_search_revision SET revision=revision+1 WHERE id=1;

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
  AND (json_extract(episode.signature,'$[1]') IN ('question','approval','review','blocked','failed','stalled','reply')
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
CREATE VIEW activity_facts AS
SELECT 'message:'||d.id AS id,d.library_id,d.page_id,d.project_id,d.at,
 d.actor_json AS actor_json,
 CASE d.disposition WHEN 'chat' THEN 'Sent message to chat' WHEN 'filed' THEN 'Filed message' WHEN 'kept' THEN 'Kept message' WHEN 'done' THEN 'Marked message done' ELSE 'Returned message to Inbox' END AS description,
 p.rationale AS reason,CASE d.disposition WHEN 'chat' THEN COALESCE(p.dispatch_session_id,json_extract(p.action_json,'$.session_id')) END AS session_id,NULL AS url,
 json_object('disposition',d.disposition,'proposal_id',d.proposal_id,'confirmed_by',p.confirmed_by,'decision_session_id',COALESCE(p.decision_session_id,answer.decision_session_id),
   'answered',json(CASE WHEN d.disposition='done' AND answer.page_id IS NOT NULL THEN 'true' ELSE 'false' END),
   'action',json_object('type',json_extract(p.action_json,'$.type'),'session_id',json_extract(p.action_json,'$.session_id'),
     'project_id',json_extract(p.action_json,'$.project_id'),'decision_id',json_extract(p.action_json,'$.decision_id'),
     'steps',json_array_length(p.action_json,'$.steps'))) AS evidence_json,'messages' AS category
FROM intake_dispositions d JOIN inbox_entries entry ON entry.page_id=d.page_id
JOIN blocks block ON block.id=d.page_id AND block.lifecycle='active'
LEFT JOIN inbox_proposals p ON p.proposal_id=d.proposal_id
LEFT JOIN inbox_answers answer ON answer.question_page_id=d.page_id AND answer.created_at=d.at
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
 json_set(d.assessment_json,'$.fact_kind','assessment','$.decision_session_id',d.decision_session_id,'$.automation_id',d.automation_id,'$.decision_id',d.dispatch_id,'$.mode',d.mode,'$.status',d.status),'decisions'
FROM automation_decisions d JOIN automations r ON r.automation_id=d.automation_id JOIN members m ON m.id=r.owner_member_id WHERE d.assessment_json IS NOT NULL;
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
