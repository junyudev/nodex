# ADR 0043: Database-scoped Page keys are human aliases over stable Page identity

- Status: Accepted
- Date: 2026-08-08
- Owners: Nodex maintainers
- Extends: ADR 0017, ADR 0020, ADR 0040

## Context

Page and Block UUIDs are appropriate canonical identities for ownership,
Documents, execution identity, history, View positions, and future synchronization.
They are poor coordinates for a person or Agent referring to one work item in
conversation. A short key such as `LAB-13` should make a Page easy to scan,
copy, search, and resolve without becoming a second primary key.

Project cannot own this alias. Project is an execution context and may be
archived or removed without deleting its primary Database or Pages. Data Source
and View are also the wrong scope: moving a Page among Sources or Views inside
one Database must not change the Page's everyday reference.

A local-first alias also needs an explicit allocation boundary. Nodex currently
has one exclusive SQLite writer per Profile, so it can allocate a monotonic
per-Database number transactionally. This does not imply that unrelated offline
replicas can mint one globally ordered sequence without future coordination.

## Decision

Nodex keeps `pageId`/`blockId` as the only canonical Page identity. A **Page
key** is a secondary locator in the canonical form `PREFIX-N`, where `PREFIX`
is 2–8 ASCII uppercase alphanumeric characters beginning with `A-Z`, and `N`
is a positive decimal integer without leading zeroes. Search and CLI selector
boundaries may normalize case, one optional leading `#`, outer whitespace, and
no-hyphen shorthand; stored and projected output is always canonical. Compact
input may produce more than one candidate and is never resolved by guessing.

An enabled Database owns one Page-key namespace. Its authority consists of:

- one namespace row with an explicit `next_number` and revision;
- one Library-unique registry of current and retained prefixes; and
- immutable `(database, page) -> number` assignments, unique by both Page and
  number inside the Database.

Project creation always enables this namespace for the Project's primary
Database. Project settings call its current prefix the **Page key prefix**;
Project remains only the normal configuration entry point and does not own the
counter, prefix registry, or assignments. Ordinary standalone Databases remain
without a namespace until a separate enablement decision is introduced.

The Database Module exposes the namespace through typed preview and namespace
reads plus a revision-fenced rename intent. Workspace accepts an initial prefix
only inside Project creation, where Project and primary Database genesis already
form one aggregate transaction. Existing-prefix reads and renames never travel
through Project projection or `UpdateProject`; Project UI is a coordinate
Adapter from the Project's primary Database to the Database Module. Prefix-only
changes therefore do not advance Project binding revision.

Allocation occurs in the same immediate Core transaction as Page genesis or
Database membership. Core checks for an existing assignment first; otherwise
it inserts the current `next_number`, advances the counter with checked integer
arithmetic, and commits assignment, membership, receipt, event, and affected
projections together. Committed operation replay returns the original
assignment and never consumes another number. Numbers are monotonic with gaps
and are never reclaimed after archive, delete, move, or failed post-commit
delivery.

Assignment lifecycle follows the Database boundary:

- changing View, group, column, or Data Source inside one Database preserves
  the Page key;
- leaving a Database retains its assignment but produces no current key while
  the Page is outside an enabled Database;
- entering another Database allocates or reuses that Database's assignment,
  while the old key remains a historical locator;
- returning to a previous Database restores the Page's previous number;
- duplication and recurrence cloning create a new Page identity and therefore
  allocate a new number;
- archive and restore preserve the assignment; delete tombstones do not release
  it.

Renaming a Project does not rename its prefix. An explicit prefix change is a
revision-fenced Database mutation. The retired prefix records the last number
that existed while it was active, the new prefix becomes current, and the
namespace counter continues. Historical lookup accepts only the retired
prefix's recorded range, so a future number cannot acquire an alias that never
existed. An unused prefix may be released before the first number is allocated;
once used, a prefix remains reserved in its Library.

Create Project does not expose Page-key configuration or perform a prefix
preview. When no explicit prefix is supplied by a non-UI caller, the aggregate
transaction derives a collision-free prefix from the Project name using the
same allocator that owns namespace creation. Before an existing prefix changes,
Edit Project reads the assigned Page count and retained history so it can
explain whether the old prefix is released or remains a permanent historical
locator.

