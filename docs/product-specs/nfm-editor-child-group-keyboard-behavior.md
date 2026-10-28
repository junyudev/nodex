# Page Editor Child-Group Keyboard Behavior

Status: Active
Last Updated: 2026-10-28

This document describes the current `Enter` and `Backspace` behavior for nested child groups inside the BlockNote Page editor.

This is intentionally narrower than the main product spec. It is the detailed source of truth for child-group keyboard overrides implemented in:

- `src/renderer/components/board/editor/child-group-enter.ts`
- `src/renderer/components/board/editor/child-group-backspace.ts`
- `src/renderer/components/board/editor/nfm-editor-extensions.ts`

## Scope

Included:

- When the custom `Enter` and `Backspace` handlers run
- The precedence order between the `Enter` handlers
- Which parent/child shapes are eligible
- The exact structural mutations performed by the ProseMirror helpers
- Cursor placement after each handled mutation

Not included:

- Composer `Enter` behavior outside the editor
- Link-menu or find/replace `Enter` handling
- Generic BlockNote default keyboard behavior when these handlers do not match

## Overview

The editor installs 2 custom keyboard extensions for nested child-group editing:

- `child-group-enter`
- `child-group-backspace`

Their purpose is to preserve predictable parent/child editing semantics for parent blocks that accept children, instead of falling back to BlockNote's default nested-block unindent/lift behavior.

At a high level:

- `Enter` on an empty leaf child creates another sibling child instead of unindenting
- `Enter` inside a parent header with existing children can split the trailing header text into a new first child
- `Enter` at the end of an open toggle header with no children creates its first child
- `Backspace` at the start of a nested classic list child or toggle list child exits list formatting in place
- other `Backspace` cases at the start of a leaf child merge that child upward into the previous sibling or the parent instead of lifting/unindenting it

## Eligible Parent And Child Shapes

The generic child-group handlers are schema-gated.

A parent is eligible for the generic child-group rules only when:

- the child has a parent block
- the shared children capability accepts the parent type and properties

That means these handlers are intentionally broader than toggle-only logic. Any current parent that accepts child blocks can participate.

Examples covered by the current code and tests:

- `paragraph`
- `heading`
- `toggleListItem`
- toggleable `heading`
- `callout`
- `quote`
- `bulletListItem`
- `numberedListItem`
- `checkListItem`

Leaf parents are excluded.

Examples:

- `image`
- any other block whose children capability is `never`

For both `Enter` and `Backspace`, the generic child-group logic only handles leaf child blocks:

- if the current child block itself has children, the custom handler returns `false`

## Extension Wiring And Precedence

`child-group-enter` is registered with `runsBefore` ahead of these built-in shortcut extensions:

- `toggle-list-item-shortcuts`
- `bullet-list-item-shortcuts`
- `check-list-item-shortcuts`
- `numbered-list-item-shortcuts`

This ensures the custom child-group `Enter` policy gets first chance to intercept the key before BlockNote's default list-item `Enter` handlers.

Within the custom `Enter` extension, the handlers run in this exact order:

1. `handleChildGroupEmptyEnter(...)`
2. `handleParentEnterSplitToFirstChild(...)`
3. `handleToggleEnterToChild(...)`

The first handler that returns `true` owns the key event and stops the chain.

`child-group-backspace` runs one custom handler:

- `handleChildGroupBackspace(...)`

If a handler returns `false`, the key falls through to downstream/default editor behavior.

## Enter Behavior

There are 3 distinct `Enter` paths.

### 1. Empty Leaf Child At Start Creates A Sibling

Handler:

- `handleChildGroupEmptyEnter(...)`

This path runs only when all of the following are true:

- the cursor is inside the current block
- the current block exists
- the current block is a leaf child with no children
- the current block has a parent
- the parent is an inline-content parent
- the selection is collapsed
- the caret is at offset `0` inside the current block
- the current block content size is `0`

Behavior:

- inserts a new empty paragraph block after the current child
- keeps the new block in the same child group
- moves the text cursor to the inserted sibling
- focuses the editor

