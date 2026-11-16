CREATE VIRTUAL TABLE page_search_words USING fts5(
  segments,
  content='',
  contentless_delete=1,
  tokenize="ascii tokenchars '#*'",
  prefix='2 3 4'
);
CREATE TABLE page_search_dictionary (
  term TEXT PRIMARY KEY,
  unit_count INTEGER NOT NULL CHECK(unit_count > 0)
) WITHOUT ROWID, STRICT;
CREATE TABLE page_search_dictionary_units (
  unit_rowid INTEGER PRIMARY KEY REFERENCES block_search_units(rowid) ON DELETE CASCADE,
  terms TEXT NOT NULL CHECK(json_valid(terms))
) STRICT;
CREATE TRIGGER page_search_dictionary_units_ad AFTER DELETE ON page_search_dictionary_units BEGIN
  DELETE FROM page_search_dictionary
    WHERE term IN (SELECT value FROM json_each(OLD.terms)) AND unit_count = 1;
  UPDATE page_search_dictionary SET unit_count = unit_count - 1
    WHERE term IN (SELECT value FROM json_each(OLD.terms));
END;
CREATE TRIGGER page_search_words_ad AFTER DELETE ON block_search_units BEGIN
  DELETE FROM page_search_words WHERE rowid = OLD.rowid;
END;
CREATE TABLE page_search_documents (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON UPDATE CASCADE ON DELETE CASCADE,
  analyzer_version INTEGER CHECK (analyzer_version > 0),
  page_updated_at TEXT,
  building_version INTEGER CHECK (building_version > 0),
  indexed_units INTEGER NOT NULL DEFAULT 0 CHECK (indexed_units >= 0),
  prune_after_rowid INTEGER NOT NULL DEFAULT 0 CHECK (prune_after_rowid >= -1)
) WITHOUT ROWID, STRICT;
CREATE INDEX page_search_documents_priority ON page_search_documents(
  analyzer_version, page_updated_at DESC, document_id
);
CREATE TRIGGER page_search_documents_page_ai AFTER INSERT ON pages BEGIN
  UPDATE page_search_documents SET page_updated_at = NEW.updated_at
    WHERE document_id = NEW.document_id;
END;
CREATE TRIGGER page_search_documents_page_au AFTER UPDATE OF document_id, updated_at ON pages BEGIN
  UPDATE page_search_documents SET page_updated_at = NULL
    WHERE document_id = OLD.document_id AND OLD.document_id <> NEW.document_id;
  UPDATE page_search_documents SET page_updated_at = NEW.updated_at
    WHERE document_id = NEW.document_id;
END;
CREATE TRIGGER page_search_documents_page_ad AFTER DELETE ON pages BEGIN
  UPDATE page_search_documents SET page_updated_at = NULL
    WHERE document_id = OLD.document_id;
END;
