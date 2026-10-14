# ADR 0067: Inbox entries and dispatch proposals

Status: Accepted
Date: 2026-10-11

## Context

Users often have a thought, a todo, or a question while agents are working. They
should not have to choose a Project or a chat before writing it down, but a
thought had while working in a Project already belongs with that Project.
Capture must be durable even when no model is available. Advice about where a message
belongs must never become execution on its own, and agents need a safe way to
leave follow-ups for the user without selecting another chat.

## Decision

Each Inbox message is an ordinary Page. Search, Board, List, relocation,
history, and the CLI therefore work on messages without a second content model.

There is one Library Inbox and one Inbox per Project. Each entry records its
Inbox when it is captured, and nothing derives it from where the Page lives. A
Library message is a Page in one lazily created, Library-owned Inbox Database. A
Project message is a Page in that Project's own Database from the start, so it
is on the Project's Board with the Project's keys and never has to be moved
there. Because membership no longer depends on location, moving a Page by other
means cannot silently handle its message; filing it in another Project is an
explicit, final decision recorded by Core.

The whole message is the Page body, so nothing the user wrote moves into
metadata. The title is a label. Core gives it a provisional excerpt unless the
sender provides one. The suggestion Agent may replace only that provisional
title, through an ordinary Document title write fenced by the Page head it read.

The ProjectWorkspace Module owns three records next to that Page:

- **Inbox entry:** source provenance, kind, and triage state.
- **Dispatch proposal:** a typed, versioned action for one or more entries.
  Each proposal is fenced by the message revisions it was computed from.
- **Dispatch outbox:** confirmed chat work in the `dispatching` state.

Kind and triage state describe inbox handling, not Page content, so they are not
Data Source Properties. Placing the records in Workspace lets one confirmation
create a Session in the same transaction that records the dispatch.

Inbox workflow ownership is split by role:

- **Desktop Host:** reads and triages the Inbox, records suggestions, confirms
  dispatches, and delivers confirmed work.
- **Agents and the command line:** use append-only Inbox interfaces. Core derives
  the source label and Project from the verified execution source or bound
  connection, never from caller-supplied labels, and the message lands in that
  Project's Inbox. Only the Desktop Host chooses an Inbox explicitly. A proven
  Run has a five-message
  budget. A native source without causal Run evidence retains its Session, leaves
  Run null, and has an independent five-message budget for that native connection.
  Receipt replay does not consume the budget again.

The backing messages remain ordinary Pages with full Profile content access.
Project placement, parent-child lineage, background execution and planning mode
do not restrict their content operations. Inbox confirmation is a dispatch workflow,
not a resource permission request.

A suggestion is advice. The suggestion Agent receives only message text and a
bounded routing context, and it has no tools. One pass covers one Inbox. A
Project's Inbox narrows the context to that Project: its messages already belong
there, so routing stays inside the Project except for filing in another one. Main validates every target
against that context before recording a proposal. Only the user's confirmation
can start a chat or send a prompt. A Page move is the user's own Library
relocation, which Core verifies before completing the proposal.

Main delivers confirmed chat work through the same launch and message seams that
ordinary chats use. Launch identities derive from the proposal. Delivery to a
busy chat waits for idle.

## Consequences

Captured messages survive model and runtime failures, and they remain ordinary
Pages after they are filed into a Project. A Project's Inbox can be the
Project's Home because its messages are already the Project's Pages. One proposal state machine serves
both Agent suggestions and hand-written dispatches. Restart and retry cannot
start a chat twice.

Inbox preferences, such as the suggestion runtime and routing guidance, stay Main
Profile settings. Core stores no model configuration.

Steering a running Turn, attachments in the capture composer, and system-wide
capture are not part of this decision.
