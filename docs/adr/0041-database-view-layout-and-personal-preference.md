# ADR 0041: Database Views use Board and List layouts with personal presentation preferences

- Status: Superseded in part by ADR 0053
- Date: 2026-08-11
- Owners: Nodex maintainers
- Supersedes in part: ADR 0003 and ADR 0029

## Context

Nodex exposed Board, Table, toggle-list, and Calendar as peer View identities even though they represented different jobs and renderer paths.
The model made layout switching copy query state, gave the default Board capabilities that other saved Views could not use, and mixed durable View configuration with Project-local presentation preferences.

## Decision

A Database View is one durable named query with one default presentation and a stable View identity.
ADR 0053 supersedes the original multi-layout rule: each View now owns exactly one Board or List
layout, and each visible View tab selects one durable View identity. An explicit layout conversion
preserves the View identity while replacing layout-specific settings.
Filter and manual order are durable View authority.
Presentation choices such as grouping, subgrouping, sorting, completion visibility, empty groups,
displayed fields, and Filter may be stored as a sparse Profile-local override keyed by View ID;
layout may not.
Completion visibility is derived from a membership-scoped `completed_at`, maintained by canonical workflow-status transitions rather than inferred from Page update time.
Until Profile timezone becomes durable Core input, completion ranges use UTC calendar-day boundaries so one cursor chain observes a stable temporal query boundary.
Reset removes that override, while Set as view default publishes the effective presentation through the View revision contract and clears the override only after the durable write is observed.

Manual rank is global within a View and independent of grouping.
Grouping and subgrouping are projections of Source Property values, so a personal grouping override never creates another position authority.

The existing Table and top-level toggle-list presentations are retired in favor of a dense task List.
Legacy Database Calendar Views migrate to List.
Recurrence, reminders, occurrences, and future schedule work remain separate Page and Schedule capabilities rather than Database layouts.

## Consequences

Every saved View uses the same View-scoped data runtime without a default-View identity branch.
Layout presentation remains explicit: the established Status Board presenter is retained, List has its own dense row presenter, and capability-specific Board configurations use an advanced fallback only when the established presenter cannot express them.
Personal Filter and display changes do not alter the shared query until explicitly published.
The Core must resolve and fingerprint the effective presentation for grouped and sorted windows instead of reordering paged rows only in the renderer.
Editor toggle-list Blocks remain independent outliner/reference features and are not removed by this decision.

## Implementation result

Store schema v112 historically migrated durable Views to Config v3 and `default_layout` and added membership completion timestamps; v113 migrated manual positions to one `(view_id, page_id)` rank. ADR 0053's Store migration later split those layout branches into single-layout sibling View identities.
Core groups and windows resolve the same normalized effective presentation, including Profile-local typed overrides, subgroup paths, completion ranges, and the 200-combination finite-group bound.
Workbench Scene and Session View persist only durable View identity; layout comes from that View's effective presentation and is never copied into a tab descriptor.
Every default or saved View shares effective-presentation authority, selection handoff, pagination, Page opening, and drag/move compilation across Board and List.
Canonical Status grouping adapts those contracts into the established Board Column/Card UI instead of replacing that presenter; subgroup or otherwise unsupported Board configurations use the generic fallback.
