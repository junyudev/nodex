CREATE INDEX idx_document_materializations_exact_head
  ON document_materializations(document_id, generation, projected_seq, schema_version);
