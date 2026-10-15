# ADR-0039: Data Source Relation Properties and typed Property semantics

- Status: Accepted
- Date: 2026-08-04
- Owner: Database Module

## Context

Data Source Properties previously stored every value as `value_type + value_json` and exposed schema and mutation behavior as strings plus generic JSON. That is sufficient for scalar and option-backed values, but not for Page-reference sets: JSON arrays cannot enforce target identity, support indexed reverse lookup, provide closure-aware retention evidence, or project lifecycle-validated summaries without repeated Page reads.

## Decision

The Database Module owns a first-class `relation` Property schema bound to one target Data Source in the same Library and an immutable `one | many` cardinality. A many-value Relation is an unordered unique set of stable Page IDs; a one-value Relation is nullable and has at most one edge. Relation is a non-owning, non-authorizing, one-way edge; it never changes Page parent, membership, Document ownership, or content access. Self-relations are valid, and names such as `Blocked By` do not imply DAG validation.

Authority is normalized into `data_source_relation_properties` and `data_source_relation_edges`. `data_source_property_values` retains only the value revision header with a JSON `null` sentinel, including for an empty one-value Relation. Target Page IDs exist only in the edge table. Deferred `NO ACTION` foreign keys, cardinality validation, reverse indexes, readiness checks, retention analysis, copy behavior, and projection-impact expansion make that authority fail closed.

The Database contract uses tagged Property schema, Core-derived query/presentation capabilities, and a cardinality-specific Relation mutation grammar. A one Relation accepts only revision-fenced zero-or-one target replacement. A many Relation accepts idempotent add/remove edge patches and a separate revision-fenced whole-set clear; it rejects single-target replacement, while a one Relation rejects set patches. Mutation legality therefore comes from Property schema instead of misleading generic `replace` or `patch member` capability flags. Patch removal and every non-empty replacement validate target Page identity, Source membership and lifecycle in the current Library; the explicit many-Relation clear can remove values whose targets are physically unavailable. Full values use a bounded keyset window whose signed cursor stores only an ordinal and a constant marker, never a target Page ID. Row and Page Detail reads expose the first three available targets, exact total/unavailable counts, and `has_more`; missing, deleted or cross-Library targets expose no nonexistent metadata. Project placement never filters Relation targets.

Every Data Source has a fixed `task_parent` cardinality-one self-Relation. It is the sole task-hierarchy authority: a child edge targets its parent and alone may carry sibling-rank metadata, while roots retain an empty positive revision header. The high-level `set_task_parent` command is an atomic ordered-run policy over the same Relation values, not another storage model. It adds active same-Source endpoint checks, cycle and depth limits, sibling ordering, and batch compare-and-swap. Generic Relation editing reaches the same policy when it addresses `task_parent`. Parent and rank update atomically on a moved child. A shared fractional ordered-run planner assigns local ranks; order-preserving rank maintenance on untouched siblings changes only the physical encoding and never advances their Relation value or Page metadata revisions. Repeating an already-satisfied ordered run is a no-op. Removing a membership clears its own Parent edge, promotes direct children to roots, and advances all affected Relation revisions. Archiving retains the edge for restoration while active View projections ignore an edge whose endpoint is archived. Copying a Page copies ordinary Relation edges but starts the copy as a task root.

Source-defined Page metadata writes use those same Database intents. Intrinsic Page metadata remains owned by the Library Block Property kernel. When one Page Detail action changes both scopes—for example scheduled timestamps plus all-day/timezone—the Library v9 `apply_page_metadata_properties` command composes only Database value edits for exactly the same non-empty Page set as the intrinsic fields, inside one SQLite transaction and one outer idempotency boundary. It rejects a pre-existing independent Database receipt for the operation ID and folds Database revision/resource evidence into the Library receipt. It does not reintroduce Source-defined semantics into Block Property Mutation.

Relation supports `contains`, `not_contains`, `is_empty`, and `is_not_empty`. It is not sortable or groupable. Database View authoring consumes Core capabilities. Relation filter Page operands retain current target identity and lifecycle checks whenever a View descriptor, window, context, or group summary is read. Complete target reads and source-scoped candidate search are separate bounded Database reads; the renderer never derives a complete candidate set from the current View or hydrates candidates Page by Page. The Database manager obtains target Sources from the current Library's paged Database catalog.

## Consequences

- Reverse lookup, target integrity, lifecycle recovery, copy, retention, task nesting, and future reciprocal/rollup work reuse one canonical edge authority.
- A new Property kind changes one exhaustive Core semantics layer, generated protocol, and presentation instead of parallel mutation interfaces.
- Mixed Page metadata saves gain an upper Library transaction while each lower kernel remains the sole owner of its semantics.
- CLI Page metadata carries a bounded Relation summary instead of requiring a complete target list, so unavailable or long values do not make an otherwise readable Page fail.
- Reciprocal fields, rollups, formulas, and arbitrary user-defined DAG/cycle constraints remain separate future decisions.

## Rejected alternatives

- Page ID arrays in `value_json`: no target FK, reverse index, bounded complete read, or reliable retention evidence.
- A separate Relation/Reference Graph Module: Relation writes share Data Source schema, membership, revision, receipt, and authorization transactions.
- A separate task-hierarchy table: it duplicates Page-reference identity and revisions, makes generic Relation and List edits diverge, and creates ambiguous lifecycle cleanup.
- Paired forward/inverse edge values: creates two authorities and recovery ambiguity.
- Inferring graph rules from display names: names are mutable presentation, not schema semantics.
