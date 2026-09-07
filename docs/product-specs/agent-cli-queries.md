# Agent CLI queries and configuration

## Scope and discovery

CLI resource selectors accept stable IDs directly without a prefix. Unique names
resolve inside the selected resource scope; ambiguity returns authorized stable
candidates. Page keys and title paths remain secondary selectors. Project context
comes from an explicit selector or the working directory, never from a Page ID.

`data-source list` and `view list` default to the Project's Database. An omitted
Source requires exactly one active Source; an omitted View uses the Project's
configured default View. Saved View queries retain saved filters, grouping and
ordering. A temporary Source query uses only its explicit rules.

Query results expose resource identity, titles, requested values and continuation.
`returned_count` is exactly the number of items in the response. A non-null cursor
requires continuation before treating the result as complete. Option discovery
contains IDs and names, not counts from an unrelated lifecycle or query scope.
Full View configuration belongs to `view describe`.

## Offline help

Machine help is a compact guide generated from command definitions. It omits
large schemas by default. `--help-schema input`, `result`, `error` and `all` are
offline JSON schema guides. Schemas derive from actual input/output types and
include accepted success-envelope inputs where piping is supported. Human help
and machine help share scope rules and examples. Invalid schema selectors report
the argument and allowed values; scope ambiguity reports authorized candidates.

## Public read-only SQL

The Database Module resolves bound Sources under the caller's existing Project
authority and observes every schema, membership, value and Relation target in
one Store read snapshot. It materializes complete public inputs in a disposable
in-memory SQLite database. User SQL never runs on the Store connection. Partial
materialization fails rather than producing incomplete aggregates or joins.

`sql schema` returns table/column names, Property identities, storage types and
select option ID/name mappings. The unique default Source is named `pages`.
`--source ID` selects that table explicitly; repeated `--bind TABLE=SOURCE_ID`
names multiple tables for joins. Source bindings are stable IDs. Columns include
`page_id`, `page_key`, `data_source_id`, `title`, `created_at`, `updated_at` and
active Properties. Unique Property names are quoted SQL columns; colliding names
use the spelling published by schema discovery. Select values contain option IDs.
Multi-select and Relation values are JSON arrays; inaccessible Relation targets
are null. SQL null represents absent scalar values.

`sql query SQL` or `--file FILE|-` accepts one read-only statement. Repeat
`--param NAME=JSON` for named scalar bindings. SQLite owns expression, null, sort,
collation, join and aggregation semantics. Results contain column names and rows;
select Page and Source IDs when results will drive semantic edits.

The SQL boundary denies writes, schema changes, attachment, extension loading and
private tables through an allowlisted authorizer and a read-only statement check.
Inputs have explicit limits: 16 Sources, 200 Properties per Source, 100 options
per Property, 100,000 rows and 16 MiB across inputs. Statements are at most 64 KiB
with 100 named parameters. Results are at most 10,000 rows and 8 MiB. Execution
is bounded by elapsed time and VM work. Exceeding a budget fails the whole query;
no apparently complete partial result is returned.

## Configuration scripts

`data-source configure [SOURCE] --input FILE|-` accepts a typed declarative JSON
script with an observed `if_schema_revision` and 1–100 operations. Operations add
or rename Properties, change types, add or rename select options, create Views,
and partially update Views. Schema/type changes obey the ordinary Database domain
constraints. Selectors resolve exact IDs before unique names within the Source.

`update_view` requires its observed `if_revision`. Omitted fields retain current
settings; empty sorts clear sorting and explicit null grouping clears grouping.
A script is one atomic Database mutation: later failure rolls back earlier steps.
Receipt replay precedes name resolution and revision validation, so a retry with
the same operation key and identical script returns the committed result even
after the script renames a referenced resource.

## Selected Property edits

`page properties prepare-batch --selection FILE|- --set NAME=JSON` accepts SQL
results selecting `page_id` and `data_source_id` exactly once. Alternatively
`--values FILE` supplies a map of typed Property values. Preparation deduplicates
target IDs, resolves Property names and captures each current value revision.
It is read-only and emits the canonical typed edits accepted by `properties apply`.
Both boundaries accept their documented raw input or the corresponding successful
CLI result envelope, allowing direct pipes without intermediate files.

The selection fixes identities; preparation observes current values. These are
separate observations. Applying the prepared batch never reevaluates SQL or a
filter. Every replacement binds its target and observed revision, and any conflict
rejects the entire atomic apply. To retry an uncertain result, retain the exact
prepared edits and operation key rather than preparing again.
