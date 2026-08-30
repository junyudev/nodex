# Nodex Domain Context

Data Source Properties use a typed schema owned by the Database Module. A `relation` Property targets one Data Source in the same Library and stores normalized, non-owning Page-reference edges: cardinality `one` is nullable, while cardinality `many` is an unordered unique set. The schema selects the legal mutation family; query/presentation capabilities do not duplicate edit grammar. Relation never changes Page ownership or grants access. Reads return authorization-safe bounded previews; complete values use a separate bounded window. Relation supports membership/empty filters and is neither sortable nor groupable.

This document defines the canonical domain language for Nodex. ADR 0017 moves
durable content from Project-owned Spaces to the local Profile's Library,
renames the document-like content entity from Card to Page, and separates
Database Container, Data Source, and View identity. Earlier shipped-schema
import code may still use legacy Card, Space, Project-content, or Database-as-
schema terms; those names describe source data only and are not alternate
authority.

## Product boundary

Nodex is a local-first workspace for durable content and agent work. A local
Profile owns one Library containing Pages, Databases, Blocks, Documents, and
their durable history. A Project is an execution context: it owns filesystem
roots, sessions, terminals, Codex Threads, and approval policy, binds one
primary Database, and receives grants to Library resources. Project lifecycle
never owns or deletes Library content.

Accepted system-wide decisions live in `docs/adr/`.

## Canonical terms

### Profile

A Profile is one local Nodex installation context rooted at one Nodex home,
with its own process lock, SQLite store, browser session, and preferences. Each
Profile owns exactly one Library. Profile is not a Block and is not inferred
from any Project.

### Library

Library is the durable content scope. `libraryId` is the ownership coordinate
for Blocks, Documents, Databases, Data Sources, Views, assets, search units,
schedules, revisions, and content mutation evidence. One Profile has one
Library; many Projects may receive access to it.

Library is not a Block. A top-level Block has a Library parent and a fractional
rank. Archiving or deleting a Project leaves the Library and all of its content
unchanged.

### Block

A Block is the only persistent application content identity. Every content
object has one globally unique `blockId`, a type, lifecycle, Library, and one
current parent. A Block can be text, media, a Page, a Canvas, a Database, a
reference, or another registered type.

Yjs client and struct identifiers are implementation details and never replace
`blockId`. Physical retention may remove a live Block only after global
ownership, reference, history, and recovery reachability is disproved. Its ID
then remains permanently in `retired_block_identities`; no creation, import,
copy, relocation, or migration may reuse it.

### Page

A Page is a document-bearing Block. Page has no separate storage identity: Page
ID is Block ID. Every Page owns exactly one Document containing its
collaborative rich title and body, and may directly own Files whose exact bytes
must survive independently of body placement.

A Page key such as `LAB-13` is a human- and Agent-readable secondary locator,
not Page identity. An enabled Database owns the prefix, monotonic counter, and
immutable `(Database, Page) -> number` assignment from which Core projects the
current key. One Page may retain assignments in several Databases after moves,
but has at most one current Page key from its current enabled Database. UUID
Page ID remains the authority for ownership, Documents, mutations, references,
View positions, and deep links.

Page Detail is the membership-independent read Interface for opening that
identity. It combines Block parent/lifecycle coordinates, owned Document and
exact-head projection, intrinsic property coordinates, and the optional Data
Source context implied by the Page's current parent. Library- and Page-parented
Pages are complete Pages without Source-defined status, priority, due date, or
View order. Data Source query rows are projections and must never be Page
existence checks.

Every active Page has one exclusive parent:

- `library`: a top-level Page ordered in the Library;
- `page`: a nested Page whose childless shell is stored in the parent Page's
  Document; or
- `data_source`: a structured row Page governed by one Data Source schema.

Nesting moves the Page shell and does not copy its title/body into the parent
Document. A `pageRef`, View, relation, mention, backlink, or link may present a
Page elsewhere without changing its parent.

A Page Mention is an inline atom identified only by its target Page ID.
A Page Reference Block is a non-owning `pageRef` shell with its own Block ID.
A Page Link is an ordinary link to a canonical Page deeplink.
An Owning Page Shell is a childless `page` Block created by Core and is the only
one of these occurrences that establishes Page containment.
Mention, Reference Block, and Link edges never change parentage, membership,
grants, or copy closure.

Page Stage resolves the owned Document with exact `(libraryId, pageId)`
identity after Project access has been evaluated. It never derives a Document
ID from Page ID, treats a query row as content authority, or initializes an
existing Document from a projection. Only a ready descriptor for the registered
sync engine may mount.

Page Stage always exposes title, body, history, and Page-intrinsic run/schedule
behavior. Live Agent execution state belongs to Thread/session/Codex runtime.
Source-defined properties and View actions exist only for a Data
Source-parented Page with exact Source/property coordinates. Opening a Page
never moves it or creates/reactivates membership.

