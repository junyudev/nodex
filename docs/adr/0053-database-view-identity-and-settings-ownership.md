# ADR 0053: Database Views own one layout and configure beside their content

- Status: Accepted
- Date: 2026-08-29
- Supersedes in part: ADR 0041 (Database View layout and personal preference)

## Context

Nodex presented Board and List as peer tabs while storing them as two layouts of one durable
Database View. Clicking either tab changed a Profile-local layout preference without changing the
View identity. The UI therefore described two Views while deep links, names, rank, settings, and
Core authority described one View. A centered Database manager compounded the mismatch by mixing
View identity, View presentation, Data Source schema, and Page presentation in one detached form.

The same term, Property visibility, also covered two different jobs. A View decides which
Properties appear in its Board cards or List rows. A Data Source decides how schema Properties
appear when any Page is opened. These choices have different owners and must not mutate one
another.

## Decision

Each user-visible View tab is one durable Database View identity. A View targets exactly one Data
Source and owns one current layout, Board or List. Layout is a discriminant of the View's durable
presentation and cannot be changed by a Profile-local preference. Changing the layout through View
settings preserves the View identity, keeps layout-neutral query and presentation fields, and
replaces layout-specific configuration explicitly.

A View Preference is one revision-fenced Profile-local envelope with two independently sparse
patches over fields that do not alter View identity. The rules patch owns quick filters, the
advanced filter tree, and Sort order; the presentation patch owns grouping, subgrouping,
completion, hierarchy, displayed Properties, and settings for the View's current layout. View
name, target Source, layout, rank, lifecycle, and default status are always durable. Publishing
writes selected normalized effective rules or presentation through the View revision contract and
removes only the published patch after the durable commit is observed.
The renderer carries the published effective definition in its receipt-fenced
View journal until a canonical read materializes that commit. A personal-state
event may therefore clear the persisted patch early without exposing the older
durable View for an intermediate frame.

View Property display and Data Source Page layout are separate contracts. View display owns the
ordered fields shown in one View. Data Source Page layout owns schema Property order and one of
`always_show`, `hide_when_empty`, or `always_hide` for all Pages in that Source. It does not own
Page capabilities such as Files or Linked chats.

Database configuration is edited beside or directly below the current Database chrome. Filter and
Sort share one View-owned inline rule bar below the tabs; layout and display, Data Source
Properties, and Data Source Page layout use the feature-owned settings rail. The rail is nested
inside the Database surface and does not take ownership of the Workbench's user-controlled global
side panel. Toolbar shortcuts call the same rule-bar or rail controller as their inline surface;
they do not maintain parallel configuration state.

Data Source Property management remains Database Core authority. Core reports typed schema,
lifecycle, dependencies, and management policy; renderers do not infer protected system roles from
display names. Option color, View conditional color, and layout decoration remain separate
concepts. UI does not expose capabilities that lack a durable contract.

Existing Stores migrate each legacy View into Board and List sibling Views. The sibling matching
the legacy durable layout keeps the original identity and default references; the other receives a
new global identity. Layout-specific presentation is split between them and the old personal
layout selector is discarded. This repository has no production user data, so the migration
prioritizes the coherent durable model over a long-lived compatibility layer for the former
selection state.

## Consequences

View tabs, deep links, Window Scene targets, names, order, and settings now share the same identity.
Board and List may still reuse one View runtime, projection contracts, manual rank, Page opening,
and semantic mutation adapters; this decision does not duplicate those Modules.

A fresh Project Scene still resolves its protected primary through the symbolic Project default.
Once the user selects another View, the Scene stores that exact View target so restart does not
silently replace an explicit selection after the Project default changes. Primary protection comes
from the surface's owner role and placement, not from keeping its target permanently symbolic.

The durable View configuration stores only the active layout branch. Rust and TypeScript can reject
Board-only settings in a List View and vice versa. A layout conversion is an explicit mutation
rather than a personal toggle.

Personal edits still converge across windows and can be published or reset, but can no longer
change which View tab the user is on. Grouping remains a projection of Source Property values and
manual rank remains View-global, as established by ADR 0041.

Page layout requires a new Data Source-owned revision and Store relation. A newly created Property
is appended and shown by default; soft deletion retains its layout placement for restoration.

The former centered Database manager and standalone Filter, Sort, and Display configuration paths
are removed. Filter and Sort authoring moves to the inline rule bar; remaining View and Source
settings move to the rail. Database selection remains Workbench/Library navigation; each surface
configures only the Database currently in context.

## Preserved decisions from ADR 0041

This ADR does not supersede the unified View-scoped runtime, global manual Page rank, normalized
Core effective presentation, completion semantics, bounded grouping, Board/List presenter
convergence, List disclosure authority, or semantic Page movement. It supersedes only the
multi-layout durable shape, Profile-local layout selection, and the identity interpretation built
on them.
