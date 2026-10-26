# ADR 0072: Inbox Page peek and the primary Inbox Database

- Status: Accepted
- Date: 2026-10-26
- Owners: Nodex maintainers
- Refines: Page placement in [ADR 0069](0069-library-and-inbox-scenes.md) and Library Inbox
  Database navigation in [ADR 0067](0067-inbox-entries-and-dispatch-proposals.md)

## Context

An Inbox opened a message's Page in its own tab group, so reading a message hid the stream it
came from. A Board or List already opened a Page in the group to its right, so the Inbox was the
one list of Pages that could not be read beside its Pages.

Space listed every Library root, including each Project's primary Database, but hid the Library
Inbox Database because the Inbox has its own Home entry. A Project has its own Home entry too.
The Inbox Database was also the only Database an Inbox depends on that could be archived: the
next message then created a replacement and left earlier messages behind in the archived one.

## Decision

An Inbox opens a message's Page beside itself: a preview in the group to its right of the Inbox,
created when the Inbox's group is alone. The next Page opened replaces the preview until the
reader works in it or pins it. Closing the last tab beside the Inbox returns it to full width.
This holds for the Library Inbox and every Project's Inbox, since both are the same surface. A
Database opened from an Inbox, `Open Board` or `Open Inbox as a Database`, still opens in the
Inbox's own group, because a Board needs the width; Pages opened from that Board go beside it.
The Inbox Scene keeps no separate collapsible panel: the group beside the Inbox is its side
panel, with the same split, resize, and close behavior as every other group.

Each Inbox has a primary Database: a Project's Inbox uses its Project's primary Database, and
the Library Inbox uses the Library Inbox Database. A primary Database is ordinary Library
content: it is a Library root in Space and in Library navigation, listed and opened like any
other root. It cannot be archived or removed by a structural selection while its owner depends
on it.

## Consequences

- Reading, editing, and handling a message keep the stream in view.
- Home lists entry points to workflows; Space lists all Library content. No Library root is
  hidden from Space.
- Core applies one primary-Database rule to Projects and the Library Inbox, so the Library Inbox
  no longer loses its Database to an archive.