`Card` is not a domain alias. It may be used only for a visual presentation
such as `BoardCard` or a generic request-card component.

### Page File

A Page File is an exact-format durable resource directly owned by one current
Page. It has stable File identity and one Page-relative logical path; rename,
content replacement, and an exclusive semantic ownership move preserve
identity, while Page copy creates new File identity. Ownership follows a Block
move only when the current owner is the source host and every live placement of
that File moves to the same target host; ambiguous and copy-like operations
leave ownership unchanged.
_Avoid_: Artifact, attachment as ownership, Data Source Files Property.

A child Page owns its own Files. Parent Page Files never flatten descendant
Files; recursive ownership is composed through the existing Page parent tree.

### File placement

A File placement is an image or attachment occurrence in any Page Document in
the File's Library. It references stable File identity and never becomes
ownership; removing a placement leaves the File intact. A placement exposes
only the File's current presentation metadata and bytes through its containing
Page. It does not grant access to the owner Page, Files manifest, version
history, or File mutations.
_Avoid_: Asset URI as File identity.

### Logical folder

A Logical folder is a presentation derived from Page File path prefixes. It has
no durable identity, Properties, history, lifecycle, or access policy.
_Avoid_: Folder Page, Subpage as folder.

### Document

A Document is an independently loaded, persisted, synchronized, and
history-scoped content owner. Its identity is `documentId`; its registration
selects schema, content model, and sync engine. Document is an implementation
coordinate and is never exposed as a Page parent noun.

The public identity of an authorized Document observation is
`(libraryId, accessContext, documentId)`. Library names the physical content
lifetime; `accessContext` names either direct Library authority or one
authorized Project path. Mounted sessions, sync subscriptions, caches, and
Canvas outboxes retain that complete identity and never synthesize a Project
owner for Library-authorized content.

A `block_tree` Page Document uses Yjs and has exactly two roots:

- `Y.Text("title")` is canonical rich title authority; its validated Delta
  preserves styles, links, and inline application objects.
- `Y.XmlFragment("body")` contains one canonical BlockNote-compatible root
  `blockGroup`.

A body-only Block Document has one `body` root and no synthetic title. Synced
Block and Reusable Template sources share that primitive. Canvas uses a
registered `scene_graph` content model and `canvas_scene` engine. The Yjs state
vector expresses causal state; SQLite `headSeq` orders local durable appends;
content hashes protect integrity. None substitutes for another.

Every mounted writable surface owns a fresh engine client identity and finishes
its handshake before mounting content. Retained inactive surfaces clear
ephemeral Awareness. Canvas mounts through the scene-native provider and full
canonical scene repair path.

### Document-bearing Block

A document-bearing Block owns a Document through `block_documents`. Page,
system-managed Synced Block source, Reusable Template source, and Canvas are
registered owners. Ordinary paragraph, heading, list, code, media, and reference
Blocks share the nearest owning Document. Content size never changes ownership
automatically; long-form content is modeled as Page.

A Canvas Document stores normalized Excalidraw elements, bounded durable app
state, order, and managed-file metadata. Application Page references retain
only `targetBlockId` plus a disposable title hint. Asset data is uploaded first
and scene authority stores a `nodex://assets/*` URI.

Page Documents derive Page Mention, Page Reference Block, and Page Link
occurrences into one normalized Page-reference projection in the same durable
transaction as materialization. The projection stores canonical target Block
identity, source Page and Block identity, presentation, and occurrence count,
even while the target Block does not have an active Page capability. Candidate,
resolution, and backlink reads require the active Page capability and apply the
caller's existing content-access authority before exposing rows or counts.
Owning `page` shells are excluded.

A Canvas Block has one exclusive Library or Page placement and one row in
`canvas_owners`. Its stable Canvas ID is its Block ID; clients resolve the
owned Document through `block_documents` and never derive or persist that
Document ID in a host shell. Project creation seeds one deterministic primary
Canvas, but primary status is only the default Project entry point—not a
different Document or Database View type.

A Library-parented Canvas receives explicit Project resource grants like any
other root. A Page-parented Canvas has no direct grant and inherits access from
the host Page ownership path. Moving between those placements changes the
direct-grant state atomically with the owner shell; it never changes the
Canvas, Block, or Document identity.

Synced Block and Reusable Template remain dormant capabilities without ordinary
Library UI. Their hidden source Blocks have real Library placement and body-only
Documents. `syncedBlockRef` presents live source content; `templateRef`
instantiates an exact source state with fresh Block IDs. Reference scanning and
retention are Library-global, not Project-local.

### Block shell

A Block shell is a Block's representation in the Document that physically
contains it. Ordinary Block content lives in its host Document. A nested
document-bearing Block stores only a childless shell there; the owned Document
loads independently.

