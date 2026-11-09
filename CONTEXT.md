# Nodex Domain Context

Data Source Properties use a typed schema owned by the Database Module. A `relation` Property targets one Data Source in the same Library and stores normalized, non-owning Page-reference edges: cardinality `one` is nullable, while cardinality `many` is an unordered unique set. The schema selects the legal mutation family; query/presentation capabilities do not duplicate edit grammar. Relation never changes Page ownership. Reads return bounded previews; complete values use a separate bounded window. Relation supports membership/empty filters and is neither sortable nor groupable.

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
roots, sessions, terminals and Threads, and binds one primary Database.
The local Member and all Agents have full content access to every resource in that Profile;
what an Agent may do natively on the computer is its Session's Permission Mode.
Projects organize execution, placement and lifecycle. Project lifecycle
never owns or deletes Library content.

Accepted system-wide decisions live in `docs/adr/`.

## Canonical terms

### Space

A Space is one Core authority with one Library. Its stable `spaceId` is the
Core-authored Library identity, independent of its endpoint, process generation
and Store epoch. A Desktop retains its local personal Space and can enroll Devices
in remote personal or team Spaces at the same time. Resource identities are relative to their Space;
matching Page or Project IDs never authorize crossing into another Space.

A Space has one name owned by Core and set by an authenticated Owner, locally or remotely. Enrollment
and successful reconnection refresh that name on each Desktop. A network address
is a transport coordinate and never becomes the Space's display identity.

### Space connection

A Space connection is a Desktop-owned scope over one Space's authority, client,
event delivery and collaborative Documents. The personal connection owns the
local supervised Core and execution capabilities. A team connection owns only
authenticated remote access; execution and producers belong to its host.
Availability and credential withdrawal affect that connection independently.
Core owns Member attention and retained recovery drafts across devices. Viewport
positions, window and Workbench layouts, and journals of unsent edits remain
device-local, qualified by Space and Member.

### Member

A Member is a person in a Library, with an Owner or Member role. Its stable identity
survives removal. A personal Space has exactly one active Owner, bound to the local
Profile and displayed as You. A team Space admits multiple Members to one Library.
The Space Owner role controls administration; Page Owner remains responsibility
for one Page.

### Actor

An Actor is the Member, delegated Agent, or Service responsible for a mutation.
An Agent acts on behalf of a Member; a Service may act under a Member's standing grant.

### Device and Session credential

A Device is a revocable client installation enrolled for one Member in one Space.
It carries a desktop or phone form factor, label, creation time, last credential-use
time and independent revocation. Form factor grants no authority. One human has
one Member per Space and enrolls each installation separately in each Space.
Its credential obtains short-lived sessions bound to that Device. Core verifies
Space, Member, Device, Session and current role; remote identity never grants
local Host authority.

### Remote access

Remote access is a Core-owned pinned-TLS listener for a Space. Enabling it does
not add a Member or change a personal Space into a team Space. A Space becomes
team when another active Member joins; removing that Member does not silently
restore personal Agent attribution rules. A Member can link their own Device
with a five-minute, one-time offer; redemption preserves their Member identity.
Owners administer membership remotely; every Member manages their own Devices.
Listener and certificate management remain local Host capabilities. Core owns the
Profile's saved personal listener intent for both Desktop settings and native CLI
commands, and restores enabled intent when Core starts.

### Invite

An Invite is an Owner-issued, expiring one-time enrollment code with a role.
Core stores only its hash and consumes it atomically when enrolling a Device.

### Page Owner

The Owner is the Member responsible for a Page. A new Page belongs to its creator, or to
the requester whose Page or Inbox message caused an Agent to create it.

### Assignee

A Page's Assignee is a Member or an Agent with a selected instance, model and optional
effort. Assignment belongs to the Page across moves between Sources and standalone placement.
Handing an unassigned Page to an Agent chat assigns that chat's selected instance,
model and effort atomically. Existing Assignees stay unchanged; handoff grants no
automatic-start consent.

### Automatic start consent

A Member can set a Page assigned to an Agent to **Start automatically** when it is ready,
themselves or through an Agent acting for them; the consent records that Member. Changing
its Assignee clears that permission, and a copied Page does not carry it.

### Hold

A Hold is a Member's durable pause of Agent work on a Page, in a Project, or throughout
the Space, set by that person or an Agent acting for them. A Page is held when any of those
scopes is held. Clearing a child Hold cannot waive a parent Hold.

Core owns the policy. Runtime stops the affected native execution and its delegated
Threads while retaining inputs, recovery intent and delegated results. Work facts continue
to accumulate; starts, wakes and delivery wait for Resume. A Space Hold includes Nodex.
A Hold survives restart and is independent of Status and Stop.

### Source

A Source is an Owner-configured connection that watches an external service for a
Library. Configuration requires the local Host; Members can read its public
configuration and observations. It binds a verified account, watched repositories
and discovery choices.
A Source can be paused without discarding its observations.

### Trigger

A Trigger is an immutable observed external event with a semantic identity,
author, time, text and provenance. Re-reading an event does not create another
Trigger. Recording a Trigger alone grants no authority to start work or send a reply.

### External thread

An External thread is a discussion owned by another service, such as a GitHub
issue or pull request. Its stable service/repository identity survives renaming.
It is distinct from a Thread, which is an Agent execution conversation.

### Follow

A Follow connects a Page to an External thread as its own PR, its request's origin,
or supporting context. Several Pages may follow one discussion; only the Page's
verified own PR supplies lifecycle milestones.

### Delivery

A Delivery carries one followed Trigger to one Page's active chat, fixed when the
Trigger is observed. It supplies external context for existing work and never
consents to new work; an unavailable destination leaves it unresolved.

### Channel

A Channel is a Page's fixed reply address on its originating External thread.
A Channel reply is Nodex's acknowledgement or result for that requester, distinct
from the work chat's discussion with reviewers.

