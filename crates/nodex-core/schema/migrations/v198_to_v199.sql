UPDATE inbox_proposals
SET action_json = json_remove(action_json, '$.delegates', '$.plan')
WHERE json_type(action_json, '$.delegates') IS NOT NULL
   OR json_type(action_json, '$.plan') IS NOT NULL;

UPDATE inbox_handoffs
SET execution_selection_json = json_remove(execution_selection_json, '$.orchestration')
WHERE execution_selection_json IS NOT NULL
  AND json_type(execution_selection_json, '$.orchestration') IS NOT NULL;
