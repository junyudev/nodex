# Data Sources, properties, and saved Views

A Database contains Data Sources; a Source owns Property schema and member Page
values; a View saves presentation/query rules over one Source. These IDs are not
interchangeable. For Property definitions and saved View configuration, use
`nodex data-source configure --help`. For SQL syntax, complete-result semantics
and configuration workflows, read [queries-and-configuration.md](queries-and-configuration.md).

## Discover Source and View semantics

```sh
nodex sql query 'SELECT data_source_id,database_id,name,schema_revision FROM data_sources'
nodex sql schema tasks --bind tasks=SOURCE_ID
nodex sql query 'SELECT view_id,name,revision,config_json FROM views WHERE data_source_id=:source' \
  --param 'source="SOURCE_ID"'
nodex sql query 'SELECT occurrence_id,page_id,title,group_key FROM view_rows(:view) ORDER BY ordinal' \
  --param 'view="VIEW_ID"'
```

For questions about what a Board shows, use `view_rows`, which preserves saved
filters, grouping, hierarchy and manual ordering. Source SQL does not inherit
View rules. A View row is an occurrence; one Page can appear more than once.
Use `COUNT(DISTINCT page_id)` for distinct Pages. Discover `group_key` from actual
View output and select that value; it is not a free-form group display label.

`properties`, `property_options` and `property_values` support deeper schema/value
analysis. For ordinary queries use a bound Source's discovered Property columns.
Select `value_revision` from `property_values` before a short Property write:

```sh
nodex sql query 'SELECT value_json,value_revision FROM property_values WHERE page_id=:page AND property_id=:property' \
  --param 'page="PAGE_ID"' --param 'property="PROPERTY_ID"'
nodex page properties set PAGE_ID --data-source SOURCE_ID \
  --property PROPERTY_ID --option OPTION_ID --if-revision VALUE_REVISION
```

The short setter supports select, text and number replacements (`--option`,
`--text`, `--number`). For multiple edits or relation/set changes use
`page properties apply --input -` with its typed schema. Replacements carry
observed value versions. System-managed Properties use their owning operation.
For query-selected batches, use the four observation columns and prepare/apply
workflow in the linked query reference.

`page create-batch --input -` creates 1–16 Pages at an explicit destination in
one transaction. Drafts use `title_markdown`, `nested_markdown` and typed initial
`values`. Fetch its input schema for destination/value shapes. Failure rolls
back the whole batch. Save one key and exact input before a retryable submission.

## Board creation and movement

```sh
nodex page create --parent data_source:SOURCE_ID \
  --view VIEW_ID --group GROUP_KEY --title 'Ship beta' --empty
nodex page prepare PAGE_ID --operation move --view VIEW_ID
nodex page move PAGE_ID --to data_source:SOURCE_ID \
  --view VIEW_ID --group TARGET_GROUP_KEY --at end --if-match MOVE_ETAG
nodex page duplicate PAGE_ID --to data_source:SOURCE_ID \
  --view VIEW_ID --group TARGET_GROUP_KEY --at end
```

Use `validators.move_etag` from preparation. It binds the relevant grouping and
placement state. Choose one anchor: `--at`, `--before` or `--after`; use
`--unassigned` for an intended unassigned group. Core moves ownership, grouping
and position together. On a conflict, reread and reassess the intended move.
Keep the new identity after duplication. `nodex open view VIEW_ID` opens the View;
`--print` returns its canonical link.