### Problem

A Problem is a durable condition that needs a person's action: repeated Source,
Delivery or Channel failures, an unresolved Delivery, or an invalid credential.
It has one fix and remains open until its scope succeeds.

### Activity

Activity is the shared account of what was handled or done: each decision about a
handled message, Nodex's and Automations' decisions, external updates, work milestones,
deliveries, replies, Turn notes, handbacks and Problem changes. It explains what happened
and why, with links to the affected work and evidence. A routing suggestion is not part of
it until a decision settles it.

### Agent Runtime

The Agent Runtime coordinates execution conversations and their work. It owns Runs,
native provider sessions, queued messages, delegated tasks and result delivery. It
does not own Library content.

### Host

A Host embeds one Space's execution and producer kernel. It supervises the Agent
Runtime and delivers Work, Inbox, Sources and Automations through Core's durable
admission and outboxes. Desktop capabilities are ports: windows, native tools and
operating-system notification presentation belong to the Desktop shell. A
Desktop connected to a team Space is a client of that Space's Host and acquires
none of its producers.

The personal Host is embedded in the Desktop shell. A team Host can run headless
with `nodex serve`, using the host machine's provider authentication. Core relays
authenticated Member conversation reads and person commands to that execution
owner; a Desktop's local conversation process never owns a team transcript.
The Host retains the authenticated Member for person actions and attention reads.
Agent Runs act on behalf of their captured requesting Member; producers act as
Services. Core decides which Member may answer a question or approve execution, and
which Member may take each other action in a hosted chat, from its own records.

Team Project sources identify repositories by canonical Git remote. A Host-local
clone mapping resolves those identities into working directories; executable
paths never travel as shared Project sources.

### Session

A Session is the product identity of a chat in a Project or the projectless workspace.
Page Linked chats, sidebar placement and Workbench presentation refer to this identity.
A Session's execution reference identifies its conversation without making those
relationships owners of the conversation or its delegated tasks.

### Chat owner

A chat's owner is the Member who started it, a fork or side chat included: Core
records them when it creates the chat, and a chat without that record belongs to
whoever asked for its first Run, otherwise to the Owner of the Page whose work it is.
Replying never makes another Member its owner. In a team Space the chat owner and the
Space Owners manage the chat: rename, archive or restore it, move it to another
Project, compact or clear its context and merge it back. A Member deletes only their
own side chat, through the Space host, which retires its execution; closing its tab
keeps it. A personal Space's only Member owns every chat.
_Avoid_: chat requester, steward.

### Run requester

A Run's requester is the Member whose accepted message asked for that Run; Core
captures them when the Run starts, and later messages never change it. The Run
requester, the chat owner and the Space Owners stop that Run's work, its subagents,
delegated and background tasks included, even after another Run becomes current. A
Run's questions go to its requester.

### Chat reminder

A Chat reminder makes a chat unread again at a chosen time for the Member who set it;
each Member keeps their own, as they keep their own pins. A message that Member sends
into the chat, or archiving it, cancels the reminder.

### Session activity

Session activity is when a chat was created, when a person last sent it a message, or,
in a personal Space, when its reminder came due. It orders chat lists for every Member;
Agent replies, messages from other Agents, reading, organizing a chat and another
Member's reminder never change it.

### Phone façade

A phone is a Device of a Member in a Space. The phone façade projects bounded
Inbox, chat and file views through that Member's Core-issued invocation proof.
The Space's one pinned-TLS listener owns admission and revocation; Main and
`nodex serve` embed the same semantic host owners. The phone keeps a separate
enrollment, cache, draft and outbox for each `(Space, Member)` and owns no
canonical Nodex data. See [ADR 0084](docs/adr/0084-phones-as-member-devices.md).

### Thread

A Thread is an execution conversation with its own history, model selection and Runs.
A Session binds one root Thread. A delegated Thread belongs to that root's execution
lineage and does not require a separate sidebar Session. Successive Runs of one Thread may
use different Agent Instances.

### Context Handoff

A Context Handoff carries a Thread's bounded portable history to the Agent that runs its
next Run when that Agent's native conversation has not seen those Runs, such as after the
person changes Agent, forks onto another Agent, or merges a fork back into its source. The Thread remains the one history;
each Agent keeps its own native conversation and receives only what it missed. A context clear ends what any
later handoff carries: Runs before the latest clear still in the conversation stay in the transcript only.

### Run

A Run is one admitted unit of Agent work in a Thread. Attempts may resume or retry
that work without changing its identity. A delegated task can outlive its parent's
foreground Turn; durable result delivery determines when the parent consumes its result.

### Thought

A Thought is one unit of an Agent's reasoning in a Turn: a reasoning summary section, a
thinking block or a thought segment. It is part of the work around it, not a reply. Its
heading, when it names one, is the Turn's thinking status; its prose is content and never
a status line.

### Agent Backend

An Agent Backend is the runtime and protocol family that executes a Thread or supported clock Automation:
native Codex, native Claude Code, native OpenCode, or ACP. A Backend Binding identifies
that family and, when required, its Agent Instance and ACP Agent Definition, independently of the
native session's resume identity.

### Agent Instance

An Agent Instance is a named, Profile-local configuration for one external Agent Backend and its
native configuration and authentication environment. It is distinct from a connected conversation.
For ACP, its Agent Definition is the stable logical software identity, while an Installation is
one concrete version and platform-specific executable closure. Neither a display name nor an
installation path supplies a new Agent Instance identity. Its saved native storage scope remains
part of that identity; a different native profile requires a new instance.

### Model Selection

A Model Selection combines a Backend Binding, an exact backend-owned model identifier, and the
backend's supported model options and mode. A provider may form part of the model identifier, but never replaces
the runtime instance that owns the conversation.

