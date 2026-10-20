# ADR 0069: Library and Inbox Scenes

- Status: Accepted
- Date: 2026-10-20
- Owners: Nodex maintainers
- Supersedes: the `pages` owner name in [ADR 0038](0038-window-local-pages-scene.md)
- Refines: Library Inbox placement in [ADR 0067](0067-inbox-entries-and-dispatch-proposals.md)

## Context

The Library Inbox was a full-width route laid over whichever Scene the window
had selected. Opening a message's Page, or the Inbox Database itself, sent the
reader to Space, which deliberately hides the Inbox Database. Triage therefore
lost its place on every look at a message, while a Project's Inbox already
kept its Pages and Views as tabs beside it.

Space's Scene owner was named `pages` although its content, routing, and
authority are the Library's.

## Decision

Scene owners are `project`, `session`, `library`, and `inbox`. `library` is the
former `pages` owner, unchanged in behavior: no protected primary, only
Library-routed Page, Database, View, and Canvas surfaces.

`inbox` is a window-local singleton whose Home is the Library Inbox. Every
Inbox is now the Home of a Scene, and the Inbox surface names its Inbox by
scope: the Library Inbox, or one Project's. An Inbox Home obeys the Project
Home invariants: it is the first, non-closable tab of the full-width right
stack and never moves to the bottom panel. Beside it the Inbox Scene accepts
exactly the Library Scene's surfaces. It owns no Agent Dock and no floating
composer, because the Inbox has its own composer.

Content opened from the Inbox Scene stays in it, in the source tab group.
Chats still open their own Session Scene. Every entry into the Library Inbox
activates its Home tab and keeps the other tabs.

Locations follow the owners: `library` and `inbox` are Scene locations, and
the Inbox route with its `returnTo` no longer exists. The Inbox Scene belongs
to the Home destination and may be the Home checkpoint; the Library Scene
belongs to Space.

Scene v9 and Workbench layout v9 decode older snapshots in place. The `pages`
owner, key, and location become `library`. An Inbox route becomes the Inbox
Scene location, including inside Settings and the Home checkpoint. A Project
Inbox surface's Project becomes its Inbox scope.

## Consequences

- Reading, editing, and filing a message keeps the Inbox one tab away.
- Project and Library Inboxes share one header and one placement model; the
  title-bar Inbox header is gone.
- Code names the Library's Scene by its owner, `library`, matching its routing
  context.
- Agents observe and target the Inbox Scene through the same Scene references
  as other owners.
