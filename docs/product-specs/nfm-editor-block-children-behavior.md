# Page Editor Block Children Behavior

## Scope

This document owns the current Block children capability contract shared by the
editable BlockNote surface, readonly rendering, Nodex Markdown, Core validation,
structural operations, history restore, and Store migration.

## Capability contract

Every current Block type declares both whether it accepts generic child Blocks
and how those children are presented. The registry is closed: a new Block type
must declare a rule before it can enter a current document.

| Parent type                                                        | Accepts children                   | Presentation                                     |
| ------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------ |
| `paragraph`, `bulletListItem`, `numberedListItem`, `checkListItem` | Yes                                | Indented child group                             |
| `toggleListItem`                                                   | Yes                                | Disclosure child group                           |
| `heading`                                                          | Only when `isToggleable` is `true` | Disclosure child group when enabled              |
| `quote`, `callout`                                                 | Yes                                | Children remain inside the same visual container |
| `codeBlock`, `table`, `divider`, `image`                           | No                                 | Atomic leaf                                      |
| `page`, `database`, `canvas`                                       | No                                 | Independently owned resource shell               |
| `pageRef`, `databaseViewRef`, `syncedBlockRef`, `templateRef`      | No                                 | Reference leaf                                   |

Normal headings are never changed into toggle headings merely to retain an
illegal child edge.

The empty Nodex Markdown string reads as one empty `paragraph`. Blank lines
separate Blocks; an explicit empty paragraph between Blocks is written as `<br>`.

## Editing and structural behavior

Tab nesting, drag/drop, paste/import, programmatic Block commands, Turn into,
and synchronized updates obey the same capability registry. Local structural
transactions that would give a leaf Block children are rejected before they
enter the collaborative Y.Doc. Core validates the complete candidate tree
before persistence, so remote and non-renderer writers have the same boundary.

Turn into disables leaf targets when an ordinary selected Block already owns
children. Turning a Page into a container keeps its body roots as children;
turning it into a leaf places those roots immediately after the new Block as
siblings. Both forms preserve Block IDs and visible reading order.

## Rendering

The outer Block container publishes its content type, child layout, and
children acceptance as semantic data attributes. Callout background, radius,
and padding belong to that outer container, so its header and descendants form
one surface. Quote border and inset likewise wrap the complete subtree.

Paragraph and heading content use valid DOM structure: nested Block containers
are siblings of their text element, never descendants of a `<p>` or heading
element. Checkbox rows keep their control and inline content in one row while
their child group renders below it.

Mounted Block controls and subscriptions belong to the Block's stable ID.
Reordering or replacing Blocks must not transfer disclosure state, empty-child
actions, checkbox actions, or embedded views to a different Block, even when
their content is identical. An expanded empty toggle shows its add-child action
under its own header; a toggle with children never shows that action. This
remains true during selection changes, synchronized placement, and history
replay without reloading the Page.

## Persistence invariant

Current Page Documents use `nodex.page@4`; Synced Block Documents use
`nodex.synced-block@3`; Reusable Template Documents use
`nodex.reusable-template@3`. Current runtime and restore paths recognize only
these versions.

Stored Documents are normalized before current runtime opens them. When a leaf contains children, each child root is promoted
immediately after that leaf, recursively and in original order. The migration
preserves IDs, content, properties, descendants, and depth-first visible order;
running the normalizer again makes no change. Heads receive a current-schema
full snapshot, and retained versions are re-encoded to the current schema.
Authenticated clipboard and Undo payloads adapt to the same current contract
after their original bytes are verified.

The upgrade preflights every head and retained version before writing. An
unpublished schema or unknown Block vocabulary fails atomically.
