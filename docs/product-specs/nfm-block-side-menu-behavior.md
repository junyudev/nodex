# NFM Block Side Menu Behavior

Status: Active
Last updated: 2026-08-26

## Purpose

The NFM block side menu is the block-scoped action surface for Card Stage descriptions. It opens from the editor side handle and keyboard block-action path, advertises the current block scope, and runs only actions that are real in production.

Development and Storybook may show disabled reference rows for future block links, collaboration, presentation, and AI actions. Production must not show unavailable actions.

## Scope Title

The first section title describes only the top-level action roots. Descendant blocks inside selected roots do not increase the displayed count.

- No target blocks: `Block`
- One target block: label by block type
- More than one top-level target block: `${count} blocks`
- Multi-selection always uses the count label, even when every selected root has the same block type

Single-block labels:

| Block type                          | Label                  |
| ----------------------------------- | ---------------------- |
| `paragraph`                         | `Text`                 |
| `codeBlock`                         | `Code`                 |
| `heading` with `level: 1/2/3`       | `Heading 1/2/3`        |
| `heading` with `isToggleable: true` | `Toggle heading 1/2/3` |
| `bulletListItem`                    | `Bulleted list`        |
| `numberedListItem`                  | `Numbered list`        |
| `checkListItem`                     | `To-do list`           |
| `toggleListItem`                    | `Toggle list`          |
| `quote`                             | `Quote`                |
| `divider`                           | `Divider`              |
| `image`                             | `Image`                |
| `callout`                           | `Callout`              |
| `table`                             | `Table`                |
| `pageRef`                           | `Page reference`       |
| `threadSection`                     | `Thread section`       |
| unknown or unsupported              | `Block`                |

## Production Actions

Production row order for a normal editable block is:

1. `Turn into`
2. `Color`
3. `Duplicate`
4. `Send to chat`, when the Page has an execution Project
5. `Move to`
6. `Delete`

`Send to chat` belongs to the same action group as `Duplicate`, `Move to`, and
`Delete`, immediately above `Move to`; it does not create a separate section.

`Copy link to block` and `Copy links to all` are reference-only rows in development and Storybook. Production hides them because NFM does not yet persist stable block identities across parse/serialize round trips, so generated block anchors could become stale.

`Duplicate`, `Move to`, and `Delete` operate on top-level selected roots. `Turn into` and `Color` operate on the expanded selection, including descendants. `Color` is enabled only when every selected target supports at least one color prop; text and background color submenu groups are hidden independently when unsupported.

`Send to chat` opens the same destination picker and `Send` / `Send & wrap`
modes as the text selection menu. It submits the retained top-level Block roots,
including their descendants, even after focus moves into the picker. New and
existing Chat targets establish the source Page relationship before submission.
Wrapping happens only after successful submission and preserves the selected
Blocks under the resulting Thread toggle. Image capture follows
[NFM Thread Section Image Inputs](nfm-thread-section-image-inputs.md).

`Make thread section` appears only for one selected `divider` root when the Card Stage runtime can convert dividers. Table header row/column actions appear only for one selected `table` root when table headers are supported.

For one selected Code Block, the menu prepends this Code group:

1. `Copy code`
2. `Wrap code`
3. `Language`
4. `Format code`, only when the selected language has a registered formatter

The generic production rows follow this group. `Wrap code` reads and writes renderer-local state without changing the Block Document or closing the menu. `Language` uses the canonical Code language catalog. Code Blocks do not expose a caption action. The full Code contract is defined by [NFM Editor Code Block Behavior](nfm-editor-code-block-behavior.md).

## Page connections

Page Mention, Page Reference Block, Page Link, and owning Subpage behavior is
defined by [NFM Editor Page Connection Behavior](nfm-editor-page-reference-behavior.md).
Deleting a `pageRef` removes only its non-owning shell and never deletes the target Page.

## Layout

The side menu surface is a compact dialog:

- Width: `265px`
- Max height: `70vh`
- Row height: `28px`
- Section title: `12px`, subdued token color
- Search input at the top
- Listbox semantics for rows
- Group separators at visual group boundaries
- Right-side submenu flyouts for `Turn into`, `Color`, `Move to`, `Send to chat`, and Code `Language`
- Entry/exit motion: `200ms` opacity/scale, with reduced-motion fallback
- Transform origin follows popup placement, including right-side `50%` origin behavior

The hover-only drag handle remains attached to the same Block and DOM node from
primary-button `pointerdown` until the click/cancel settles or the native drag
reaches `dragend`. A `pointercancel` after `dragstart` is the browser handing
pointer ownership to native DnD, not the end of that drag. Ancestor scrolling
may reposition or hide an idle side menu, but it must not replace a handle
during an owned pointer/drag gesture.

Exit motion is visual-only. A closing editor popover preserves its final
committed React subtree and geometry, leaves editor interaction ownership, and
is inert and hidden from assistive technology until unmounted. It must never
materialize an eventless `draggable`, link, button, input, or other native HTML
interaction from a serialized DOM snapshot.

Opening the menu establishes one structural Block selection. Its blue overlay
covers the complete selected subtree, while media Blocks remain bounded to
their own visual width. The menu never adds a second inline text-selection
paint over that overlay.

Footer metadata is optional. Production hides the footer when there is no real metadata. Storybook fixtures may provide footer text.

## Submenus

`Turn into` includes supported non-destructive NFM block conversions:

- Text
- Heading 1/2/3
- Toggle heading 1/2/3
- Bulleted list
- Numbered list
- To-do list
- Toggle list
- Quote
- Code
- Callout

The same target matrix applies to ordinary Blocks and owning Subpages. A mixed
selection is one action: every ordinary Block in the selected host forest is
reclassified, while each Subpage keeps its Block identity, contributes its
rich title as inline content, and contributes its body roots as direct
children. Those contributed body Blocks keep their types, IDs, hierarchy, and
nested owners. The sole canonical empty Page paragraph remains in the dormant
Page Document rather than appearing as an empty child.

Ordinary-only selections commit in one local editor transaction. If any Page
is present, Core commits the complete selected forest and all Page capability
changes atomically. A Canvas or Database anywhere in the expanded selection
rejects the complete action; ordinary neighbors are not partially converted.

Divider is intentionally not part of the generic `Turn into` list because converting content blocks to dividers would discard content. Divider-related conversion stays under `Make thread section`.

`Color` exposes text and background color groups only when the current expanded selection supports the target prop.

`Move to` reuses the NFM move-to popover contract: DB rows create destination cards, card rows append selected blocks into an existing card, and source roots are removed after a successful move.

## Storybook Coverage

The side menu stories cover:

- `TextBlock`
- `CodeBlock`
- `HeadingBlock`
- `ThreeBlocks`
- `CardMentionBlock`
- `ReferenceMocks`
- `NoFooterMetadata`
- Search, submenu, table, loading, empty, error, and narrow viewport states
