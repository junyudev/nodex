# ADR 0091. Store Page Discussions beside the document

## Status

Accepted.

## Context

A Discussion needs durable authorship, permissions, queryable Comments and Ask
state. Text selections need anchors that survive edits and travel with Blocks
between Pages.

## Decision

The Library Module owns Discussion and Comment records in Core. The Page
document stores a BlockNote comment mark whose `threadId` carries the Discussion
identity. Core reconciles mark occurrences, owning Page, starting Block and
anchor state in the transaction that materializes a document update. The index
can be derived from the canonical document and the Discussion's stable anchor
coordinates. A Discussion created before its mark remains readable and becomes
live upon materialization. Text quotes preserve context after loss of the
original. The Markdown projection omits comment marks.

Accepted Suggested edits apply through the existing document operation compiler
in the same LocalCommit as the decision. Core compares the selected Block range
against the original Markdown and preserves surviving Block identities and
marks. Core records the before and after content of Agent-attributed Blocks by
Run, giving revert a per-Block comparison against current content.

An Ask is persisted with the Comment. A queue read orders entries by enqueue
time and Comment identity. Page-scoped LocalCommit delivery wakes the dispatcher
when an Ask is queued. The dispatcher fences state advancement by the last
observed state.

## Consequences

The renderer and Agent tools share the same Page authority and document
history. Resolved, stale and orphaned Discussions retain their record. A
Commenter can write Discussion content and Suggested edits. Canonical Page
edits require edit authority.

See [Page Discussions](../product-specs/page-discussions-behavior.md).