Resulting semantics:

- pressing `Enter` on an empty child at its start does not unindent the child
- it creates another child row at the same nesting level

Notes:

- this path works for any inline parent, not just toggles
- a non-empty child is not handled by this path
- a range selection is not handled

### 2. Parent Header Split Creates A New First Child

Handler:

- `handleParentEnterSplitToFirstChild(...)`

This path runs only when all of the following are true:

- the cursor is inside the parent block itself
- the parent block exists
- the parent is an inline-content parent
- the parent already has at least one child
- the selection is collapsed
- the caret is not at the start of the parent content
- the caret is still within the parent inline content

At the guard level, this is effectively:

- `parentOffset > 0`
- `parentOffset <= parent.content.size`

Behavior:

- splits the parent's inline content at the caret
- keeps the leading content in the parent
- moves the trailing inline content into a newly created paragraph child
- inserts that new child as the first child of the parent
- focuses the editor

Important detail:

- if the caret is at the end of the parent content, the new first child is still created, but it is empty

This means:

- `Enter` in the middle of a parent header turns the text after the caret into the first child
- `Enter` at the end of a parent header with existing children creates an empty first child before the parent's existing children

### 3. Open Toggle Header At End Creates Its First Child

Handler:

- `handleToggleEnterToChild(...)`

This is a toggle-specific fallback. It runs only when all of the following are true:

- the current block is a recognized toggle block
- the block has no children yet
- the toggle is open in the DOM
- the selection is collapsed
- the header content is non-empty
- the caret is at the end of the header content

Recognized toggle blocks are:

- `toggleListItem`
- `heading` with `props.isToggleable === true`

Open-state detection is DOM-based:

- the handler looks for `.bn-block[data-id="<blockId>"] .bn-toggle-wrapper`
- it requires `data-show-children="true"`
- if `domElement` is missing or the wrapper is not marked open, this handler returns `false`

Behavior:

- appends one empty child paragraph to the toggle block
- moves the cursor into that first child
- focuses the editor

Important limits:

- collapsed toggles are not handled
- empty toggle headers are not handled
- toggles that already have children are not handled
- non-toggle inline parents are not handled by this fallback

## Backspace Behavior

There are 2 `Backspace` paths.

### 1. Nested List-Like Child Exits List Formatting In Place

Handler:

- `handleChildGroupBackspace(...)`

This path runs only when all of the following are true:

- the cursor is inside the current block
- the current block exists
- the current block is a leaf child with no children
- the current block has a parent
- the parent is an inline-content parent
- the selection is collapsed
- the caret is at offset `0` inside the current block
- the current block type is one of:
  - `bulletListItem`
  - `numberedListItem`
  - `checkListItem`
  - `toggleListItem`

Behavior:

- updates the current child block in place to `paragraph`
- clears list formatting instead of merging upward
- keeps the child at the same nesting level under the same parent
- focuses the editor

Important semantics:

- this matches root-level list-item Backspace semantics more closely
- this applies whether the child is empty or non-empty
- this applies whether the child is the first, middle, or tail child in its sibling collection
- this runs before the generic upward-merge path
- the current source child block is not removed

Examples:

- a nested checklist middle child at `|222` becomes a paragraph child `|222` in the same child group
- an empty nested bullet-list middle child becomes an empty paragraph child in place
- a nested numbered-list first child also resets to paragraph in place
- a nested toggle-list child also resets to paragraph in place at block start

### 2. Other Leaf Child At Start Merges Upward

Handler:

- `handleChildGroupBackspace(...)`

This path runs only when all of the following are true:

- the cursor is inside the current block
- the current block exists
- the current block is a leaf child with no children
- the current block has a parent
- the parent is an inline-content parent
- the selection is collapsed
- the caret is at offset `0` inside the current block
- both the target block content and current block content are inline-content arrays

Merge target selection:

- if the child has a previous sibling, merge into that previous sibling
- otherwise merge into the parent block itself

Behavior:

