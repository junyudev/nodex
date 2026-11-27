CREATE TABLE inbox_start_requests (
  page_id TEXT PRIMARY KEY REFERENCES inbox_entries(page_id) ON DELETE CASCADE,
  consent_basis TEXT CHECK (consent_basis IS NULL OR length(consent_basis) = 64),
  proposal_id TEXT REFERENCES inbox_proposals(proposal_id) ON DELETE SET NULL,
  preparation_error TEXT CHECK (preparation_error IS NULL OR length(preparation_error) BETWEEN 1 AND 2000),
  CHECK (consent_basis IS NULL OR proposal_id IS NULL)
) WITHOUT ROWID, STRICT;
