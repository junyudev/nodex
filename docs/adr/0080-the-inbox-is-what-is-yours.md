# ADR 0080: The Inbox is what is yours

## Status


## Decision

Core owns one mixed Inbox window over waiting intake, the local Member's current
Page Turns, and quiet answers to Inbox questions. It owns membership, ordering,
cursors, counts and badge eligibility. The Library Inbox includes all Projects;
Project Inboxes filter that same projection. An unscoped intake remains distinct
from the all-Projects view.

A work Page enters for question, approval, review, blocked, failed or stalled,
and for ready-to-start only when it has Prerequisites that are now all Done.
Backlog and paused Pages stay out. Episode start orders the row, and changing
away from the Member removes it immediately. There is no separate dismissal,
done or retirement state for a Turn row.

Immutable Page-owned Turn notes bind delivered Work events to the current
Member episode. They explain the Turn without granting membership. The newest
current-episode note replaces derived text; no note means the exact question,
report, failure or completed Prerequisites remain visible. Quiet conversational
answers bind one-to-one to questions and atomically handle them.

Person actions revalidate the episode. Replies use the Page's active chat and
the existing durable person-dispatch owner without creating intake. An unavailable
or ambiguous destination remains visible and never silently routes elsewhere.

Core owns durable notification intents keyed by Member, Page and episode.
Question and approval create them by rule; review and problems require a note's
notify choice. Main claims only current intents once, applies user and OS policy,
and opens the row or its Page. Managed chats yield their direct notifications to
this owner. Unmanaged chats retain their policy.

Remote membership admits Inbox reads and person Turn actions through the semantic
allowlist. It does not grant Coordinator writing, managed-chat handback or Host
notification authority.
Receipt ownership and writer-time revocation remain Member-bound.

A managed chat returns one inbound message under a Core receipt. The Host proves
the inbound identity from the Run, and Core retains its hash and original Page
bindings rather than a second transcript. Runtime supplies direct-chat content
and attachments when intake publication is needed. Return preserves author,
content and dispatch history, is bounded to two handbacks across destinations,
and never grants automatic-start consent. Already-answered questions cannot be
returned. Only the person may explicitly choose the previous destination again.

## Consequences

Nodex posts and their message Pages are removed. Work events retain resolution
and batch-delivery semantics without owning Inbox membership. Main and renderer
consume one bounded Core read rather than merging separate collections. See
[Inbox behavior](../product-specs/inbox-behavior.md) for actions and presentation.
