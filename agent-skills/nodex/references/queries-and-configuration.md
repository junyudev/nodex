# SQL reads, configuration, and observed edits

## Read with SQL

Use SQL by default for discovery, Page bodies, filtering, joins and aggregation.
If the public model is unfamiliar, start with `nodex sql schema`, then describe
only the relation you need. `pages` means all authorized active Pages, including
standalone Pages. `--database` hints schema discovery; it never filters `pages`.
Source Property queries require explicit `--bind ALIAS=SOURCE_ID`.

```sh
nodex sql schema page_documents
nodex sql query 'SELECT page_id,title FROM pages WHERE title LIKE :title' \
  --param 'title="%release%"'
nodex sql query 'SELECT page_id,nested_markdown,body_etag FROM page_documents WHERE page_id=:id' \
  --param 'id="PAGE_ID"'
nodex sql schema tasks --bind tasks=SOURCE_ID
nodex sql query 'SELECT t.page_id,t.title,d.nested_markdown,d.body_etag FROM tasks t JOIN page_documents d USING(page_id) WHERE t."Status"=:status ORDER BY t.page_id LIMIT 10' \
  --bind tasks=SOURCE_ID --param 'status="OPTION_ID"'
```

Replace placeholders with discovered IDs. Source schema publishes exact Property
column spellings and select option IDs/names. Quote column names. Select values
are option IDs; multi-select values are JSON arrays of IDs. JSON columns are
text; use SQLite JSON functions for composition. `page_relations` exposes visible
Relation edges; restricted targets are omitted and visible counts are not totals.

Results contain `columns`, `rows`, `returned_count` and `snapshot`. Each query is
one observation; count means returned rows only. Snapshot is not a write guard
or a resumable session. Query results are complete or fail their budget. A caller's
`LIMIT` limits the answer; repeated queries with OFFSET do not share a snapshot.
Use `--file FILE|-` for substantial SQL. Named parameters are JSON scalars.

For exact Markdown stdout, select only `nested_markdown` and add `--raw`. Raw
requires one non-null text cell and adds no newline; explicit JSON conflicts.
`read PAGE_ID` remains useful for a simple single-Page read. Use body/title ETags
from SQL when preparing subsequent replacement/rename operations.

## Compose search

`search QUERY --limit K` remains a convenient ranked search. In SQL,
`search_hits(QUERY,K)` returns the same top-K Page hits before outer filtering:

```sql
SELECT s.page_id,s.snippet,d.nested_markdown
FROM search_hits(:query,5) s
JOIN page_documents d USING(page_id)
ORDER BY s.ordinal;
```

Filtering these five results is not searching inside that filter. COUNT over
search hits is not a total match count. Use `ORDER BY ordinal` to preserve rank;
fetch complete bodies before editing them. `rg` serves exact regex workflows.

## Atomic configuration

Read `data_sources.schema_revision` and the target `views.revision` for observed
conditions. Fetch `data-source configure --help-schema input` for unfamiliar
operations. A script commits all operations together or rolls them all back.

```sh
nodex sql query 'SELECT data_source_id,name,schema_revision FROM data_sources'
nodex data-source configure SOURCE_ID --idempotency-key configure-risk-1 --input - <<'JSON'
{"if_schema_revision":1,"operations":[{"kind":"add_property","name":"Risk","schema":{"kind":"select"},"options":["Low","High"]},{"kind":"create_view","name":"Risk board","layout":"board","group_by":"Risk"}]}
JSON
```

Replace the revision with the one observed. `update_view` takes `view`,
`if_revision`, and changed fields: omissions retain settings, `sorts:[]` clears
sorts, and `group_by:null` clears grouping. Names resolve within the Source;
use returned IDs to disambiguate. Retry the same script and key after an uncertain
response, including when the script renamed a resource.

## Preserve query observations for batch edits

Select all four observation columns. Preparation resolves Property names using
schema and carries the original versions forward; it never refreshes versions.

```sh
nodex sql query 'SELECT page_id,data_source_id,membership_revision,value_revisions FROM tasks WHERE title=:title' \
  --bind tasks=SOURCE_ID --param 'title="Release checklist"' |
  nodex page properties prepare-batch --selection - \
    --set 'Risk={"kind":"select","option_id":"OPTION_ID"}' |
  nodex page properties apply --input - --idempotency-key selected-risk-1
```

Missing observed versions fail; reread and reassess rather than supplying guessed
versions. A conflicting repeated target also fails. Apply uses fixed targets and
checks membership plus edited-field versions atomically. It does not rerun SQL.
Changing an edited field after SQL but before preparation remains a conflict.

These guards do not protect every WHERE/JOIN dependency: selecting by Status and
editing only Priority does not lock Status. Retain prepared edits and their key
for review or response-loss recovery; retry exactly that input, not a new prepare.
