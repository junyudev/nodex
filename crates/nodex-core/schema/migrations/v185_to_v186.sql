-- Pages show what a Property says, not that it is empty. The retired default stored
-- every Page layout entry as always_show; adopt hide_when_empty while keeping
-- explicit always_hide choices. Each changed layout advances its revision fence.
UPDATE data_source_page_layouts
SET revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE data_source_id IN (
    SELECT data_source_id FROM data_source_page_layout_entries WHERE visibility = 'always_show'
);

UPDATE data_source_page_layout_entries
SET visibility = 'hide_when_empty'
WHERE visibility = 'always_show';