A Page-owned Canvas shell is exactly a childless `canvas` Block with the Canvas
owner's Block ID and empty props. It contains no scene JSON, files, app state,
title snapshot, or `documentId`. Creating, moving, duplicating, or deleting that
shell is a typed Library operation that changes the Canvas owner and host
Document in one transaction; an ordinary Yjs edit may neither fabricate nor
remove the owner shell.

Nested `page` and non-owning `pageRef` Blocks share one flat outliner
presentation. Collapsed rows read an exact-head rich-title summary without a
provider. Explicit title engagement may mount the target title while the body
remains collapsed. Disclosure, engagement, activation, focus, and visibility
are local view state. Open-owner ancestry prevents direct and indirect cycles
from mounting recursively.

### Parent and placement

Parent answers who owns an active Block. Page uses the explicit `library |
page | data_source` algebra; Canvas uses `library | page`; and Page ownership
is a rooted acyclic forest.
Moving a Page into itself or an ownership descendant is rejected before commit
and by the persistence boundary. Non-Page Blocks are Library-owned or live in the
nearest Page/owner Document according to their registered behavior. Relational
parent coordinates and the Document's exact tree/materialized index must agree.

Page relocation means changing that exclusive parent through one typed Library
mutation. A Database destination is an active Data Source selected through its
Database's default View; a Page destination is ownership, while a Project name
beside a Database is only primary-binding context and never an ownership
coordinate. Every relocation mints a one-shot Core Undo recipe. It restores a
Library or Page source through authoritative sibling anchors, or a Data Source
through its prior membership and exact active View ranks. The recipe is fenced
to the Page's post-move parent and location revision, so a later relocation
invalidates it without blocking unrelated content edits. View `Reorder` changes
only rank inside the current View and is not a relocation synonym.

Library top-level order and View manual order are independent fractional
orderings with `blockId` as stable tie-breaker. SQL rank never determines order
inside a Yjs Document.

`library_block_placements` is the sole top-level order authority. Block and
Document registries are keyed by Library; Project IDs on receipts, changes,
automation, recovery, and delivery records are actor/execution/delivery
coordinates and never content ownership.

### Database

A Database is a placeable Block and Container. It owns metadata, lifecycle,
Data Sources, hosted Views, one default View, access revision, and Project
bindings. An enabled Database also owns one Page-key namespace: its counter,
current prefix, retained historical prefixes, and immutable Page-number
assignments. This alias registry does not make the Database the Page owner. A
Database still does not own a property schema or Page rows directly.

Creating a Database atomically creates the Container, one initial Data Source,
one View targeting that Source, and selects that View as default. All three
global identities are independently preallocated UUID-v7 values; none is
derived by parsing or extending a Project or parent identity. The single-Source
UI hides the Data Source noun while contracts retain its explicit identity.

### Data Source

A Data Source is a relational entity with one home Database. It is never a
Block, has no Document, and has no independent Library placement. It owns one
typed property schema, Data Source-parented Pages, their property values, one
Page layout, schema/query revisions, and dormant membership history. The Page
layout orders Source-defined Properties and assigns each one `always_show`,
`hide_when_empty`, or `always_hide`; it does not own Page capabilities such as
Files, Linked chats, or schedules.

Property identity is local to one Data Source. Built-in capabilities use
reserved stable IDs such as `status`, `priority`, and `tags`; custom Properties
use `p_` plus eight base64url characters. Option identity is local to one
Property; custom options use the analogous `o_` form. Display names may change
without changing identity. Any unbound Property or option reference carries
its Source/Property owner explicitly; a View may omit the Source only because
it already targets exactly one Source.

A Data Source-parented Page is the active row identity. It has exactly one
matching active historical-membership record. Leaving the Source tombstones
that membership while retaining values; dormant data is excluded from queries,
scheduling, summaries, and mutations. Returning to the same Source reactivates
the record. Moving to another Source performs no implicit value mapping.

Status, priority, due date, and similar collection fields are Source-defined
properties. Scalar edits use revision preconditions; set-like values preserve
add/remove intent. Recurrence, reminders, run-target configuration, and other
behavior intrinsic to a Page remain generic Block properties even if displayed
by a View.

Priority has four assigned option identities in severity order:
`p0-critical`, `p1-high`, `p2-medium`, and `p3-low`.
An unset value is `No priority`; planning horizons such as “later” belong to workflow or scheduling rather than the priority scale.

The standard **Task Parent** is a non-owning cardinality-one self-Relation on a
Data Source Page. Its children have one shared manual order independent of any
View's personal sorting or presentation.

### Database View

A Database View is a durable named query and Presentation belonging to one
Database and targeting exactly one Data Source. Every user-visible View tab has
one stable View identity and one current Layout. It stores its Filter,
Presentation, Manual Order, rank, and revision. Active View, search text,
selection, and expansion remain window-local.

### Layout