### Permission Mode

A Permission Mode is a Session's native execution access: Ask for approval, Approve for me or
Full access, from narrowest to broadest. It governs what the Agent's own process may do on the
computer and never narrows content access through Nodex tools. Delegated and Agent-started work
cannot exceed the caller's mode. See
[Agent Permissions and Approvals](docs/product-specs/agent-permissions-behavior.md).

### Profile

A Profile is one local Nodex installation context rooted at one Nodex home,
with its own process lock, SQLite store, browser session, and preferences. Each
Profile owns exactly one Library. Profile is not a Block and is not inferred
from any Project.

### Nodex Account Connection

A Nodex Account Connection is a Profile's optional connection to a verified
Clerk identity, identified by issuer and subject. It does not own the Profile
or Library and is independent of native Agent authentication. Main owns its
credentials and lifecycle; renderer observes public state. See
[Nodex Account Login](docs/product-specs/nodex-account-login-behavior.md).

### Library

Library is the durable content scope. `libraryId` is the ownership coordinate
for Blocks, Documents, Databases, Data Sources, Views, assets, search units,
schedules, revisions, and content mutation evidence. One Profile has one
Library; Projects reference its content without owning it.

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
ID is Block ID. Every Page owns exactly one Document containing its collaborative rich title
and body. It may relate to Library Files through optional Page-local paths and
body occurrences, but it never owns those Files.

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
or copy closure.

Page Stage resolves the owned Document with exact `(libraryId, pageId)`
identity after resolving the current resource lifecycle. It never derives a Document
ID from Page ID, treats a query row as content authority, or initializes an
existing Document from a projection. Only a ready descriptor for the registered
sync engine may mount.

Page Stage always exposes title, body, history, and Page-intrinsic run/schedule
behavior. Live Agent execution state belongs to the Thread's execution owner.
Source-defined properties and View actions exist only for a Data
Source-parented Page with exact Source/property coordinates. Opening a Page
never moves it or creates/reactivates membership.

`Card` is not a domain alias. It may be used only for a visual presentation
such as `BoardCard` or a generic request-card component.

### File

A File is a durable Library resource with stable identity, a nonunique default
name, metadata revision, lifecycle, and a current immutable content version.
It has no owner Page. File versions refer to immutable Profile Blob bytes;
sharing bytes does not merge identities. The current Profile can read and write all
Files; Project placement and creation provenance do not restrict access.
_Avoid_: Page-owned File, attachment as ownership, Data Source Files Property.

### Page File entry

A Page File entry relates a Page to a File and assigns its Page-local portable
logical path. Each Page/File pair has at most one entry. Changing or moving an
entry does not rename, replace, or transfer the File. Page Files presents the
union of explicit entries and current body occurrences, deduplicated by File ID.
A child's entries are not flattened into its parent.

Each explicit entry retains attachment provenance: who attached it and the
Core-authored attachment time. The actor is the local person, a verified Agent
identified by its product Session and captured backend family, an external
caller without verified execution identity, or an unknown historical origin
with no time. Body-only uses have no entry attachment evidence. File creation
and version evidence describe the File, not who attached it to a Page.
Renaming, moving, copying, or structurally restoring an entry preserves its
attachment evidence; replacing its File or removing and reattaching creates
new evidence. A shared File update or global name change leaves it unchanged.

### File placement

A File placement is an image or attachment occurrence in a Page Document in
the File's Library. It references stable File identity and does not require a
Page File entry. Removing or moving a placement leaves the File intact; Page
copy likewise shares its File IDs. The containing Page presents the File's current
metadata and bytes; retained versions belong to File history.
_Avoid_: Asset URI as an access capability.

### Logical folder

A Logical folder is a presentation derived from Page File entry path prefixes. It has
no durable identity, Properties, history, lifecycle, or access policy.
_Avoid_: Folder Page, Subpage as folder.

### Document

A Document is an independently loaded, persisted, synchronized, and
history-scoped content owner. Its identity is `documentId`; its registration
selects schema, content model, and sync engine. Document is an implementation
coordinate and is never exposed as a Page parent noun.

A Document observation identifies its Library and Document. Mounted sessions, sync
subscriptions, caches and Canvas outboxes retain the physical content lifetime and
Document generation. Project placement does not change that identity.

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
state, order, and exact Library File bindings. Each scene slot stores a stable
`nodex://files/*` identity, immutable FileVersion, MIME type, and frozen default
name. Application Page references retain only `targetBlockId` plus a disposable
title hint. Image data is published as an independent File before the slot is
committed.

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

Canvas placement belongs to the Library or a host Page. Moving between placements
preserves Canvas, Block and Document identity.

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
through its prior membership and logical View neighbors. The recipe is fenced
to the Page's post-move parent and location revision, so a later relocation
invalidates it without blocking unrelated content edits. View `Reorder` changes
only rank inside the current View and is not a relocation synonym.

Library top-level order and View manual order are independent fractional
orderings with `blockId` as stable tie-breaker. SQL rank never determines order
inside a Yjs Document. A new top-level Page, Database, Canvas, Page copy, or
Project resource enters ahead of every root unless its creator names an anchor;
moves, drops, and Undo without an anchor place a root after every root.

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
`hide_when_empty` (the default), or `always_hide`; it does not own Page
capabilities such as Files, Linked chats, or schedules.

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

Status is the work's single stage. Its stable identities are `triage`, not yet
decided; `plan`, decided but not started; `doing`, in progress; `review`, waiting
for acceptance; `done`, accepted; and `canceled`, no longer needed. Default names
are Triage, Todo, In Progress, In Review, Done, and Canceled. A Data Source may
rename them, and every surface shows its Source's names.

