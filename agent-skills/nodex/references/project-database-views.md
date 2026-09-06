# Data Sources, properties, and saved Views

A Database contains Data Sources; a Data Source owns its Property schema and
Page row values; a View saves a presentation/query over one Data Source. These
IDs are not interchangeable. Discover actual identities, types, and options
before constructing unfamiliar queries or edits. Reuse current schema context.

## Discover and query

```sh
nodex data-source list --database DATABASE_ID
nodex data-source describe @DATA_SOURCE_ID
nodex data-source options @DATA_SOURCE_ID --property PROPERTY_ID
nodex data-source query @DATA_SOURCE_ID --input - <<'JSON'
{"filter":{"kind":"group","operator":"and","children":[]},"sort":[],"limit":50}
JSON
```

Use the actual typed filter/sort and projection schema from machine help.
Omitting property projection requests the default values; an empty projection
requests no property values. Lists, schema, options, and query results are
bounded windows: continue using returned opaque cursors. Reuse the same query
with `--after CURSOR`; changed query or access conditions can invalidate cursors.
Use stdout, pipes, or subprocess results directly for computation; save files
only when the workflow needs persistent or repeated processing.

A temporary query never changes a saved View or inherits its filters/grouping.
Use the saved View itself for questions about what the user's Board shows:

```sh
nodex view query @VIEW_ID --limit 50
nodex view query @VIEW_ID --group STABLE_GROUP_KEY
nodex view query @VIEW_ID --after OPAQUE_CURSOR
```

Follow each result's declared pagination shape. Labels are presentation;
stable group keys and Page IDs drive mutations.

## Update properties

```sh
nodex page properties get @PAGE_ID
nodex page properties set @PAGE_ID --data-source DATA_SOURCE_ID \
  --property PROPERTY_ID --option OPTION_ID --if-revision VALUE_REVISION
```

The short setter supports schema-checked select, text, and number replacements.
Use `--text` or `--number` in place of `--option` for those types. Data Source
can be omitted only when the Page identifies its source unambiguously.

For multiple edits, complex values, or relation/set changes, use
`page properties apply --input -` with the typed input from machine help.
A replacement carries the current value revision. Relation and multiselect
changes use their own declared mutation kinds. One apply is atomic; separate
CLI processes are separate commits. System-managed properties cannot be set
through an ordinary value edit.

`page create-batch --input -` creates 1–16 Pages at one explicit destination in
one transaction. Drafts use `title_markdown`, `nested_markdown`, and typed
initial `values`. Use the command schema for the destination and value shapes.
A failing draft rolls back the whole batch. For resumable writes, save one key
and exact input before submitting, rather than regenerating them after failure.

## Board creation and movement

```sh
nodex page create --parent data_source:@DATA_SOURCE_ID \
  --view @VIEW_ID --group STABLE_GROUP_KEY --title 'Ship beta' --empty
nodex page move @PAGE_ID --to data_source:@DATA_SOURCE_ID \
  --view @VIEW_ID --group TARGET_GROUP_KEY --at end --if-match MOVE_ETAG
nodex page duplicate @PAGE_ID --to data_source:@DATA_SOURCE_ID \
  --view @VIEW_ID --group TARGET_GROUP_KEY --at end
```

Obtain the move ETag from a current View row or
`nodex --json read @PAGE_ID --prepare page.move --view @VIEW_ID`. It binds the
relevant grouping and placement state. Use one placement anchor: `--at`,
`--before`, or `--after`. Use `--unassigned` only for an intended unassigned group.
Core moves ownership, grouping, and position together; do not simulate this
with a property change followed by a second ordering write.

On a conflict, reread the affected state and decide whether the original move
still makes sense. Keep the returned new identity after duplication. Use
`nodex open view @VIEW_ID` to open the View, or add `--print` to return its link.