A Layout is the durable Board or List presentation strategy for one Database
View. It is the Presentation discriminant: a View has only the fields legal for
its current Layout. An explicit Layout change keeps the View identity and
layout-neutral query settings while replacing layout-specific settings. Layout
is never a personal preference or a substitute for View identity.
_Avoid_: View kind, Table view, toggle-list view, Calendar layout

### View Preference Override

A View Preference Override is a sparse Profile-local Filter and Presentation
preference for one Database View. It can change only the fields explicitly
supported for that View's current Layout. It cannot change the View's name,
target Data Source, Layout, rank, lifecycle, access scope, or Manual Order.
_Avoid_: Project view preference, personal View copy

### Effective View

An Effective View is the normalized result of a Database View's durable Filter
and Presentation, one View Preference Override, and its Data Source
capabilities. Both Core projection reads and the renderer for its one current
Layout consume the same result.

### Filter

A Filter is the Database View expression that determines which Source Pages
belong to the result. Its durable value is shared; a sparse personal change may
remain private until explicitly published. Search is a separate window-local
interaction.

### Presentation

A Presentation describes how a Database View result is sorted, grouped, and
shown in its current Board or List Layout. It includes the ordered Properties
shown in that View and layout-specific settings. Its durable value is shared;
a supported personal change remains a View Preference Override until explicitly
published. View Property display is independent from Data Source Page layout.

### Manual Order

Manual Order is the shared fractional Page rank inside one Database View. It is
independent of grouping, which is derived from Source Property values.

Page key is an intrinsic Board/List display field. It participates in the same
durable-default plus sparse Profile-local View Preference flow as other display
fields. Hiding it changes only that effective View presentation; it cannot
disable assignment, exact lookup, copy, CLI, or Agent projection.

View position identity is `(databaseViewId, pageId)`. A Page needs no position
to qualify as a Source row; missing manual rank follows the View's explicit null
policy. The Page must be actively parented by the View's target Source.

The first implementation requires the target Source's home Database to equal
the View's host Database. A future linked View will own a new View identity and
must require access to both host Database and target Source home Database. An
inline Database View Block stores only its own Block ID and stable View ID;
query rows never become host Document children.

### Project

A Project is an execution context, not content. It owns filesystem sources,
ordinary Sessions, Codex Threads, runtime settings, and approval policy. A
Project may have zero Sessions. A Window Session owns owner-scoped Workbench
Scenes through which one app window presents Project or Session resources;
Terminal and Browser Modules own their live runtimes.
It binds exactly one primary Database and has lifecycle `active | inactive |
archived`. One Database has at most one active Project.

Project settings expose the primary Database namespace prefix as the Project
key. Project creation always enables that namespace; Project rename does not
change the prefix, and an explicit prefix update is one revision-fenced
Database authority mutation. Project removal or archive leaves the namespace
and every historical Page-key assignment intact with the Library content.

Active Projects may create and run Sessions. Inactive and archived Projects
retain history but cannot start work and are read-only. Reactivation restores
current implicit access after current lifecycle/revisions are checked; it never
revives an expired approval or archived Session automatically. Project archive
or deletion never deletes Library resources.

### Sidebar Section

A Sidebar Section is a Profile-scoped, named and ordered organization group for
Projects and Project Sessions. It changes only where those objects are presented
in the sidebar; it never changes Project ownership, Thread identity, execution
context, or Library access. A Project or Project Session has at most one direct
custom Section placement, and a Session without a direct placement may inherit
its Project's Section for presentation.

_Avoid_: Project folder, Thread lane, filter.

### Linked chat

A Linked chat is a normalized, non-owning, non-authorizing edge between one
Page and one durable Project Session. It records that the user explicitly put
the Page into that Chat's work context. It does not move the Page, grant the
Session's Project or Agent access, embed a transcript, or assert that a Turn is
editing the Page.

The edge targets Project Session rather than Codex Thread because a Chat may be
threadless and Thread attachment may change independently. It also never
targets a Window Session, Scene, or surface. Open in new chat can create a
Session and its initial Page edges atomically; explicit Send to chat and Page
Run Section actions may add the same idempotent edge. Page navigation, Scenes,
mentions, references, links, and prompt text do not infer one.

Workspace owns the relation and derives bounded Page Chat activity from it,
Project Sessions, and optional Threads. Execution and unread are orthogonal
signals. Database Page rows do not store or project Chat state; renderer
surfaces join the independent bounded projections for presentation.

### Conversation recency

Conversation recency is the time of a Thread's latest meaningful conversation
activity. It orders recent Threads and supplies relative-age presentation. It
is distinct from Session metadata time and from Thread metadata changes such as
opening, reading, renaming, pinning, archiving, status transitions, or execution
location updates. A Session without an attached Thread has no conversation
recency.

### Project resource grant