Status moves on facts: a start or handoff moves Triage/Todo to In Progress; a
`ready` Work report moves In Progress to In Review; a `dropped` report moves
Triage/Todo/In Progress to Canceled. A person's acceptance moves In Review to
Done. Automatic moves require the expected predecessor and the person-edit
revision captured when the work attempt began. A newer person's Status edit
wins, including moving away and back to the same stage. A skipped move still
records its work fact. Blocked and failed reports do not move Status.

Done and Canceled are terminal for presentation, completion filters, sorting,
and membership `completed_at`: the timestamp starts on entering either terminal
stage, survives moves within them, and clears on reopening. Only Done is accepted
work and satisfies Prerequisites; Canceled never does.

The standard **Task Parent** is a non-owning cardinality-one self-Relation on a
Data Source Page. Its children have one shared manual order independent of any
View's personal sorting or presentation.

The standard **Waits for** is a non-owning many-valued Page Relation naming a
Page's Prerequisites, including Pages in other Projects. Each edge retains its
target Data Source, so a moved prerequisite remains unsatisfied until restored.
It is never a hierarchy: it has no order, and Core rejects an edge to the Page itself or one that closes a cycle. Its reverse, the Pages
waiting for a Page, is read from the same edges. Blocked describes only an Agent reporting that its
work is blocked.

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

A View Preference Override is a sparse Member-owned Filter and Presentation
preference for one Database View. It can change only the fields explicitly
supported for that View's current Layout. It cannot change the View's name,
target Data Source, Layout, rank, lifecycle, or Manual Order.
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

Manual Order is the complete shared Page sequence inside one Database View,
independent of grouping and filtering. A Page belongs to the sequence before it
has been explicitly positioned; physical rank changes do not change its semantic
position.

Page key is an intrinsic Board/List display field. It participates in the same
durable-default plus sparse Member-owned View Preference flow as other display
fields. Hiding it changes only that effective View presentation; it cannot
disable assignment, exact lookup, copy, CLI, or Agent projection.

View position identity is `(databaseViewId, pageId)`. A Page needs no position
to qualify as a Source row; missing manual rank follows the View's explicit null
policy. The Page must be actively parented by the View's target Source.

The first implementation requires the target Source's home Database to equal
the View's host Database. A future linked View will own a new View identity and
must resolve both the host Database and target Source home Database in the same Library. An
inline Database View Block stores only its own Block ID and stable View ID;
query rows never become host Document children.

### Project

A Project is an execution context, not content. It owns filesystem sources,
ordinary Sessions, execution Thread references, and runtime settings. A
Project may have zero Sessions. A Window Session owns owner-scoped Workbench
Scenes through which one app window presents a Project, a Session, the Library
Inbox, or Library content;
Terminal and Browser Modules own their live runtimes.
It binds exactly one primary Database and has lifecycle `active | inactive |
archived`. One Database has at most one active Project. A Page created for the
Project, from its Scene or one of its Sessions, becomes a row of that Database;
a projectless Session's Page enters the Library root.

Project settings expose the primary Database namespace prefix as the Project
key. Project creation always enables that namespace; Project rename does not
change the prefix, and an explicit prefix update is one revision-fenced
Database authority mutation. Project removal or archive leaves the namespace
and every historical Page-key assignment intact with the Library content.

Active Projects may create and run Sessions. Inactive and archived Projects
retain history and do not accept new Session launches in that Project. Project
lifecycle does not limit access to Library content. Reactivation restores eligible
Project operations; it does not reopen archived Sessions or revive expired execution
identity. Project archive or deletion never deletes Library resources.

### Sidebar Section

A Sidebar Section is a Profile-scoped, named and ordered organization group for
Projects and Project Sessions. It changes only where those objects are presented
in the sidebar; it never changes Project ownership, Thread identity, execution
context, or Library access. A Project or Project Session has at most one direct
custom Section placement, and a Session without a direct placement may inherit
its Project's Section for presentation.

_Avoid_: Project folder, Thread lane, filter.

### Linked chat

A Linked chat is a normalized, non-owning edge between one
Page and one durable Project Session. It records that the user explicitly put
the Page into that Chat's work context. It neither moves the Page nor embeds a
transcript, and does not assert that a Turn is editing the Page.

The edge targets Project Session rather than Codex Thread because a Chat may be
threadless and Thread attachment may change independently. It also never
targets a Window Session, Scene, or surface. Open in new chat can create a
Session and its initial Page edges atomically; explicit Send to chat and Prompt
sends may add the same idempotent edge, and New page in a
Session's Scene creates its Page and edge in one transaction. Confirming an Inbox chat
dispatch links its message Pages to the receiving chat in the same transaction.
Page navigation, Scenes, mentions, references, links, and prompt text do not
infer one.

Open in new chat, Send to chat, and Prompt sends hand the Page to the chat: the
same transaction attempts its guarded move from Triage or Todo to In Progress. Linking an
existing chat as related, New page in a Session's Scene, and a Runbook's link
only associate. The Inbox moves its message Pages through its own handling.

A Session rests on its earliest-linked live Page, the Page it started from; later
links never displace it.

A Linked chat may carry the chat's latest Work report about that Page.

Workspace owns the relation and derives bounded Page Chat activity from it,
Project Sessions, and optional Threads. Execution and unread are orthogonal
signals. Database Page rows do not store or project Chat state; renderer
surfaces join the independent bounded projections for presentation.

### Active chat

A Page's Active chat is its one current work destination, recorded by Core with
a revision and selection time. Start, Start again, an explicit handoff, and
Inbox new-chat or send-to-chat dispatch select it. Older Linked chats stay linked
as evidence. Related-only links never select it. Archiving or unlinking the
selected chat clears it; restoring a chat does not select it again. Replies go
to this chat, and an old attempt's report cannot move the current attempt's Status.

### Prompt

