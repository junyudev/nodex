CREATE VIRTUAL TABLE block_search_units_fts USING fts5(
      text,
      content='block_search_units',
      content_rowid='rowid',
      tokenize="unicode61 remove_diacritics 2 tokenchars '-_/@.:#'",
      prefix='2 3 4'
    );
CREATE TRIGGER block_search_units_ai AFTER INSERT ON block_search_units BEGIN
  INSERT INTO block_search_units_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
END;
CREATE TRIGGER block_search_units_ad AFTER DELETE ON block_search_units BEGIN
  INSERT INTO block_search_units_fts(block_search_units_fts, rowid, text)
  VALUES ('delete', OLD.rowid, OLD.text);
END;
CREATE TRIGGER block_search_units_au AFTER UPDATE ON block_search_units BEGIN
  INSERT INTO block_search_units_fts(block_search_units_fts, rowid, text)
  VALUES ('delete', OLD.rowid, OLD.text);
  INSERT INTO block_search_units_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
END;
INSERT INTO block_search_units_fts(block_search_units_fts) VALUES ('rebuild');
