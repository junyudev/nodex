# Agent CLI queries and configuration

## Scope and discovery

SQL is the primary Agent interface for discovering and reading authorized Nodex
content. `pages` always contains the selected Project's authorized active Pages,
including standalone Pages. A Page ID never changes the access Project. Named
Source bindings add Property columns without changing the meaning of `pages`.

```text
nodex sql schema [RELATION] [--bind ALIAS=SOURCE_ID ...]
nodex sql query SQL [--param NAME=JSON ...] [--bind ALIAS=SOURCE_ID ...] [--raw]
nodex sql query --file FILE|- [--param NAME=JSON ...] [--bind ALIAS=SOURCE_ID ...] [--raw]
```

Resource IDs need no prefix. CLI semantic resource selectors also accept their
supported unique names, Page keys or title paths. SQL uses the public columns
and supplied parameter values directly; a Page key is queried as `page_key`.
`--database` is only a schema discovery hint. It does not filter `pages` or
implicitly bind a Source. Bind Sources explicitly using stable IDs; aliases
cannot collide with built-in relations.

`sql schema` without a relation returns a compact catalog of purpose, row
identity and required arguments. Describing one relation returns its column
types, nullability, identity, ordering, examples and version fields. Describing
a bound Source additionally publishes exact Property column spellings, stable
Property IDs and select option IDs/names. Schema discovery does not require
loading Page bodies or values.

Offline command help remains progressive: ordinary machine help gives arguments
and examples; `--help-schema input|result|error|all` gives only the requested JSON
schemas. Human and machine help share command definitions. Unknown input fields
and invalid schema selectors fail explicitly.

## Public relations