A Prompt is a Page Block whose content is meant for a chat. It is ordinary
Document content: sending projects its first line and children into chat input,
never the wrapper. Its only send state is the last accepted send record, the
receiving Project Session and time, which is history rather than a Linked chat
edge or a scheduled action. See
[Prompt block behavior](docs/product-specs/nfm-editor-prompt-block-behavior.md).

### Inbox

An Inbox is what is yours: waiting intake messages, Pages whose current Turn
requires the requesting Member, and Nodex's answers to that person's Inbox questions.
The Library Inbox includes every Project and messages without a Project. A
Project Inbox filters that same set. Core owns one ordered window, cursor,
counts and badge predicate. Answers are visible but do not increase the badge.

Intake messages and answers are ordinary Pages. A Project's intake uses its
primary Database; messages without a Project use the Library's Inbox Database,
created on first capture. A Turn row is the work Page itself, never another
message Page. It appears for question, approval, review, blocked, failed or
stalled, and for ready-to-start only when it has Prerequisites that are all
Done. Todo backlog and paused Pages stay out. Its episode start orders it;
it leaves immediately when the Turn changes away from the requesting Member.

### Inbox entry

An Inbox entry is the Workspace-owned record beside a message Page. It holds:

- the message's immutable source: the person, an Agent, the command line or a
  Automation's held decision;
- the Nodex answer it replies to, when it continues that conversation;
- a user-editable kind: note, todo, or question, for messages that take advice;
- whether the user marked it important, which keeps it within reach while it
  waits;
- a triage state: open, kept, or done.

An entry is in the Inbox while it still needs the user. A confirmed chat
dispatch, filing in another Project, Keep, or Done handles it, and Activity
records each such decision; where its Page lives never does.
Work handed to a chat stays in progress until the user marks it done; a chat
finishing never does. The message Page's workflow status follows the handling,
Triage while waiting, In Progress once handed to a chat, Todo when kept or filed,
Done when done, but only while it still shows the status the previous handling
gave it, so a status set by hand is never overwritten.
Deleting a message erases it: the entry, every suggestion naming it, the Page,
and its revisions go, with no restore path.
The entry survives relocation, so Activity still shows where a message filed into
a Project went, while the Project's own Properties apply to the Page.

### Dispatch proposal

A Dispatch proposal is one typed action for one or more Inbox entries: keep,
new chat, send to chat, move to Project, plan, or run an Automation's held
decision. A plan names several Pages to create across Projects, each with its Agent
work and Prerequisites. A new chat may also name the Agent it
runs on. A chat action's prompt holds what the user asked for; its optional additions hold what the suggestion added on
its own, such as advice to delegate part of the work, each dropped before confirmation if the user unchecks it. It is versioned and records the
message it was written for, its Markdown body and Library images; once that message changes it is outdated, still
reviewable and confirmable, never withdrawn or replaced on its own. A proposal is advice. Only the user's
confirmation, a user-written dispatch, or the user's standing consent to start their own clear requests
makes it Dispatch work. Nodex marks each chat proposal that answers a request the user themselves clearly
made; under that consent the Host confirms such a proposal for the user's own unchanged messages, and the
confirmation records that Nodex made it. Plans, Keep and filing always wait for the user. Confirmed chat
work stays in the `dispatching` state until the Desktop Host delivers it. A
Automation writes the proposal for its own decision; Nodex never does.

_Avoid_: task, job, routing rule.

### Automation

An Automation is a Core-owned standing instruction scoped to a Project or the Space.
It has a Member Owner, a natural-language condition and action, an optional typed
condition, execution target, mode, lifecycle and revision. A clock condition
retains its schedule, explicit timezone and jitter salt. A heartbeat continues
one stable Session; other clock Automations start new chats per configured folder.

Its mode is Dry run, Ask first or Run. Dry run records what Nodex would have
done. Ask first holds an editable decision in the Owner's Inbox. Run starts under
the Owner's standing grant. Only that Owner may change an Automation's mode or
edit one set to Run. Agents propose changes for the Owner to apply; they do not
change existing Automations directly. Page recurrence and reminders schedule a
person's work and never start an Agent.

_Avoid_: Rule, Scheduled task, job, routine; Observe, Ask or Auto for the modes.

### Automation assessment

Core serializes one unsettled event assessment per primary external thread.
Enabled Source filters select unfollowed Triggers; the Coordinator judges their
written condition and action from bounded retained evidence. Generation and
policy fences reject stale answers, and every applicable Automation receives a
positive or negative factual judgement. Dry run records only; Ask first proposes
to the Automation Owner; Run creates a Page owned by that person, assigns its Agent,
follows the thread as origin and starts it under the standing grant. Equivalent
actions share admission; incompatible actions ask. External actors never supply
authority. See [Automations behavior](docs/product-specs/automations-behavior.md).

### Automation decision

An Automation decision records Trigger references, inputs, reason, frozen action and
authority, state and proposal, Page and dispatch links. Clock Triggers are
immutable due occurrences. A decision retains its dispatch identity across
lease retries. A clock Automation set to Ask first has one waiting decision; later occurrences append
references while its clock advances. Confirmation freezes the reviewed message
and Agent choice. Skip, redirect and withdrawal settle the waiting decision.
Dry run decisions create no work, proposal or chat.

### Runbook

A Runbook is a Library Page that an Automation follows as standing
instructions. Each run reads its current content and may update it for later
runs, and each run's chat links to it.

### Coordinator

The Coordinator is the Profile's one persistent coordinating chat, shown to the
user as **Nodex**. It routes every Inbox message by answering its suggestion
request, watches Managed chats, and adds Turn notes only when they explain something the derived text does not say. It is an ordinary Runtime chat that never appears among
chats; the Inbox is its face. Its conversation is working memory, not authority:
what it decides is recorded in Core, so it can be compacted, restarted or
started fresh without losing work. It never does the work it routes.