- deletes the source child block
- appends the source child's inline content to the target block
- places the cursor at the join point
- focuses the editor

Important semantics:

- this applies whether the child is empty or non-empty
- this applies to first, middle, and tail children
- this does not depend on toggle open/closed DOM state
- this is not toggle-specific; any inline parent can participate
- nested classic list items and toggle list items are excluded from this path because they exit list formatting in place first

Examples:

- first child of a paragraph parent merges into the parent
- middle child of a toggle merges into the previous sibling child
- tail child of a quote/list/toggle still merges upward instead of falling back to default nested-block behavior

## ProseMirror Mutation Details

The high-level handlers only decide whether the key should be intercepted.

The structural edits that need stable cursor placement happen in ProseMirror helpers inside `nfm-editor-extensions.ts`.

### `splitParentIntoFirstChild(...)`

Used by:

- `handleParentEnterSplitToFirstChild(...)`

Algorithm:

1. resolve the parent node by block id
2. verify it is a block container with a child container
3. compute the current selection position inside the parent's inline content
4. slice the trailing inline content from the split point to the end of the parent content
5. if the split is not already at the end, delete that trailing content from the parent
6. create a new paragraph node containing the trailing inline content
7. wrap that paragraph in a `blockContainer`
8. insert it at the first-child slot of the parent's child container
9. place the ProseMirror `TextSelection` inside the new child paragraph near its start

Consequences:

- existing children are preserved and shifted after the newly inserted first child
- middle-of-header splits move real trailing text into the new child
- end-of-header splits still create an empty first child

### `mergeIntoBlock(...)`

Used by:

- `handleChildGroupBackspace(...)`

Algorithm:

1. resolve both target and source nodes by block id
2. verify both are block containers
3. compute the join point as the end of the target's existing inline content
4. capture the source inline content
5. delete the source block from the document
6. if the source block was the only child in its `blockGroup`, delete the entire now-empty `blockGroup`, not just the outer block wrapper
7. map the original join point through the deletion
8. insert the source inline content at the mapped join point if it is non-empty
9. set the ProseMirror `TextSelection` to that join point

Consequences:

- the cursor lands between the target's original content and the moved source content
- empty-child merges still remove the source child and place the cursor at the join point
- deleting the empty `blockGroup` avoids leaving a dead child container around when the last child is merged away

## Cases Explicitly Not Handled

These custom handlers intentionally return `false` for the following cases:

- the current block cannot be resolved
- the parent block cannot be resolved
- the relevant parent is not an inline-content block
- the selection is a range instead of a caret
- the current child is not a leaf child
- the current or target content is not stored as an inline-content array

Additional `Enter` non-match cases:

- empty-child path: current child is non-empty
- empty-child path: caret is not at offset `0`
- parent-split path: parent has no children
- parent-split path: caret is at offset `0`
- toggle fallback: block is not a recognized toggle
- toggle fallback: toggle already has children
- toggle fallback: toggle is collapsed in the DOM
- toggle fallback: toggle header is empty
- toggle fallback: caret is not at the end of the header

When any of those conditions are not satisfied, the editor falls back to downstream/default behavior.

## Behavioral Summary

The current contract is:

- child-group `Enter` and `Backspace` behavior is owned by inline-parent schema gating, not by toggle-only type checks
- `Enter` handling is deterministic and ordered: empty child sibling creation first, parent split second, toggle fallback third
- `Backspace` at the start of a nested classic list child or toggle list child exits list formatting in place
- other `Backspace` cases at the start of a leaf child merge upward instead of unindenting
- structural split/merge operations are done at the ProseMirror level so cursor placement remains stable

## Source References

Primary implementation:

- `src/renderer/components/board/editor/child-group-enter.ts`
- `src/renderer/components/board/editor/child-group-backspace.ts`
- `src/renderer/components/board/editor/nfm-editor-extensions.ts`

Current regression coverage:

- `src/renderer/components/board/editor/child-group-enter.test.ts`
- `src/renderer/components/board/editor/child-group-backspace.test.ts`
