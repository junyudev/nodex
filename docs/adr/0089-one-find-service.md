# ADR 0089: One service for finding Pages, Blocks, and chats

- Status: Accepted
- Date: 2026-11-18
- Owners: Nodex maintainers

## Context

People find Pages and chats in the palette, in pickers, and through Agents.
Independent queries made the same words produce different results, and the
active Project could be preferred too late to surface an older match.

## Decision

Main coordinates Find for the current Space. A query selects kinds, a place,
and a result window. Everywhere covers all readable locations. A Project is
an explicit restriction. The active Project affects ranking before results are
limited. Archived Pages and Blocks follow their active counterparts. For chat
search, strong matches precede loose ones, with active chats first in each class.

Core searches Pages and Blocks. The authorized chat catalog supplies metadata,
and the Agent Runtime supplies chat history evidence from its shared index.
The chat catalog prepares and updates its metadata index in the background,
so a first search can return immediately while a catalog becomes available.
Each source retains authority for its content. Main combines their ranked hits
and carries evidence, reveal coordinates, coverage, and truncation with each answer.

The first phase makes strong metadata matches available while indexed searches
complete. Enrichment adds evidence and new matches while preserving the relative
order of rows already shown. Palette, pickers, and the Agent `search` tool share
the results. Structured Page filters belong to Database Views and SQL.

## Consequences

Find reports incomplete sources while keeping usable results available. A Page
body match can open at its Block, and a chat history match can open at its
message when the source provides a coordinate. Existing placement and content
authorization still govern reads and actions.

The renderer retains its Core-authorized Page metadata preview. The desktop
round trip exceeded the eight-millisecond p95 budget on the dense scenario, so
the preview remains available while the service answers.
