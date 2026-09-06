# ADR 0060: Content history follows interaction order within a window

Status: Accepted; supersedes the per-surface chronology decision in ADR 0058.

Page body, Page title, and Database View actions share one chronological history
within a renderer window's Library, access context, and Store epoch. Focus selects
the input boundary, not the content action to reverse. Typed participants retain
their own inverse resources and presentation capabilities; one interaction owner
admits commands, orders replay, and bounds the reachable interval. Combining
independent stacks by focus or timestamps cannot preserve pending gesture order
or prevent native typing from merging across a Database action.

## Consequences

- Native capture groups close before another participant's local capture or a
  durable command can join the timeline. Remote updates remain outside local
  history, and canonical Documents remain separate content authorities.
- Forward results are typed to their participant. Shared replay reports status
  and action identity; only the originating participant interprets the receipt
  and applies presentation. Undo never needs to focus another Page to execute.
- Retained runtime resources outlive their DOM attachments. Final resource
  disposal retires the affected chronological prefix, not holes through which
  older actions could become the next Undo. Unknown sent outcomes retain a
  barrier and their exact Main recovery responsibility.
- Native input drafts, Composer drafts, Canvas scene editing, and embedded
  file editing keep independent input boundaries. Other windows and different
  authorization contexts never inherit this timeline.
- Core remains the authority for inverse capability validity and semantic
  address recovery. The address, retention, and durable recovery decisions in
  [ADR 0058](0058-surface-history-and-semantic-address-recovery.md) remain in force.

User behavior belongs to [NFM structural editing](../product-specs/nfm-editor-structural-editing-behavior.md)
and [Database Pages and Views](../product-specs/database-pages-and-views-behavior.md).
