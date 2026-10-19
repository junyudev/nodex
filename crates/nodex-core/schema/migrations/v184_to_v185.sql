-- Withdraw abstentions without treating them as confirmed decisions. Handled entries
-- retain the user's outcome; open entries wait for a concrete suggestion.
UPDATE inbox_suggestion_requests
SET state = 'superseded',
    generation = generation + 1,
    correction = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE state IN ('pending', 'failed') AND proposal_id IN (
    SELECT proposal_id FROM inbox_proposals WHERE json_extract(action_json, '$.type') = 'none'
);

UPDATE inbox_entries
SET current_proposal_id = NULL,
    suggestion_request_id = CASE WHEN state = 'open' THEN NULL ELSE suggestion_request_id END,
    suggestion_state = CASE WHEN state = 'open' THEN 'pending' ELSE suggestion_state END,
    suggestion_error = CASE WHEN state = 'open' THEN NULL ELSE suggestion_error END,
    revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE current_proposal_id IN (
    SELECT proposal_id FROM inbox_proposals WHERE json_extract(action_json, '$.type') = 'none'
)
OR suggestion_request_id IN (
    SELECT request_id FROM inbox_suggestion_requests
    WHERE state = 'superseded' AND proposal_id IN (
        SELECT proposal_id FROM inbox_proposals WHERE json_extract(action_json, '$.type') = 'none'
    )
);

UPDATE inbox_suggestion_requests
SET proposal_id = NULL, expected_revision = NULL
WHERE proposal_id IN (
    SELECT proposal_id FROM inbox_proposals WHERE json_extract(action_json, '$.type') = 'none'
);

-- Schema migrations disable foreign_keys, so retire the full proposal closure
-- explicitly rather than relying on ON DELETE CASCADE.
DELETE FROM inbox_proposal_pages WHERE proposal_id IN (
    SELECT proposal_id FROM inbox_proposals WHERE json_extract(action_json, '$.type') = 'none'
);
DELETE FROM inbox_handoffs WHERE proposal_id IN (
    SELECT proposal_id FROM inbox_proposals WHERE json_extract(action_json, '$.type') = 'none'
);
DELETE FROM inbox_decision_undo WHERE proposal_id IN (
    SELECT proposal_id FROM inbox_proposals WHERE json_extract(action_json, '$.type') = 'none'
);
DELETE FROM inbox_proposals WHERE json_extract(action_json, '$.type') = 'none';
