# Page History Revisions

Status: Active
Last Updated: 2026-10-28

This document defines Page revision previews, restoration, and retention. The
owned Document is the authority for the Page's rich title and body. History
retains immutable semantic snapshots of that content.

## Revision Content

A revision preserves the stable-ID Block tree, rich Page title, and exact File
versions and frozen default names used by the content. Markdown text, plain text,
previews, references, and asset projections are derived from that snapshot.
Markdown text is never restoration authority.

Human editing records bounded safety, active, and idle revisions. Semantic
commands record immediate revisions linked to their mutation evidence. Reading a
revision does not load or replace the live collaborative Document.

## Page History

Page History combines content revisions with property, Database, lifecycle, and
relocation activity. The default view shows revisions grouped by date and a
non-restorable `Current` item. Activity is available separately.

The panel loads the selected revision's detail on demand and renders its body
through the read-only Page preview. Revision previews and exact Nodex Markdown
are projections of the retained Blocks. Only compatible Document revisions offer
restoration; activity evidence alone cannot restore content.

## Restoration

Restoration prepares against the current Document boundary, preserves current
state in a safety revision, and applies the selected title and Blocks as a new
forward mutation. It records the resulting receipt and revision without
rewinding collaborative causality.

The same commit restores exact File content bindings. Matching live Files are
reused; changed targets are forked, while Page paths remain independent. A
preview without exact File evidence cannot silently restore current File bytes.

## Retention

Named and restore revisions are pinned. Unpinned revisions follow the Document
retention policy. Removing a revision can expire its content preview without
rewriting immutable mutation evidence or removing its activity record.

The retention and collection contract is owned by
[Document Sync, History, and Retention](../reliability/document-sync-history-and-retention.md).

## Related Documents

- [Main product spec](./nodex-product-spec.md)
- [Reliability](../RELIABILITY.md)
- [Nodex Markdown](../references/nodex-markdown.md)
