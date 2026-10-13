# NFM Editor Slash Menu Behavior

Status: Active
Last updated: 2026-08-27

## Purpose

The NFM slash menu is the editor's insertion catalog. It exposes only commands
that Nodex has deliberately named, illustrated, ordered, and connected to a
current NFM capability. The menu must not grow implicitly when an editor
dependency adds another default command.

Typed trigger boundaries and suggestion-session dismissal are owned by
[NFM Editor Suggestion Menu Behavior](nfm-editor-suggestion-menu-behavior.md).

## Catalog

Available items appear in this group and item order. Capability-dependent rows
are omitted when their runtime is unavailable.

1. `Text`: Text, Heading 1/2/3, Toggle heading 1/2/3, Emoji, Inline equation
2. `Lists`: Bulleted list, Numbered list, To-do list, Toggle list
3. `Blocks`: Quote, Callout, Code, Code - Mermaid, Block equation, Divider, Table, Image
4. `Pages`: Subpage, Mention a page, Embed page, Canvas
5. `Agent`: Thread Section, Agent Config

Heading 4/5/6 are intentionally absent. Unknown dependency-provided items are
also absent until Nodex gives them a product role, icon, placement, and tested
insertion behavior.

Callout uses the ordinary slash replacement boundary: choosing it converts the
empty slash paragraph into a Callout without creating an extra sibling. Table
uses the NFM table initializer rather than a dependency default.

Canvas, Subpage, Mention a page, and Embed page appear only when the current
host exposes the corresponding capability. Page connection semantics are
owned by
[NFM Editor Page Connection Behavior](nfm-editor-page-reference-behavior.md).
Thread Section insertion is owned by
[NFM Editor Thread Section Behavior](nfm-editor-thread-section-behavior.md).

## Vocabulary and presentation

Block types shared with `Turn into` use the same canonical label and the same
20px block-type icon in both menus. This includes Text, Heading 1/2/3, Toggle
heading 1/2/3, Bulleted list, Numbered list, To-do list, Toggle list, Quote,
Callout, and Code. One shared icon resolver owns their presentation so the two
menus cannot drift independently.

Slash-only commands use Nodex-owned semantic icons in the same 20px slot.
Search aliases remain available without being repeated as visible shortcut
hints. A row shows a right-side hint only for compact, meaningful syntax or a
keyboard shortcut.

## Isolated coverage

Behavioral coverage verifies canonical wording and group transitions, rejects
Heading 4/5/6 and unknown commands, proves that dependency icons cannot leak into the rendered
catalog, and exercises Callout insertion through the editor replacement
boundary.
