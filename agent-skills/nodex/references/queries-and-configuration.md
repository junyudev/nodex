# SQL, configuration, and selected changes

## Complete queries

Use SQL for aggregation, joins, and expressions. Discover only the needed Source
schema with `nodex sql schema`. With one Source in the default Database, it is
bound as `pages`; multiple Sources require `--source ID` or repeated
`--bind TABLE=ID`. SQL schema gives actual column spellings, Property IDs and
select option IDs/names. Select cells contain option IDs. Multi-select and
Relation cells are JSON arrays; use SQLite JSON functions for membership/joins.
Restricted Relation identities appear as null. Quote Property column names.

```sh
nodex sql query 'SELECT count(*) AS matched_count FROM pages'
nodex sql query 'SELECT page_id, title FROM pages WHERE "Status" = :status' \
  --param 'status="OPTION_ID"'
nodex sql query 'SELECT a.page_id, a.title, b.title FROM tasks a JOIN projects b ON a.title = b.title' \
  --bind tasks=TASK_SOURCE_ID --bind projects=PROJECT_SOURCE_ID
```

Queries run over complete authorized inputs at one Core snapshot; a budget
failure produces no partial result. Results contain `columns` and `rows`. SQL
is read-only; configure resources and edit values through semantic commands.
A normal paginated list is insufficient evidence for a complete aggregate.

## Atomic configuration

Read `data-source describe SOURCE_ID` for `schema_revision`; read `view describe`
for the target View's revision before updating it. A configuration script is
a typed JSON list of operations. Fetch `data-source configure --help-schema input`
for unfamiliar operations. All operations commit together or roll back.

```sh
nodex data-source configure SOURCE_ID --idempotency-key configure-risk-1 --input - <<'JSON'
{"if_schema_revision":1,"operations":[{"kind":"add_property","name":"Risk","schema":{"kind":"select"},"options":["Low","High"]},{"kind":"create_view","name":"Risk board","layout":"board","group_by":"Risk"}]}
JSON
```

Replace the example revision with the one observed. `update_view` takes `view`,
`if_revision`, and only the changes: omitted configuration stays intact, `sorts:[]`
clears sorts, and `group_by:null` clears grouping. Names resolve within the Source;
use returned IDs to disambiguate. An uncertain-result retry uses the same script,
revision and operation key, including after a rename. Conflicts require reassessment.

## Freeze a query into edits

Select `page_id` and `data_source_id` exactly once. Pipe the actual SQL result
to `prepare-batch`; it resolves requested Properties and captures current value
revisions. Its output is directly accepted by `apply`:

```sh
nodex sql query 'SELECT page_id, data_source_id FROM pages WHERE title = :title' \
  --param 'title="Release checklist"' | \
  nodex page properties prepare-batch --selection - \
    --set 'Risk={"kind":"select","option_id":"OPTION_ID"}' | \
  nodex page properties apply --input - --idempotency-key selected-risk-1
```

Use the discovered option ID. For review or uncertain-result recovery, retain
the prepared edits before applying and retry exactly that input with the same
key. Preparation is read-only. Submission uses fixed IDs and captured revisions;
it never reruns SQL or expands a WHERE clause. A conflicting edit rejects the
whole apply. The query and preparation are separate observations: selection
freezes identities, while preparation observes the values being replaced.