_Avoid_: router, bot, dispatcher (in product copy).

### Managed chat

A Managed chat is a chat whose work the Coordinator watches: every chat an Inbox
dispatch or a Page start creates or continues, and any chat the user hands to
Nodex. Its notifications come from Page Turn episodes: questions and approvals by rule,
review and problems when Nodex requests an interruption in a Turn note.

### Work report

A Work report is the outcome a chat last reported for a Page it is linked to:
`ready` for the user to review, `blocked` on the user or another piece of work,
`failed`, or `dropped` when there was nothing to do. A later report replaces it.
Ready and dropped attempt guarded Status moves; blocked and failed only record
the outcome. Core retains whether a report moved Status, even when a person's
choice or a newer active attempt prevented it.

### Work event

A Work event is a durable fact the Coordinator must hear about a Managed chat or
a Page: a Work report, a question or approval waiting, a turn that ended without
a report, a failure, an apparent stall, or a Page that became ready to start.
Each is recorded once by its identity and delivered to the Coordinator in
batches as Host input.

### Agent work

A Page has Agent work when its Assignee is an Agent. Its assignment names the Agent
instance, model and optional effort. A Member can set it to Start automatically when
its Prerequisites are satisfied, or leave it waiting for them. Changing the Assignee clears
that consent. The Owner remains the Member responsible for the Page.

### Page Workspace

A Page Workspace is the Page's stable Git execution identity in a Project whose
primary source is a repository. It records the repository, attached branch and
starting commit, independently of the checkout files. Every chat started for
that Page shares its Workspace; a Linked chat alone does not acquire it.

The branch starts at the default branch's current commit, without copying local
changes. Its name uses the Page key and title, or a short Page identity when no
key exists. Later renames do not rename the branch. Done or Canceled requests checkout
cleanup, which waits for all consuming chats and preparations. Reopening work
recreates the checkout on the same branch. The branch and verified pull request
link remain with the Page after checkout cleanup. Non-git Projects keep their
local execution directory.

### Prerequisite

A Prerequisite is a Page another Page waits for. It is satisfied when it is
active in its retained target Data Source and its Status is `done`. In Review
awaits acceptance, and Canceled never satisfies it. A Page with
an Agent Assignee, no active chat, Status `triage` or `plan`, and every Prerequisite
satisfied is ready to start. Starting it hands it to a new Managed chat with a
brief of the Page and of what its Prerequisites reported.

### Turn

A Page's Turn is Core's bounded answer to whose action comes next: a Member, its
executing Agent, the first unsatisfied Prerequisite, a queue position, or nobody. A working
or queued active chat names its Agent even when the Page is unassigned or assigned
to a Member; the Agent executes for that Member. Its reason
is paused, working, queued, question, approval, blocked, failed, stalled, review,
ready_to_start, starting, or waiting_on_prerequisite. Done and Canceled suppress
Turn. Main supplies revisioned execution observations for every active chat;
Board, List, Page, CLI and work briefs consume the same Core decision, and every
interface words it for its reader as whose move the Page waits for, such as "Needs
your answer" or "Waiting for Alice’s answer", without calling it a Turn. Execution
unavailability is distinct from failure. After terminal stages, the most specific effective hold gives the Turn to the Member who paused it, before attention requests.

### Turn episode

A Turn episode identifies one continuous actor and reason on a Page. Core
persists its identity and start time in the same LocalCommit as changes to its
inputs, including reverse Prerequisites. Repeated progress or report observations
leave it unchanged. Changing applicable pause holds begins a new episode. Returning to a previous actor and reason begins a new
episode. Notes and notifications can bind to that identity.

### Inbound delivery and handback

Core records an identity, integrity hash, author and original intake Page bindings
for each message delivered to an active chat. Runtime owns chat text and attachment
bytes. The Host proves the Run's inbound identity as tool context. A managed chat
can return that message to intake with a routing reason under one durable receipt.
Original words, images, author and dispatch history remain intact. A direct-chat
message gets one intake envelope. Returned messages re-enter at their return time.
At most two handbacks are allowed per original message across destinations. An
already-answered question cannot be returned. A handback grants no automatic-start
consent; Nodex sends it to the previous destination again only when the person insists.

### Turn note

A Turn note is immutable Page-owned context from the Coordinator, bound to the
local Member's current episode and 1–8 Work events delivered to that Coordinator.
Each event backs at most one note per Page and episode; exact retries reuse it.
The newest note of the current episode explains the Inbox row. Without one,
Core shows the exact question, report summary, failure, or finished Prerequisites.
A note never creates membership or reorders the Page. Its notify choice may
create one durable interruption intent for that Member, Page and episode.

### Conversation recency

Conversation recency is the time of a Thread's latest meaningful conversation
activity. It orders recent Threads and supplies relative-age presentation. It
is distinct from Session metadata time and from Thread metadata changes such as
opening, reading, renaming, pinning, archiving, status transitions, or execution
location updates. A Session without an attached Thread has no conversation
recency.

### Profile access

The user, parent Agents, child Agents and background work can read and write every
Project, Page and Library resource in the current Profile. Project ownership and
Session lineage organize work. They do not restrict content operations. A planning
interaction retains the same content access.

### Execution identity

Execution identity identifies the product Session, runtime, Run, attempt and native
process that issued a call. A captured call remains attached to its original execution and
is honored only while the engine still proves that execution live and its Session stays
bound and active. Cancellation, connection retirement, Session archive or deletion end it.
A replacement execution never adopts an invalid call. Profile and Store identity identify
the physical resource lifetime.

### Structural edit

A structural edit is one Core-owned mutation over an ordered root forest and
its ownership closure. A selection containing a typed owner must use this
boundary; ordinary cross-Document Block moves use it as well. It is the authority
for mixed delete, clipboard capture/paste, duplicate, move, and lossless Page-to-
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

