# ADR 0045: Page mention, reference, link, and ownership semantics

## Status

Accepted

## Context

A Page may appear inside another Page as inline prose, a live block preview, a normal hyperlink, or an owned child.
These presentations require distinct storage shapes so insertion commands, paste behavior, authorization, and derived references agree about identity and ownership.

## Decision

Nodex defines four distinct Page occurrences:

- A **Page Mention** is an atomic inline occurrence with only a canonical Page ID.
- A **Page Reference Block** is a non-owning `pageRef` shell with its own Block ID and a target Page ID.
- A **Page Link** is an ordinary link whose `href` is a canonical `nodex://pages/<page-id>` deeplink.
- An **Owning Page Shell** is a childless `page` Block created and moved only by Core Page lifecycle operations; it establishes containment.

The first three are presentations of a stable Page identity.
They never change Page parentage, membership, grants, or copy closure.
Only the owning shell changes containment.

Canonical inline NFM uses `<mention-page url="nodex://pages/..." />`.
The atom stores only the Page ID and resolves current display metadata under the host content-access context.
It is valid in rich Page titles and contributes deterministic identity text to plain projections without embedding target content.

`/Mention a page` rewrites the slash command to `@` and hands control to the normal `@Page` flow, which creates a Page Mention atom after selection.
`/Embed page…` chooses a target before creating a Page Reference Block.
A Page deeplink pasted over selected text creates a Page Link; at any other caret it creates a Page Mention, including on an empty line.
Embedding is an explicit presentation change: a Page Mention alone on its line can be turned into a Page Reference Block for the same Page, and turning a Page Reference Block into text keeps the Page as a Mention.
Structured clipboard data and code blocks retain their existing paste behavior.

Mentions, reference blocks, and Page links project as one Page reference edge family with a presentation discriminator and occurrence count.
Owning Page shells are not backlinks.
Reading a target or its backlinks is always filtered by the caller's existing content-access context; following an edge never expands authorization.
The durable backlink read is served from a normalized projection maintained in the same transaction as the source Document materialization.
It groups by source Page and source Block, uses bounded keyset pagination, and exposes counts only after source authorization.

Reference shells cannot be retargeted in place.
Removing a shell ends that connection identity; embedding again creates a new shell.

This decision makes Page Mention atoms valid portable rich-title content while
preserving ADR 0040's LocalCommit authority for owning structural mutations.

## Consequences

- Inline prose, block embedding, linking, and containment use different commands and wire shapes.
- Renaming a target updates rendered labels without rewriting source Documents.
- Internal Page links open through the injected content navigator and never through the system browser.
- Reference projection can aggregate all non-owning Page occurrences without treating ownership as a reference.

## Rejected alternatives

### Give every mention a Block identity

Inline atoms do not need placement or disclosure identity, and manufacturing it makes sentence editing behave like structural editing.

### Let reference creation imply nesting

That would make presentation silently mutate ownership, grants, and copy closure.

### Open `nodex://` links as generic protocols

System handling bypasses the active content-access context and loses in-app Page navigation semantics.
