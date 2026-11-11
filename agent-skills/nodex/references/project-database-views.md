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

`properties`, `property_options` and `property_values` support schema and value
inspection. SQL columns use the Source’s current Property display names.

```sh
nodex page properties set NODEX-4 NODEX-8 --set Status=done --set Priority=p1-high
```

Set several Properties and Pages together. Use `--clear PROPERTY` to clear a
value. Use current exact names or stable IDs for Properties and options. For one
observed value, `--if-revision` optionally fences the write. Use `apply` for
heterogeneous fenced edits or Relations.

Owner and Assignee belong to the Page and share its intrinsic `work` revision.
Use `nodex members list` to discover people or `nodex members me` for the local
person. Set `--owner me|member:<id>` and
`--assignee me|member:<id>|agent:<instance>/<model>[/<effort>]|none` with
`page properties set PAGE_ID --if-revision WORK_REVISION`. These flags can be
combined with each other. Omit `--if-revision` to use the command's own observed
Page work revision, or supply an observed revision to fence an earlier decision.
Source `property_values` revisions do not apply to these fields. An Agent
Assignee is required to start work. `--auto-start true|false` sets whether it starts
on its own once its prerequisites are Done; set it only when the person asked.
Changing the assignment revokes that consent, so set it again in a separate command.

`page create-batch --input -` creates 1–16 Pages at an explicit destination in
one transaction. Drafts use `title_markdown`, `markdown` and typed initial
`values`. Fetch its input schema for destination/value shapes. Failure rolls
back the whole batch. Save one key and exact input before a retryable submission.

## Board creation and movement

```sh
nodex page create --parent data_source:SOURCE_ID \
  --view VIEW_ID --group GROUP_KEY --title 'Ship beta' --empty
nodex page prepare PAGE_ID --operation move --to data_source:SOURCE_ID --view VIEW_ID
nodex page move PAGE_ID --to data_source:SOURCE_ID \
  --view VIEW_ID --if-match MOVE_ETAG
nodex page duplicate PAGE_ID --to data_source:SOURCE_ID \
  --view VIEW_ID --group TARGET_GROUP_KEY --at end
```

Use `validators.move_etag` with the same destination and View used to prepare
the move. The prepare command observes the default placement. Use a move without
`--if-match` when specifying a group or position separately.
For an unfenced batch, pass the Page selectors together and omit `--if-match`.
Verify membership and Properties in the destination Source. Choose one of
`--at`, `--before`, or `--after` to set the position. Omitting the group
keeps a valid carried value or uses the destination default. Use `--unassigned`
for an explicitly empty group on a Property that allows empty values. Core moves
ownership, grouping and position together. On a conflict, reread and reassess the intended move.
Keep the new identity after duplication. `nodex open view VIEW_ID` opens the View;
`--print` returns its canonical link.
