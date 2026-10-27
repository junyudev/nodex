/** Shared with the partial index so recovery reads only unresolved delivery identities. */
export const PENDING_MESSAGE_DELIVERY_PREDICATE = `role = 'user' AND CASE WHEN json_valid(payload_json)
  THEN json_extract(payload_json, '$.delivery') IN ('pending', 'unknown') ELSE 0 END`;
export const MAX_PENDING_MESSAGE_DELIVERIES = 256;
