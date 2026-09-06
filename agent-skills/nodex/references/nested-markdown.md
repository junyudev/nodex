# Nested Markdown

This reference is generated from Nodex's production Agent guide. Specification
revision: `2`.

## Authoring rules

Nested Markdown is Markdown with Nodex tags and tab-nested Blocks. Use one literal tab per child level; spaces do not nest. Example string: "▶ Toggle title\n\tChild paragraph\n\t- [ ] Child task". Send one complete string to create, replace, patch, or insert many Blocks atomically. Leading spaces remain authored content; only literal tabs express Block ancestry. Blank physical lines are ignored. An insertion must contain at least one Block; use <empty-block/> for an intentional empty Block. Markdown headings, lists, tasks, quotes, and code create ordinary Blocks; Nodex tags include <mention-thread>, <mention-date>, Page references, attachments, and agent configuration. <page uuid="…" /> is the wire tag for an owning Page shell and may only preserve or reorder a Page already owned by the same body. <page-ref url="nodex://pages/…" /> is a non-owning Page reference. Use Page creation, move, or duplicate operations for owning Pages. A complete body is limited to 2097152 UTF-8 bytes. Read the structured Block representation before identity-sensitive Block edits. Page titles use a single-line inline subset with styles, links, thread mentions, and date mentions; titles reject Block syntax, tabs, line breaks, attachments, agent configuration, and Page Blocks.

For the CLI, translate dynamic-tool wording to the equivalent native workflow:
use `nodex read` before identity-sensitive edits and use semantic `nodex page`
or `nodex block` commands for owning Pages. Write complete bodies through a
file so literal tabs and user text are preserved exactly.

## Round-trip examples

```nested-markdown
# Launch plan
Context paragraph
	- [ ] Confirm scope
	- [x] Record decision
```

```nested-markdown
> Important
	Nested explanation
```

```nested-markdown
<page-ref url="nodex://pages/PAGE_BLOCK_ID" />
```

Each example is parsed and serialized by the production Nested Markdown codec
during artifact generation. A mismatch fails generation.