Core is the only formatter and resolver. TypeScript may normalize an unfinished
draft for presentation and index Core-authored current keys for bounded local
search, but it does not decide prefix availability, suggest a final prefix, or
format mutation authority. Lookup expands every canonical
candidate against the Library prefix registry and assignments, deduplicates by
Page, then Core validates current Library identity and resource lifecycle.
An explicit Database selector may filter candidates; Project placement cannot
limit lookup. Only then may a unique selector return
`resolved`, `ambiguous`, or `not_found`; an ambiguous outcome carries no Page
metadata. Search surfaces may show every available candidate in the current Library.
Page keys are locators, not execution credentials; a missing or deleted Page
returns no metadata.

Current Page keys are projected into Database rows, contextual Page Detail,
search results, CLI output, and Agent results. Internal mutations, React keys,
Document identity, View position, cursors, NFM owning tags, references, and
canonical `nodex://pages/<pageId>` links continue to use UUIDs. Agent writes
remain UUID-only: the Agent resolves a Page key through search, then uses the
returned `pageId`. The CLI may accept a Page key at its human selector boundary
and resolve it before calling the same UUID-based Core mutation.

Every Project View includes the intrinsic Page-key field in its default List
presentation and omits it from its default Board presentation. The UI labels
this readable field **ID**; the canonical Page UUID is not a View display field.
This presentation name does not change the domain terms Page key and Page ID. A
Profile-local View Preference may change either layout through the same sparse
display-field override used by other optional fields, and publishing the
effective presentation may make that choice the shared default. When enabled,
a Board card places the key as quiet metadata at the top of the card; Page Stage
does not repeat the contextual Database alias; List derives one stable identity
slot from the current projection's prefixes and number depths; command-palette
and picker rows use one compact identity slot. Board and List offer `Copy ID`
in their Page context menu when a key exists; the action copies that Page key,
not the canonical UUID. This is plain metadata, not a Property chip, badge, or
lexicographically sortable string. Hiding it on one View never disables the
namespace, lookup, copy, CLI, or Agent behavior.

## Consequences

Users and Agents gain a short stable handle while ownership and mutation code
retain one opaque canonical identity. Prefix rename and cross-Database moves do
not break old conversations or logs. Database-scoped allocation remains O(1)
and transactionally aligned with the existing single-writer Core.

The visible key can change after an explicit prefix rename or a move to another
Database, so it cannot be a permanent deep link or foreign key. Prefix changes
author Database/View canonical-read floors and a Database-level Page Detail
scope in the same LocalCommit. Board, List, open Page Detail, and search can
therefore converge before the initiating promise resolves without emitting one
mutation or patch per Page.

This decision guarantees uniqueness only inside one Library authority. A future
multi-device merge design must choose an allocator authority, leased ranges, or
an explicit re-key policy while preserving canonical UUIDs and historical
aliases. It must not silently reinterpret this local counter as a coordination-
free distributed sequence.

## Rejected alternatives

- Use the UUID as the only user/Agent reference: mechanically stable but hard
  to communicate, scan, and type.
- Make the Page key the primary key or canonical deep link: prefix rename and
  Database movement would rewrite identity and dependent relationships.
- Scope counters to Project, Data Source, or View: Project is not the content
  owner, while Source/View movement would cause unnecessary re-keying.
- Derive numbers from `MAX(number)`, SQLite row IDs, timestamps, or UUID bits:
  none expresses the namespace, retry, alias, and no-reuse contract.
- Recycle deleted numbers or promise gapless allocation: historical lookup and
  idempotent recovery are more important than cosmetic continuity.
- Add device suffixes or a distributed counter now: no current multi-replica
  authority contract requires that complexity.

## Acceptance

- New Project Pages receive `PREFIX-1`, `PREFIX-2`, and so on from the primary
  Database in the same durable transaction as their creation or placement.
- Delete/archive do not recycle a number; exact retry does not allocate twice.
- Same-Database Source/View moves retain the key; cross-Database moves gain a
  current target key while every historical key resolves to the same Page UUID.
- Prefix rename changes current display without invalidating the old allocated
  range, and unused future combinations under the old prefix do not resolve.
- List display is default-on and Board display is default-off; both are
  configurable through effective View presentation without affecting search,
  copy, CLI, Agent results, or content access.
- Page-key lookup validates current Library identity and Page lifecycle before
  returning metadata or reporting compact ambiguity, and every write still
  executes against canonical Page identity.