A Project resource grant authorizes `read` or `read_write` access to one Page,
Database, or Library-parented Canvas root and its ownership closure. Active
Project binding supplies an implicit recursive read-write grant to the primary
Database. All foreign resources require either an explicit grant or a bounded
Agent consent overlay.

Database closure includes owned Data Sources, hosted Views, Source-parented
Pages, nested Pages, owned Documents, direct Files, canonically placed Files'
current presentation surfaces, and assets. Page closure includes nested Pages,
physically nested Databases, Documents, direct Files, canonically placed Files'
current presentation surfaces, and assets. A File placement does not add its
owner Page or owner-only File surfaces to closure. Closure never follows
`pageRef`, relation, linked View, mention, backlink, or ordinary link edges.
Canvas closure includes its owned scene Document and managed assets. A
Page-parented Canvas inherits the host Page grant and has no independent grant.

A grant to one Source-parented Page exposes only the read-only schema slice
needed to interpret that Page's current values. It never permits sibling query
or schema management. `read_write` permits Page content/current-value edits but
not structural schema, grant, Data Source move, archive, or permanent-delete
operations.

Persistent authorization and transient Agent consent are independent. The
primary Database and `read_write` grants execute directly, including destructive
writes. A `read` grant executes reads directly but requires consent for writes;
an ungranted known target in the same Library also requires consent. Consent may
cover one exact prepared footprint, the corresponding resource for the root
task, or a durable Project grant. Only the durable choice writes
`project_resource_grants`; cross-Library, deleted, stale, and unsupported
structural targets remain ineligible for consent.

### Structural edit

A structural edit is one Core-owned mutation over an ordered root forest whose
ownership closure contains at least one typed owner. It is the authority for
mixed delete, clipboard capture/paste, duplicate, move, and lossless Page-to-
ordinary reclassification. Page reclassification preserves the Block identity,
makes the rich title its inline content, and moves Page body roots beneath the
resulting Block while the same Page Document remains dormant for structural
history. Reversal restores that same Page and Document identity. The operation
owns all host Document, owner lifecycle, parentage, owned Document, Canvas,
Database, projection, retention, and inverse-recipe effects; a generic Document
update cannot perform any subset of that work.

A Structural Clipboard Bundle is an immutable same-Library snapshot addressed
by a bounded capability. A cut claim is its separate single-use right to move
the captured identities once. A Structural History Recipe is a durable,
single-use forward inverse; reversing it creates a new recipe rather than
rewinding storage. Clipboard and history authorities retain their closure only
while their lease or recipe remains reachable.

### Reference Block

A Reference Block has its own `blockId` and stable `targetBlockId`. It presents
foreign content without changing parent, membership, or authority. `pageRef`
uses its own identity so duplicate mounts retain independent local disclosure.
Idle references read rebuildable exact-head summaries; an active surface mounts
the target Page's Document directly after access evaluation. The foreign body
never becomes host content.

References are childless and never participate in ownership traversal for copy,
retention, or grants. Copy preserves reference targets. Unresolved legacy
references reserve tombstoned diagnostic identities so unrelated creation
cannot capture the target ID.

### Projection

A projection is rebuildable data derived from authoritative Block, Document,
Data Source, View, and property records. NFM, plain text, previews, search units,
asset references, Page read models, and schedule indexes may lag, be discarded,
and be rebuilt. They never reconstruct an already-existing Document.

`document_versions` is immutable semantic revision authority rather than a
projection. `block_mutations` and Library-scoped relocation records retain
idempotency/history evidence. Projections carry exact Library, Document
generation/head, Block metadata/property, and Source coordinates needed to
reject stale reads.

### Nested Markdown (internal NFM)

NFM is a deterministic text projection for genesis import, explicit
compare-and-swap replacement, export, and materialized reads. It does not
preserve every internal identity and is never collaborative write authority.
There is no ordinary whole-Page update transport.

### Mutation

A mutation is durable user or Agent intent applied by the single SQLite writer.
Document updates, Page parents, Block/Data Source properties, View positions,
Project bindings, and resource grants are different families but share bounded
validation, caller-retained operation IDs, canonical semantic equality,
immutable receipts, post-commit acknowledgement, history, and change-log rules.

The host binds Profile, Library, explicit content authority, Session, actor, and
store epoch; public callers cannot forge scope. Project-scoped mutations
evaluate current Project lifecycle, binding/grant/access revisions, and
independent approval policy. Trusted local Library mutations instead evaluate
Library identity, target lifecycle, and store epoch. Durable content mutations
are Library-scoped. Any Project ID retained on a receipt, change, automation,
recovery, or delivery record is the actor/execution/delivery coordinate and
never changes the content lifetime.