### Content interaction history

Content interaction history orders local Page body, Page title, and Database
gestures within one window's Library and Store epoch. Retained
content participants own inverse evidence; one owner orders commands and replay
across their views. Focus selects the input boundary, not the next content action.
A structural restore may preserve Block identity while replacing collaborative
addresses; Core guards semantic replay against current fields, placement, and
generation and returns a new inverse. Evidence stays with its original participant
when a Block moves elsewhere. See
[ADR 0060](docs/adr/0060-content-interaction-history.md) and
[ADR 0058](docs/adr/0058-surface-history-and-semantic-address-recovery.md).

### Reference Block

A Reference Block has its own `blockId` and stable `targetBlockId`. It presents
foreign content without changing parent, membership, or authority. `pageRef`
uses its own identity so duplicate mounts retain independent local disclosure.
Idle references read rebuildable exact-head summaries; an active surface mounts
the target Page's Document directly after resolving its current resource lifecycle. The foreign body
never becomes host content.

References are childless and never participate in ownership traversal for copy,
or retention. Copy preserves reference targets. Unresolved legacy
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
and Project bindings are different families but share bounded
validation, caller-retained operation IDs, canonical semantic equality,
immutable receipts, post-commit acknowledgement, history, and change-log rules.

The host binds Profile, Library, product Session, exact execution identity and Store
epoch. Content mutations resolve resource identity and lifecycle in that Library.
Durable content belongs to the Library; any Project on a receipt, change, Automation
or delivery record identifies execution or presentation placement. It does not change
the content lifetime or the Agent's full access.

`BlockTransfer` moves/copies ownership within one Library. It accepts logical
Page/Block roots and Library/Page/Data Source targets, while the writer compiles
exact parent, membership, View, and Document heads. Copy recursively allocates
fresh ownership identities and never follows reference targets. Move rejects
any edge that would make a Page own itself transitively; prepare provides early
feedback and the committing transaction rechecks current resource lifecycle. Project
is an execution context. Moving between resources in different Projects changes
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

| State                                                                                                                                               | Canonical authority                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Profile → Library                                                                                                                                   | `profiles` and `libraries`                                               |
| Block identity, type, lifecycle, Library, and parent                                                                                                | `blocks` plus typed placement detail                                     |
| Page title and body                                                                                                                                 | Page Document (`yjs`)                                                    |
| File identity, name, versions, and provenance                                                                                                       | Library Files and immutable Profile Blobs                                |
| Page-local File paths                                                                                                                               | Page File entries and their manifest revision                            |
| Ordinary Block hierarchy/order/content                                                                                                              | nearest owning Document                                                  |
| Canvas metadata and Library/Page placement                                                                                                          | `blocks`, `canvas_owners`, and the exact host shell or Library placement |
| Canvas scene and managed-file metadata                                                                                                              | normalized Canvas scene rows                                             |
| Document ownership                                                                                                                                  | `block_documents`                                                        |
| Library top-level placement                                                                                                                         | Library placement records                                                |
| Database metadata, lifecycle, default View                                                                                                          | Database Container records                                               |
| Page-key prefix registry, counter, and Database/Page assignments                                                                                    | Database Page-key authority records                                      |
| Schema, Pages, and property values                                                                                                                  | Data Source relational records                                           |
| View query/configuration/manual Page position                                                                                                       | Database View records                                                    |
| Project binding/lifecycle                                                                                                                           | Project execution records                                                |
| Page-intrinsic schedule/run behavior                                                                                                                | generic Block properties and typed read models                           |
| NFM, preview, search, schedule, asset, and Page summary                                                                                             | rebuildable projections                                                  |
| Restorable Document states                                                                                                                          | immutable semantic Document revisions                                    |
| Presence, cursor, selection, leases                                                                                                                 | ephemeral collaboration state                                            |
| Project Sessions, Thread links, and Linked chats                                                                                                    | Project execution domain                                                 |
| Inbox entries and Dispatch proposals                                                                                                                | Project execution domain beside Inbox message Pages                      |
| Coordinator binding, Session execution observations, Turns, Turn episodes, Turn notes, Inbox answers, notification intents, Work reports and events | Project execution domain                                                 |
| Prerequisites (Waits for)                                                                                                                           | Data Source relational records                                           |
| Members and local identity                                                                                                                          | Library                                                                  |
| Page Owner, Assignee and automatic start consent                                                                                                    | Page intrinsic state and typed read models                               |
| Per-window Project/Session Scene surfaces, panels, selection, and geometry                                                                          | Window Session view                                                      |
| Browser guests and Terminal PTYs                                                                                                                    | Main-process runtime Modules                                             |

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
10. References never change parent or membership, copy ownership,
    or embed a foreign body in the host Document.
11. Each Project binds one Database; each Database has at most one active
    Project. Project lifecycle never removes content.
12. The user and all Agents have full content access to the current Profile; native execution follows the Session's Permission Mode, and execution identity and resource lifecycle remain exact.
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
25. A Linked chat never changes Page ownership, Database membership, Agent execution identity, Session ownership, or Thread attachment.
26. The Library owns File identity. Each Page has an independent entry manifest;
    its File paths are optional relationships, and logical folders have no identity.
27. A Page File placement references stable File identity, remains non-owning,
    and may occur in any Page Document in the same Library. The containing Page
    may resolve only the File's current presentation metadata and bytes.
28. A Dispatch proposal never starts work, sends a prompt, or moves content by
    itself; only the user's confirmation or the user's standing consent, applied
    by the Host to the user's own unchanged messages, does. Agent and
    command-line Inbox workflow endpoints append entries; their backing Pages
    follow the same full-Profile content model. Core records each entry's actual
    execution source, and confirmed triage owns dispatch intent.
