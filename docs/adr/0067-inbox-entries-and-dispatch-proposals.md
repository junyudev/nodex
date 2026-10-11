# ADR 0067: Inbox entries and dispatch proposals

Status: Accepted
Date: 2026-10-11

## Context

Users often have a thought, a todo, or a question while agents are working. They
should not have to choose a Project or a chat before writing it down. Capture
must be durable even when no model is available. Advice about where a message
belongs must never become execution on its own, and agents need a safe way to
leave follow-ups for the user without reaching into anything else.

## Decision

Each Inbox message is an ordinary Page in one lazily created, Library-owned
Inbox Database. Search, Board, List, relocation, history, and the CLI therefore
work on messages without a second content model.

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

Authority is split by role:

- **Desktop Host:** reads and triages the Inbox, records suggestions, confirms
  dispatches, and delivers confirmed work.
- **Agent Turns and the command line:** may only append. Core derives the source
  label and Project from the frozen Turn authority or the bound connection, never
  from the caller. Agent Turns are capped at a few messages each.

A suggestion is advice. The suggestion Agent receives only message text and a
bounded routing context, and it has no tools. Main validates every target
against that context before recording a proposal. Only the user's confirmation
can start a chat or send a prompt. A Page move is the user's own Library
relocation, which Core verifies before completing the proposal.

Main delivers confirmed chat work through the same launch and message seams that
ordinary chats use. Launch identities derive from the proposal. Delivery to a
busy chat waits for idle.

## Consequences

Captured messages survive model and runtime failures, and they remain ordinary
Pages after they are filed into a Project. One proposal state machine serves
both Agent suggestions and hand-written dispatches. Restart and retry cannot
start a chat twice.

Inbox preferences, such as the suggestion runtime and routing guidance, stay Main
Profile settings. Core stores no model configuration.

Steering a running Turn, attachments in the capture composer, and system-wide
capture are not part of this decision.