For `nodex_app`, the host also binds one immutable authority snapshot to the
exact Codex Turn. Ordinary snapshots have Project scope and continue to resolve
the current primary Database, recursive Page/Database grants, and root-task
resource consent overlays. A Turn
started with Nodex's built-in Full access preset has temporary Library scope:
it may use the existing tool catalog across the actor Project's Library and its
writes do not require a Nodex approval card. This overlay is never persisted as
a Project resource grant, cannot cross a Profile/Library/store epoch, and does
not transfer to a later Turn merely because permission settings changed. Main
tracks the selected built-in preset separately from raw Codex config, so an
equivalent Custom sandbox configuration or renderer-supplied mode cannot create
Library authority.

`BlockTransfer` moves/copies ownership within one Library. It accepts logical
Page/Block roots and Library/Page/Data Source targets, while the writer compiles
exact parent, membership, View, and Document heads. Copy recursively allocates
fresh ownership identities and never follows reference targets. Move rejects
any edge that would make a Page own itself transitively; prepare provides early
feedback and the committing transaction rechecks current authority. Project is
not a product content owner; ordinary access changes through binding/grants.
Moving between resources reached through different Project access paths changes
only the logical Page parent/placement and its associated Source or host-shell
state. Block and Document Library ownership remains stable. Mutation evidence
records the logical transfer, affected Documents, and actor/delivery Project;
there is no physical owner transition to plan or replay.

A Document operation batch addresses application Block IDs and validates the
complete result on a current-head clone before atomically committing the engine
update, registry/index changes, projections, revision, receipt, and change log.
Barrier-crossing offline edits either prove disjoint derived touched IDs or
become durable recovery artifacts requiring reload.

### Relocation

Relocation is an atomic parent change for one or more ownership subtrees. A move
preserves Page/Block IDs and owned Document history. A copy allocates fresh IDs
for the ownership closure while preserving reference targets.

Cross-Document relocation leases affected mounted Documents, lets editors
finish IME/flush/freeze, recompiles exact heads and parents, and commits source,
target, registry, membership, projection, history, receipt, and change evidence
together. Response retry returns the immutable result.

### Store epoch and Document generation

`storeEpoch` identifies one restored lifetime of the SQLite store and rotates
after restore. `generation` identifies one reset/replacement lifetime of a
Document. Durable updates and disposable caches/outboxes must match both; stale
state is rejected rather than replayed.

## Authority and ownership

| State                                                                      | Canonical authority                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Profile → Library                                                          | `profiles` and `libraries`                                               |
| Block identity, type, lifecycle, Library, and parent                       | `blocks` plus typed placement detail                                     |
| Page title and body                                                        | Page Document (`yjs`)                                                    |
| Page File identity, logical path, versions, and provenance                 | Page Files manifest and immutable managed blobs                          |
| Ordinary Block hierarchy/order/content                                     | nearest owning Document                                                  |
| Canvas metadata and Library/Page placement                                 | `blocks`, `canvas_owners`, and the exact host shell or Library placement |
| Canvas scene and managed-file metadata                                     | normalized Canvas scene rows                                             |
| Document ownership                                                         | `block_documents`                                                        |
| Library top-level placement                                                | Library placement records                                                |
| Database metadata, lifecycle, default View                                 | Database Container records                                               |
| Page-key prefix registry, counter, and Database/Page assignments           | Database Page-key authority records                                      |
| Schema, Pages, and property values                                         | Data Source relational records                                           |
| View query/configuration/manual Page position                              | Database View records                                                    |
| Project binding/lifecycle                                                  | Project execution records                                                |
| Foreign Page/Database capability                                           | Project resource grants                                                  |
| One-call/root-task Agent resource capability                               | main-owned consent overlays                                              |
| Page-intrinsic schedule/run behavior                                       | generic Block properties and typed read models                           |
| NFM, preview, search, schedule, asset, and Page summary                    | rebuildable projections                                                  |
| Restorable Document states                                                 | immutable semantic Document revisions                                    |
| Presence, cursor, selection, leases                                        | ephemeral collaboration state                                            |
| Project Sessions, Thread links, and Linked chats                           | Project execution domain                                                 |
| Per-window Project/Session Scene surfaces, panels, selection, and geometry | Window Session view                                                      |
| Browser guests and Terminal PTYs                                           | Main-process runtime Modules                                             |

## Invariants

1. One local Profile owns exactly one Library.
2. Library owns durable content; Project never does.
3. `blocks.id` is the single application content identity; Page ID is Block ID.
4. Every active Page has exactly one Library, Page, or Data Source parent.
5. Every Page owns exactly one active Document; other registered owner types use
   their exact registered schema.
6. A Source-parented Page has one matching active membership; other Pages have
   none. Dormant memberships are inert but recoverable.
7. Database owns Data Sources and Views but not schema or Pages.
8. Data Source owns schema, Page rows, values, and query identity.
9. View belongs to one Database, targets one Source, and positions Pages.
10. References never change parent or membership, copy ownership, grant access,
    or embed a foreign body in the host Document.