29. Only the Automation Owner grants Run execution, and a Page's Start automatically and
    a plan's starts record the consenting Member. An Agent carries exactly the authority
    of the Member it acts for: it may grant these for that Member, never for another.
30. Only the Coordinator authors Turn notes and Inbox answers and answers suggestion
    requests through its tool; the source is derived from verified execution
    identity, never from a name.
31. Work facts move Status only from their expected predecessors while their
    attempt's person-edit fence still matches; a person's later Status choice wins.
    Only Done is accepted work.

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

Title, body, and Database edits share window-local content interaction history
under the same Library and Store identity. Awareness is ephemeral
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
semantic Document and derives NFM preview. Each new revision freezes the exact
File versions and default names used by its body, including when File updates
leave the Document head unchanged. Restoring reuses matching live Files and
forks changed or trashed Files once per source identity, in the same forward
commit as the Document. It leaves shared Files and current Page paths intact.
Historical bytes are available only through exact retained bindings; older
revisions without such evidence remain visibly unresolved.

### Move and copy

Moving within one Document is one engine transaction; cross-Document Block
movement uses relocation and preserves referenced File identities as
placements in the target Page. Moving Page changes shell/parent only and
preserves its owned Document and File identities.
Moving into/out of a Source changes active membership atomically and leaves old
Source values dormant. Block copy preserves placed File identities. Whole-Page
copy allocates a fresh Block/Document ownership closure and copies explicit
File paths while preserving every referenced File identity.
Changing Source or View within one Database preserves the Page-key assignment.
Cross-Database movement allocates or reuses the target assignment while
retaining the source key as a historical locator; copy receives a fresh Page
identity and number.

### Restore and backup

A backup is the Store and its managed assets, the content Nodex alone writes. It is
copied online from one pinned SQLite read snapshot while writes and Agents continue;
the execution store and each Agent's native history are outside it. Restore rewinds
content, not conversations: it journals SQLite/WAL/assets as one recoverable authority,
verifies integrity, ownership, projections, and managed assets, rotates store epoch,
then invalidates live subscriptions, and the Session set then follows the execution
store's conversations. Old transports, outboxes, Awareness, and checkpoints fail closed
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
- Say **Automation** for standing Agent work and name its modes **Dry run**,
  **Ask first** and **Run**; do not call it a Rule or a Scheduled task.

## Nodex account vocabulary

### Nodex Account

A Nodex Account identifies a person using optional cloud model access across
local Profiles. It does not own a local Profile or Library. Clerk owns identity;
Main owns each Profile's verified connection and private credential lifecycle.

### Prepaid credit

The user's USD wallet balance managed by sub2api, which owns billing, usage
accounting and model gateway admission. Desktop observes remaining credit and
offers in-app Top up through a Main-created Stripe Checkout; local state cannot authorize spending.

### Nodex models

The closed model catalog served through two account-isolated managed Codex and
Claude provider instances. The Nodex API exchanges Clerk access for their
per-user gateway key. They require explicit selection and retire with the
account connection. See [Nodex Account and Model Access](docs/product-specs/nodex-account-and-subscription-behavior.md).

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
schema/value validation, membership history, ranking,
idempotency, projections, and post-commit events behind `read` and `apply`.

## Decision index

- `docs/adr/0080-the-inbox-is-what-is-yours.md`: one Core projection over intake,
  current Member Turns and quiet answers; episode-bound notes and notifications.

- `docs/adr/0068-agent-runtime-execution-authority.md`: one Runtime execution
  owner, exact Session and native source identity, and full-Profile content access.
- `docs/adr/0067-inbox-entries-and-dispatch-proposals.md`: Page-backed Inbox
  triage, proposals and confirmed dispatch without a second task authority.
- `docs/adr/0072-inbox-page-peek-and-primary-inbox-database.md`: Inbox Pages
  open beside their Inbox, and each Inbox's primary Database is protected
  Library content listed in Space.
- `docs/adr/0082-automations-replace-scheduled-tasks.md`: Owner-authorized Automations, clock
  Triggers and editable held decisions in the Inbox, Owner-granted
  unattended execution, and runbook Pages.
- `docs/adr/0079-status-moves-on-facts-a-persons-move-wins.md`: guarded Status
  transitions preserve the person's later move; Done accepts prerequisites, Canceled
  retires work, and the active chat names the work destination.
- `docs/adr/0078-nodex-coordinates-managed-work.md`: the Coordinator routes the
  Inbox, watches Managed chats through durable Work events and speaks through
  Page Turn notes and quiet Inbox answers; Pages carry Agent work, Prerequisites and Work reports
  without a second task authority.
- `docs/adr/0043-database-scoped-page-keys.md`: Database-owned Page-key
  namespaces, Library-unique prefix history, monotonic allocation, UUID
  identity boundary, resolution, and presentation projection.
- `docs/adr/0049-page-project-session-links.md`: durable Page–Project Session
  relationships, atomic establishment, lifecycle boundaries, and
  bounded Page Chat activity projection.
- `docs/adr/0042-dedicated-git-read-worker.md`: one rebuildable,
  generation-bound Git repository read plane in a dedicated worker, with Main
  and renderer Adapters and mutation-driven invalidation.
- `docs/adr/0017-library-pages-data-sources-and-project-resource-grants.md`:
  Library ownership, Page rename/exclusive parent, Database/Data Source/View,
  Project placement and Database Module depth. Its resource grant decisions are superseded
  by full-Profile access.
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

- [ADR 0081: Sources and followed threads](docs/adr/0081-sources-and-followed-threads.md) — external observations, direct delivery, own-PR milestones, origin replies, Problems and Activity.

Phones enroll as Member Devices through a Device-link offer and reach each Space
directly over its pinned-TLS listener. A team phone remains connected while a
joined laptop is closed, provided `nodex serve` remains running and reachable.