| Relation                                                               | One row represents                                | Important columns or meaning                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages`                                                                | One authorized active Page                        | `page_id`, `page_key`, `title`, nullable `data_source_id`, timestamps, `title_etag`, `file_manifest_revision`, lazy `intrinsic_properties` JSON; no implicit body read |
| `page_documents`                                                       | One current Page body                             | `page_id`, `nested_markdown`, `body_etag`; one-to-one with Pages                                                                                                       |
| Bound Source, e.g. `tasks`                                             | One active member Page                            | `page_id`, `title`, `data_source_id`, `membership_revision`, `value_revisions`, Property columns                                                                       |
| `view_rows(VIEW_ID)`                                                   | One Page occurrence in a saved View               | `occurrence_id`, `page_id`, `group_key`, `subgroup_key`, `parent_occurrence_id`, `ordinal`; a Page can occur repeatedly                                                |
| `search_hits(QUERY, K)`                                                | One of the top K authorized Page search hits      | `page_id`, `title`, `snippet`, `ordinal`; Page identities are deduplicated                                                                                             |
| `databases`, `data_sources`, `properties`, `property_options`, `views` | One public resource                               | Identity, name, ownership and applicable configuration revisions; `schema_json` and `config_json` preserve domain configuration                                        |
| `property_values`                                                      | One active member Page/Property pair              | `value_json`, `value_revision`, `membership_revision`; unset values keep domain defaults and initial revisions                                                         |
| `page_relations`                                                       | One visible Source Page/Property/target Page edge | Restricted target identities are omitted; visible edge count is not a total relationship count                                                                         |
| `library_children`                                                     | One canonical navigation parent/child edge        | Typed parent/child IDs, title, `ordinal`; distinct from View hierarchy                                                                                                 |
| `page_files`                                                           | One deduplicated current Page/File use            | Nullable `path`, name, MIME, size, version, manifest/body-use revisions                                                                                                |
| `files`                                                                | One independently authorized File                 | Includes lifecycle, metadata revision and current head version                                                                                                         |
| `file_versions`, `file_usages`                                         | One retained version or authorized visible use    | Independent File access applies; inaccessible usage targets remain undisclosed                                                                                         |
| `page_history`                                                         | One retained Page history event                   | Stable event identity, time and public `event_json`; no promise of unretained history                                                                                  |

All SQL row ordering is explicit: use `ORDER BY`; natural scan order is not a
contract. View and search use their public `ordinal`, not physical rank.
`COUNT(DISTINCT page_id)` counts independent Pages in a View.

Source Property columns use unique display names where possible; collisions use
the stable spelling published by schema discovery. Quote discovered names.
Select cells contain option IDs, multi-select cells contain JSON arrays of
option IDs, and Relation cells retain the domain's restricted-target JSON
representation. Use `page_relations` for visible relationship joins. Text,
numbers, booleans and null retain fixed SQLite type mappings. JSON-valued columns,
including `value_revisions`, are JSON text suitable for SQLite JSON functions.

Page access authorizes current Page File metadata/bytes, not independent File
history or shared writes. Observe `pages.file_manifest_revision` for attachment
writes even when the Page has no current File uses; an empty `page_files` result
cannot determine a manifest version.

## Query results and lifecycle

The Core Query Module combines domain-owned reads under one authorization
snapshot. User SQL executes against public virtual relations, never the private
Store connection. Domains retain their own content, authorization and ordering
rules. The CLI transports a query rather than assembling per-Page reads.

A successful structured result contains `columns`, `rows`, `returned_count` and
`snapshot`. The count is exactly the output row count. Snapshot is an opaque
observation identifier, not a write validator or a resumable session. Parameters
are named JSON scalars. One UTF-8 statement may be supplied directly, from a file
or from stdin.

`--raw` accepts exactly one row and one non-null text column, emits its UTF-8 bytes
unchanged, and adds no newline. Empty text is valid; empty results, multiple
cells, null and non-text scalars fail. Explicit JSON output conflicts with raw.

Queries are read-only, complete or failed, and bounded by input, output, elapsed
time and execution-work budgets. Facts and View results are not pre-truncated.
A caller's SQL `LIMIT` is part of its query semantics; internal budget exhaustion
fails the whole query. Writes, private tables, schema changes, attachment and
extension loading are unavailable. Body columns are read on demand; an indexed
Page identity lookup and a metadata-only query avoid unrelated body loading.

There are no SQL cursors or long-lived snapshot sessions. Separate
`LIMIT/OFFSET` calls are separate observations and cannot establish a consistent
large export. `read PAGE` remains a single-Page convenience with canonical text
and reusable validators; `ls`, `tree`, `sed`, `history` and `rg` retain their
terminal-specific roles. `search` remains a bounded ranked search convenience. It returns Page ID,
current key, title, location, and concise matching evidence with Block/Property
provenance; repeated title/highlight structures and unrelated Properties are
omitted. Full Page content remains available through `read` or SQL.

## Search composition

`search_hits(QUERY, K)` reuses Nodex's Page search engine, including indexed
metadata, Page keys, body FTS and ranking. It returns the top K Page hits under
the current query observation; it does not load all bodies and search them with
`LIKE`. K follows the search command's bounds.

Outer SQL conditions run **after** top-K retrieval. Filtering those 20 hits by
Status is different from searching only that Status for its best 20 hits.
`COUNT(*) FROM search_hits(:query, 20)` counts returned hits, never all matches.
No complete-match relation or oversized-K workaround is part of this contract.
A repeated join over one non-correlated search invocation reuses its results.

```sql
SELECT s.page_id, s.title, s.snippet, d.nested_markdown
FROM search_hits(:query, 5) AS s
JOIN page_documents AS d USING (page_id)
ORDER BY s.ordinal;
```

## Configuration scripts

Read `data_sources.schema_revision` and `views.revision` for configuration
conditions. `data-source configure [SOURCE] --input FILE|-` accepts a typed JSON
script with `if_schema_revision` and 1–100 operations. Operations add or rename
Properties, change types, add or rename options, create Views and partially
update Views. Domain constraints remain authoritative. IDs resolve before unique
names within the Source.

`update_view` requires `if_revision`; omitted fields retain settings, empty sorts
clear sorting and null grouping clears grouping. A script is one atomic mutation.
Receipt replay precedes name resolution and revision validation, so identical
retries retain their result after a referenced resource has been renamed.

`create_view` and `update_view` accept `filter` using the Core-owned View
clause/group expression and Property-typed operators. `propertyId` resolves an
exact active Property ID or unique name in the target Source. Select operands
resolve option IDs before unique names within that Property; multi-select
operands are arrays. Other operands retain the shared View grammar, including
stable Page IDs for relation membership. Missing or ambiguous selectors fail.

The input is a complete saved filter: it replaces both quick Property filters
and the advanced tree. An omitted update field preserves both; `filter:null`
clears both. A single clause is stored in an AND group. The operation changes
the durable shared View definition and preserves unrelated rules, presentation,
identity, manual order and personal preferences. It does not publish or reset
personal overrides.

Configuration requires complete conditions. Empty groups, incomplete values,
invalid operators or incompatible value types reject the whole script rather
than storing inactive filter drafts. The existing Core expression limits,
Property capabilities, authorization and revision checks apply. Creation and
filtering commit together, and a failure leaves neither a partial View nor
earlier script changes. `view_rows(VIEW_ID)` reads actual saved View results for
verification; a transient SQL WHERE clause does not create a saved filter.

## Observed Property edits

`page properties prepare-batch --selection FILE|- --set NAME=JSON` requires
exactly one each of `page_id`, `data_source_id`, `membership_revision` and
`value_revisions` in the SQL result. Additional columns are accepted. `--values
FILE` alternatively supplies the typed replacement map. Each requested Property
must have an observed version, including an explicit initial version when unset.

Preparation resolves current Source schema to identify named Properties but
preserves the selected membership and value versions. It never refreshes those
conditions from current Page values. Identical repeated Page/Source conditions
may deduplicate; conflicting observations fail. Preparation is read-only and
emits the typed edits accepted by `page properties apply --input FILE|-`.
Both accept their documented raw input or corresponding successful CLI envelope.

```sh
nodex sql query 'SELECT page_id,data_source_id,membership_revision,value_revisions FROM tasks WHERE "Status"=:status' \
  --bind tasks=SOURCE_ID --param 'status="OPTION_ID"' |
  nodex page properties prepare-batch --selection - --set 'Priority={"kind":"number","value":1}' |
  nodex page properties apply --input - --idempotency-key priority-update-1
```

Apply rechecks current authority, schema, membership and value conditions in one
atomic operation. A change between query and preparation remains a conflict.
Conditions protect membership and **edited fields**, not arbitrary SQL predicates
or JOIN dependencies. Selecting by Status and changing only Priority does not
lock Status. SQL UPDATE and generic query-dependency locking are not supported.
Save the exact prepared edits and idempotency key before retryable writes.

Title/body writes reuse `pages.title_etag` and `page_documents.body_etag` directly.
Move/delete preparation is explicit: `page prepare PAGE --operation move|delete
[--view VIEW_ID]`; View scope applies only to move. Ordinary content reads do not
prepare unrelated lifecycle operations.