11. Each Project binds one Database; each Database has at most one active
    Project. Project lifecycle never removes content.
12. Recursive grants traverse ownership only; access and approval are separate.
13. Committed engine/database/transfer mutations are idempotent and acknowledged
    only after their SQLite transaction commits.
14. Restore appends a forward engine mutation and never rewinds causal history.
15. Deletion tombstones identity before collection; projections never restore
    authority except explicit one-time genesis migration.
16. Cross-Document relocation commits engine, registry, parent, Source, View,
    history, receipt, and change records atomically.
17. Database creation atomically creates Container, initial Source, initial
    View, and default View authority from independently allocated identities.
18. Data Source is never a Block under the accepted architecture.
19. A Page-owned Canvas appears once as a childless owning shell; its scene and
    Document identity never enter the Page Document.
20. Canvas lifecycle and placement use typed Library commands that atomically
    preserve or change the owned Document and every affected host shell.
21. Page ID remains canonical; Page key is a Database-scoped secondary locator
    and never becomes a Block, Document, reference, cursor, or View-position
    identity.
22. An enabled Database has exactly one current prefix and one monotonic
    counter; current and retained prefixes are unambiguous across its Library.
23. One Database/Page assignment and one Database/number assignment are unique
    and immutable. Committed numbers are never reclaimed.
24. A Page has at most one current Page key, determined by its current Database,
    while historical assignments and retired-prefix ranges remain resolvable.
25. A Linked chat never changes Page ownership, Database membership, Project
    resource grants, Agent authority, Session ownership, or Thread attachment.
26. Every Page has one direct Files manifest. A live File has exactly one owner
    Page and one portable logical path; logical folders have no identity.
27. A Page File placement references stable File identity, remains non-owning,
    and may occur in any Page Document in the same Library. The containing Page
    may resolve only the File's current presentation metadata and bytes.

## Operation semantics

### Edit

Local Page/BlockNote transactions update a live Y.Doc immediately and send an
idempotent binary update with store epoch, generation, client session, and
bounded touched-ID diagnostics. The writer applies it to a clone/reloadable
Document, resolves dependencies, validates schema and global identity, commits
update plus derived records, then acknowledges and fans out. Remote-origin
transactions neither echo nor enter local undo.

Canvas edits update Excalidraw/local undo immediately. The provider normalizes
runtime values, uploads assets, persists the exact outbox mutation, and sends
canonical scene intent through the same durable FIFO. Remote repair never
guesses snapshots.

Title and body undo remain local to the mounted surface. Awareness is ephemeral
and not a lock. Close/deactivation persistence is bounded: durable
acknowledgement or disposable local checkpoint, never an unbounded offline wait.

### Explicit NFM replacement

`ReplaceDocumentFromNfm` requires an expected current Document head, parses and
validates NFM, and generates operations against the existing Y.Doc. It does not
replace the Y.Doc or causal history. Existing IDs survive only when conservative
semantic/parent matching is unambiguous; unmatched nodes receive fresh UUID-v7
IDs.

### Document revision history

Meaningful Page content history is immutable semantic Document revisions.
Human edits create pre-burst, periodic active, idle/shutdown revisions; strict
semantic commands create immediate linked revisions. Named/restore revisions
are pinned; unpinned retention is deterministic recent/hourly/daily.

Page History combines content revisions with property, Data Source, lifecycle,
relocation, and Page File version activity. Reading recreates the registered
semantic Document and derives NFM preview. Document and File restores both
append new forward semantic states rather than rewinding history.

### Move and copy

Moving within one Document is one engine transaction; cross-Document Block
movement uses relocation and preserves referenced File identities as
placements in the target Page. Moving Page changes shell/parent only and
preserves its owned Document and File identities.
Moving into/out of a Source changes active membership atomically and leaves old
Source values dormant. Block copy preserves placed File identities. Whole-Page
copy allocates a fresh ownership closure, including new identities for directly
owned Files whose immutable bytes may be deduplicated; foreign placements in
the copied Document remain references to their existing Files.
Changing Source or View within one Database preserves the Page-key assignment.
Cross-Database movement allocates or reuses the target assignment while
retaining the source key as a historical locator; copy receives a fresh Page
identity and number.

### Restore and backup

A backup is copied only after one whole-store maintenance fence drains managed
assets, flushes the writer, and closes SQLite connections. Restore journals
SQLite/WAL/assets as one recoverable authority, verifies integrity, ownership,
projections, and managed assets, rotates store epoch, then invalidates live
subscriptions. Old transports, outboxes, Awareness, and checkpoints fail closed
and remount through current descriptors.

## Non-domain state

