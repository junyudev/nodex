# ADR 0049: Pages relate to Chats through Project Sessions

## Status

Accepted — 2026-08-24

## Context

Board, List, and Page Stage can explicitly place a Page into Chat work: a user can open a Page in a
new Chat, send the Page to an existing Chat, or run a Page section in a Chat. A Workbench Scene can
present the Page beside a Conversation, but Scene layout is Window Session state. It cannot answer
which Chats remain related to the Page after another window opens, layout changes, or Nodex restarts.

The relevant authorities already have different owners. Library owns the Page and its Document.
Workspace owns durable Project Sessions, optional Session–Thread attachments, Thread status, Session
unread state, and Chat ordering. A Codex Thread may not exist when the relationship is established,
and Thread attachment can later change without changing the user's Page context. A Page must not own
a Chat or acquire access semantics merely because the user related them.

Board and List also need a low-cost answer for many visible Pages. Adding Chat fields to Database row
projections would mix execution state into Database authority and make every Thread transition look
like a Page mutation. Inferring relationships from Scenes, mentions, prompts, or recent Pages would
make presentation and heuristics into durable authority.

## Decision

Workspace owns a normalized Page–Project Session relation.

- The durable identity is `(projectSessionId, pageId)`. It is many-to-many, non-owning, and
  non-authorizing. Product surfaces call each edge a **Linked chat**.
- SQLite stores only the two identities and `linkedAt`. Project, Library, Thread, title, status,
  unread, cause, and role remain derived from their existing authorities.
- Creating a Page-backed ordinary Session accepts bounded initial Page IDs and commits the Session
  plus all relationships in one Core transaction. Profile identity or resource-lifecycle
  failure rolls back the entire create.
- Explicit `LinkPage` and `UnlinkPage` Session intents are idempotent. Open in new chat, Send to
  chat, and Page Run Section use those operations; ordinary Page navigation, Scenes, mentions,
  references, links, and transcript text do not infer a relationship.
- Every Page-anchored mutation and read validates current Profile/Library identity and
  Page and Session lifecycle. Project may route presentation but is not required
  for content access. The edge changes neither content access nor ownership closure.
- Session archive retains the relationship but excludes it from ordinary activity and detail reads.
  Restore makes it visible again. Session deletion and physical Page deletion cascade the edge.
  Page movement and Thread attach, detach, replacement, or deletion leave it intact.
- Workspace exposes a bounded activity summary for at most 200 unique Page IDs and a revision-fenced
  bounded Linked chats window for one Page. These are derived reads over the relation, Sessions,
  optional Threads, and Projects; no live execution status is persisted on a Page or Database row.
- Activity keeps execution and unread orthogonal. Working, waiting for user input,
  system error and unread counts may coexist. A threadless Session remains related without
  contributing an execution state.
- Main deepens the existing Effect `ProjectWorkspace` Module and uses the canonical Core application
  projection plus `project-sessions-changed` invalidation. It does not add another runtime, event bus,
  Promise Port, or mutation-time broadcast.
- The renderer joins Database Page windows with batched Workspace activity in TanStack Query. Board,
  List, and Page Stage share one presentation Module and navigate by durable Session identity. A
  Scene may present the result but does not own the relation.

## Consequences

The product can explain and recover Page-related Chats across windows, layout changes, restarts, and
Thread lifecycle changes. A Page may relate to several Chats and a Chat may relate to several Pages
without introducing a primary Chat or duplicating execution authority.

The Core Workspace contract and Store format advance together. Relation mutation, Page lifecycle,
Session lifecycle, LocalCommit evidence, and activity aggregation remain behind one deep Module.
Database reads remain stable when only Chat activity changes; mounted renderer surfaces refresh their
bounded activity queries from the existing Workspace invalidation stream.

The first implementation deliberately has no reverse Session-to-Pages query, inferred provenance,
reference counting, generic relationship graph, transcript embedding, or claim that a working Chat
is editing the Page. If those product semantics become necessary, they require a new explicit
decision rather than overloading this edge.

## Rejected alternatives

### Store one Session ID on Page or one Page ID on Session

Either shape incorrectly makes a many-to-many user relationship singular and would require a later
compatibility model as soon as a Page has separate research and implementation Chats or one Chat uses
several Pages.

### Relate Page directly to Codex Thread

A Thread does not exist for a new threadless Chat, while a durable Project Session does. Thread
detach, replacement, or deletion would also erase useful context that still belongs to the Chat.

### Infer the relation from Workbench Scenes or content

Scenes are Window-local presentation. Mentions, links, prompts, recent Pages, and NFM thread markers
have independent meanings. None is an explicit, durable user decision that can safely drive activity
or unlink behavior.

### Add running and unread to Database Page projections

That would give the Database Module a second view of Workspace authority, force unrelated Board/List
windows to churn with Thread state, and couple row reads to conversation lifecycle.

### Introduce a generic resource relationship service

The current behavior needs one typed edge with specific identity, lifecycle and aggregation rules. A
generic graph would expose more mechanism while hiding less policy and would have no additional
current consumer.

## Acceptance

The decision is complete when a Page-backed Chat is created and linked atomically; explicit send and
Run Section paths link before starting work; duplicate link/unlink is idempotent; restart preserves
the relation; working and unread can be visible simultaneously on the same Page; one and many Chat
navigation work from Board and List; Page Stage lists and removes relationships; archive, restore,
Thread detach, and deletion follow the lifecycle above; bounded Core, Main, renderer, scenario, and
Electron tests pass without adding a parallel authority or invalidation path.