Presence, cursors, selection, disclosure, search, focus, active View, and leases
are not durable content. Disclosure may persist as disposable profile-local
preference by stable Block ID. Project Sessions and Codex Thread links are
shared execution concepts. Owner-scoped Scene surfaces, panel trees, active
leaves, geometry, and navigation history are Window Session view state; their
descriptors may point to shared Session/Page/Canvas/Database resources or
Main-owned Browser/Terminal runtimes without becoming another authority for
those targets.
The renderer has one discriminated `project | session | empty | auxiliary`
Window Session location and one layout-v5 writer. Project Scenes use the
Project's current default Database View as the fixed owner-root primary;
Session Scenes use their Conversation. Per-Project view presentation, sidebar
disclosure/width, and recent Pages are profile preferences, not Session domain
state or alternate location owners.

The **Git Review read plane** is rebuildable process state derived from a local
Git repository, not durable Nodex domain state. One dedicated worker owns each
canonical repository's command lane, observation generation, live-query
sharing, watcher lease, and bounded untracked cache. Main and renderer are
Adapters over that authority and never retain a competing repository snapshot.
Stale and canceled reads are normal generation outcomes; local mutations
explicitly invalidate the same worker-owned read plane.

## Naming rules

- Say **Page** for the durable document-like content object.
- Say **Page key** for a canonical readable alias such as `LAB-13`, **Project
  key** only for the current prefix exposed through Project settings, and
  **Page ID** for the canonical Block UUID. Do not call Page key an Issue ID or
  use it as a synonym for identity.
- Say **Block** when behavior applies to all content identities.
- Say **Document** for independently synchronized content owned by a
  document-bearing Block; name `yjs` or `canvas_scene` when encoding matters.
- Say **Canvas** for the document-bearing whiteboard Block and **Canvas Stage**
  for its full tab presentation; do not call either a Database View.
- Say **Database** for the placeable Container and **Data Source** for schema,
  Pages, values, and query identity.
- Say **View** for a saved presentation targeting one Data Source.
- Say **membership** only for internal active/dormant Source placement evidence;
  public active row identity is Page ID.
- Say **reference** for a non-owning target edge and **projection** for derived
  NFM, preview, search, asset, schedule, or read-model data.
- Say **revision** for immutable restorable Document state and **checkpoint**
  for storage/transport mechanics.
- Say **Card** only for visual structures such as Board or request cards.

## Code orientation

Shared domain Interfaces live under `src/shared/`; SQLite Implementations live
under `src/main/local-store/`; trusted HTTP/IPC/CLI/Agent adapters bind access
in `src/main`; renderer transport remains behind `src/renderer/lib/api.ts`.
Page Stage, Canvas Stage, and owned-Document surfaces live under
`src/renderer/components/block-documents/` with runtime/descriptor validation
under `src/renderer/lib/`.
The Git Review worker protocol lives in `src/shared/git-worker-protocol.ts`;
`src/main/git-worker-host.ts` is its Electron lifecycle Adapter,
`src/main/git-worker/` owns repository observation and query execution, and
`src/renderer/features/review/data/git-query.ts` projects active queries into
each renderer window's TanStack Query cache.

Legacy Card/Project-content readers are allowed only in shipped-schema staging
import code. Production Page read models are assembled from Block/Document/Data
Source authority. The deep Database Module hides target resolution,
authorization, schema/value validation, membership history, ranking,
idempotency, projections, and post-commit events behind `read` and `apply`.

## Decision index

- `docs/adr/0043-database-scoped-page-keys.md`: Database-owned Page-key
  namespaces, Library-unique prefix history, monotonic allocation, UUID
  identity boundary, authorized resolution, and presentation projection.
- `docs/adr/0049-page-project-session-links.md`: durable Page–Project Session
  relationships, atomic establishment, access and lifecycle boundaries, and
  bounded Page Chat activity projection.
- `docs/adr/0042-dedicated-git-read-worker.md`: one rebuildable,
  generation-bound Git repository read plane in a dedicated worker, with Main
  and renderer Adapters and mutation-driven invalidation.
- `docs/adr/0017-library-pages-data-sources-and-project-resource-grants.md`:
  Library ownership, Page rename/exclusive parent, Database/Data Source/View,
  Project binding, resource grants, and Database Module depth.
- `docs/adr/0020-database-identity-scopes.md`: independent opaque Database/
  Data Source/View roots and compact owner-scoped Property/option identity.
- `docs/adr/0001-block-identity-card-alias.md`: retained single Block identity;
  Card alias and Project-as-Space portions are superseded.
- `docs/adr/0002-document-bearing-blocks-yjs.md`: independent owned Documents
  and stable application identity.
- `docs/adr/0003-database-membership-and-views.md`: retained relational schema/
  value and durable View lessons; Database-as-schema is superseded.
- `docs/adr/0004-atomic-block-relocation.md`: atomic ownership movement.
- `docs/adr/0005-canvas-scene-native-sync-engine.md`: engine-neutral Documents
  and scene-native Canvas authority.
- `docs/adr/0014-document-revision-history.md`: semantic revisions and forward
  restore.
