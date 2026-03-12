# NFM Editor Thread Section Behavior

Status: Active
Last Updated: 2026-03-12

This document describes the current notebook-style `threadSection` behavior inside the NFM / BlockNote editor.

This is intentionally narrower than the main product spec. It is the detailed source of truth for runnable prompt sections in card descriptions.

## Scope

Included:
- The `threadSection` NFM syntax and round-trip rules
- How runnable sections are delimited in the editor
- Inline row rendering in the Card Stage editor
- `Cmd/Ctrl+Enter` section send behavior
- Send confirmation and preview behavior
- Section-to-thread binding rules
- Markdown shortcut, divider conversion, and slash-menu insertion

Not included:
- Thread transcript rendering inside the Threads stage
- Codex approval/user-input cards outside the editor
- Block drag/drop or card import behavior unrelated to thread sections
- Any future inline transcript disclosure under section rows

## Overview

`threadSection` turns a card description into explicit notebook-style runnable regions.

Each section is defined by:
1. one `threadSection` marker block
2. all following sibling blocks in that same parent block collection
3. stopping at the next sibling `threadSection`

The marker itself is metadata and UI chrome. It is not included in the prompt body sent to Codex.

Typing `---` on an empty paragraph in the editor creates a `threadSection` marker by default. Persisted NFM `---` still parses and serializes as a plain divider block.

## NFM Syntax

`threadSection` is serialized as a self-closing custom block:

```text
<thread-section label="Investigate parser" thread="thr_123" />
```

Supported attributes:
- `label`: optional user-facing section label
- `thread`: optional sticky bound Codex thread id

Examples:

```text
<thread-section label="Investigate parser" />
Check how the block selection serializer behaves.
Look at copy and drag helpers.
```

```text
<thread-section thread="thr_123" />
Summarize the current implementation and propose the smallest safe refactor.
```

```text
<thread-section label="Follow-up fixes" thread="thr_123" />
- Tighten the type guard
- Add a regression test
```

## Section Boundaries

`threadSection` creates boundaries inside its immediate sibling collection.

The section body:
- includes the marker block's direct children first, if any exist
- starts immediately after the marker block
- includes all following sibling blocks until the next sibling `threadSection`
- can live at the document root or inside a parent block's `children`
- can include nested content under those sibling body blocks
- can include custom blocks such as `cardRef`, `toggleListInlineView`, images, code blocks, and toggles

The section body does not include:
- the `threadSection` marker block itself
- projected inline rows that exist only as runtime editor structure under embedded views

If a `threadSection` has no following sibling body blocks, it is considered empty.

If the description contains no `threadSection` blocks, there are no runnable notebook sections. The editor does not infer sections from existing plain dividers or headings.

When the cursor is inside nested content, the editor walks outward through ancestor sibling collections and uses the nearest enclosing `threadSection` boundary it finds.

### Boundary Examples

#### Root-level section

```text
<thread-section label="Explore" />
alpha
beta
<thread-section label="Implement" />
gamma
```

Resolved sections:
- `Explore` body: `alpha`, `beta`
- `Implement` body: `gamma`

#### Marker with direct children

```text
<thread-section />
  child-1
  child-2
lol
lalala
```

Resolved section body:
- marker direct children: `child-1`, `child-2`
- following sibling blocks: `lol`, `lalala`

#### Nested child section inside a parent block

```text
parent
  intro
  <thread-section label="Nested" />
  body-1
  body-2
  <thread-section label="Next" />
  body-3
```

Resolved nested sections inside `parent.children`:
- `Nested` body: `body-1`, `body-2`
- `Next` body: `body-3`

#### Cursor inside nested descendant content

```text
parent
  <thread-section label="Nested" />
  body-1
    body-1-child
  body-2
  <thread-section label="Next" />
  body-3
```

If the cursor is inside `body-1-child`, the editor resolves the nearest enclosing section as `Nested`, because it walks outward through ancestor sibling collections until it finds the nearest matching `threadSection`.

#### No explicit section

```text
hello
---
world
```

There is no runnable section here yet. `Cmd/Ctrl+Enter` prepares a new local section starting at the current block and opens the send confirmation dialog.

## Card Stage Rendering

In the Card Stage editor, `threadSection` renders as a divider-like row with a compact center capsule.

The row currently shows:
- section state
- editable section label
- bound thread label or a first-send placeholder
- relative time / running duration label
- `Thread` action
- `Send` action

This row is intentionally lightweight.

Current v1 non-goals:
- no inline transcript
- no expandable disclosure under the row
- no embedded assistant output inside the card description

## Label Behavior

The `label` attribute is editable directly from the section row in the Card Stage editor.

Rules:
- empty label is allowed
- when empty, the row shows a generic section placeholder instead of mutating the stored NFM
- changing the label updates only the marker block props
- the label itself is never appended to the sent prompt body unless the user separately writes it in the section content

## Thread Binding

Each section may optionally be bound to one Codex thread via the `thread` attribute.

### First send

If the section has no bound thread, clicking `Send` or pressing `Cmd/Ctrl+Enter` while inside that section:
- starts a new card-linked thread
- uses the section prompt body as the initial prompt
- writes the returned thread id into the section marker's `thread` attribute
- keeps focus in the editor

### Later sends

If the section already has a bound thread and that thread is available:
- idle thread: start a new turn
- active thread with an in-progress turn: steer that active turn

This mirrors the thread composer’s follow-up behavior instead of inventing a separate send model.

### Missing or archived thread

If a section has a stored `thread` id but the linked thread is unavailable or archived:
- the row renders as unavailable rather than pretending the section is unbound
- sending from the section starts a fresh thread and rebinds the marker to the new thread id

Rebinding to an arbitrary existing thread is out of scope for v1.

## Inline Status States

The section row resolves live state by matching its stored `thread` id against the card’s linked Codex threads.

Current states:
- `Not sent`: no bound thread id
- `Running`: bound thread is active
- `Approval`: active thread is waiting on approval
- `Waiting`: active thread is waiting on user input
- `Ready`: bound thread is idle
- `Archived`: bound thread exists but is archived
- `Error`: bound thread is in system error state

Time label behavior:
- active thread: shows a lightweight `for ...` running label derived from the linked thread’s latest update timestamp
- inactive thread: shows a relative `... ago` label from the same timestamp

This is intentionally approximate v1 status chrome, not a durable execution-timer contract.

## Keyboard Behavior

### `Cmd/Ctrl+Enter`

In the Card Stage editor:
- when the cursor is inside a `threadSection` region, `Cmd/Ctrl+Enter` prepares that section for send
- this includes nested child regions, where a child `threadSection` sends its following siblings in the same parent block
- by default, the editor opens a confirmation dialog with a plain-text preview before the send actually happens
- the confirmation dialog includes a `Do not ask again` checkbox
- the dialog preference is reversible in Settings -> Editor -> `Confirm thread section send`
- the shortcut is handled at the editor surface, not by the Threads stage composer
- successful send does not move focus to the Threads stage

### Toggle exception

If the current cursor block is a toggle header or toggle heading:
- the editor preserves toggle behavior
- `Cmd/Ctrl+Enter` does not hijack that keypress for section sending

This prevents notebook sending from breaking an existing toggle editing affordance.

### No explicit section

If the user presses `Cmd/Ctrl+Enter` without being inside an explicit `threadSection`:
- the editor prepares a new section starting at the current block in the current sibling collection
- confirming the send inserts a new `threadSection` marker immediately before that current block
- the confirmation dialog explicitly tells the user that a new section marker will be created

## Send Confirmation Dialog

By default, sending a thread section goes through a confirmation dialog.

The dialog shows:
- the resolved section title
- whether the send will reuse an existing thread or start a new one
- whether a new `threadSection` marker will be inserted first
- the plain-text preview that will be sent to Codex
- a `Do not ask again` checkbox

Rules:
- the preview is the exact structured plain-text payload that will be sent to Codex
- the dialog appears for both row `Send` clicks and `Cmd/Ctrl+Enter`
- if the user confirms, the dialog closes immediately and the inline section row becomes the source of pending/running status
- if the user confirms with `Do not ask again`, future sends skip the dialog until the setting is re-enabled
- if the section is empty, the editor still shows the empty-section hint instead of opening the dialog

## Actions And Entry Points

The current ways to create or convert a section are:

1. Markdown shortcut: type `---` on an empty paragraph
2. Slash menu: `Thread Section`
3. Drag-handle menu on a plain divider: `Convert to thread section`
4. Raw NFM editing / pasted NFM using `<thread-section ... />`

The current ways to act on a section are:

1. Row `Send` button
2. `Cmd/Ctrl+Enter` while cursor is inside that section
3. Row `Thread` button to open the bound thread in the Threads stage

## Divider Conversion

Typing `---` at the start of an empty paragraph uses the editor shortcut path to insert:

```text
<thread-section />
```

Existing divider block behavior is unchanged:

```text
---
```

It remains:
- a visual separator
- serializable as `---`
- non-runnable
- metadata-free

When converted through the drag-handle menu, only the selected divider block changes type.

The conversion result is a fresh runnable marker:

```text
<thread-section />
```

No surrounding content is moved or rewritten during conversion.

## Prompt Extraction

When sending a section, the editor serializes only that section body into the same structure-preserving plain-text format used for copy `text/plain`.

Serialization rules:
- preserve the existing sibling-block order inside the section
- include the marker block's direct children before later sibling body blocks
- preserve nested children under those sibling body blocks
- strip nested `threadSection` markers and their scoped body blocks from descendant subtrees so parent sends do not duplicate child-section prompts
- preserve toggle open/closed state through the same DOM-backed toggle-state extraction used by normal description save
- strip projected runtime-only inline rows before prompt serialization
- exclude the `threadSection` marker block itself

This means the prompt sent to Codex is a structure-preserving plain-text slice of the section, not the whole card description.

### Prompt Extraction Examples

#### Example 1: Root-level section

Editor content:

```text
<thread-section thread="thr_a" />
hello
world
<thread-section thread="thr_b" />
later
```

If the user presses `Cmd/Ctrl+Enter` inside `world`, the prompt is:

```text
hello
world
```

#### Example 2: Marker direct children are included

Editor content:

```text
<thread-section thread="019ce177-fb42-7a10-9ecf-06e68c6c449a" />
  child-1
  child-2
lol
lalala
```

If the user presses `Cmd/Ctrl+Enter` inside `lol`, the prompt is:

```text
child-1
child-2
lol
lalala
```

The marker block itself is excluded, but its direct children are included before the later sibling blocks.

#### Example 3: Nested child section owns only its sibling range

Editor content:

```text
parent
  intro
  <thread-section thread="thr_nested" />
  child-a
  child-b
  <thread-section thread="thr_next" />
  child-c
```

If the user presses `Cmd/Ctrl+Enter` inside `child-b`, the prompt is:

```text
child-a
child-b
```

The later nested marker starts a new nested section, so `child-c` is excluded.

#### Example 4: Parent prompt excludes nested child thread-section ranges

Editor content:

```text
<thread-section thread="019ce177-fb42-7a10-9ecf-06e68c6c449a" />
hello
  <thread-section thread="019ce1c3-f463-7702-9092-57938f1f9453" />
  hi
aaa
asd
asdasd
```

If the user presses `Cmd/Ctrl+Enter` inside `asd`, the prompt is:

```text
hello
aaa
asd
asdasd
```

The nested child `threadSection` and its scoped body `hi` are stripped from the parent prompt so parent and child sections do not duplicate each other.

#### Example 5: Empty section

Editor content:

```text
<thread-section label="Empty" />
<thread-section label="Next" />
hello
```

If the user presses `Cmd/Ctrl+Enter` inside `Empty`, the section is considered empty and the editor shows the empty-section hint instead of sending a prompt.

#### Example 6: No section yet, auto-create before send

Editor content:

```text
hello
world
later
```

If the user presses `Cmd/Ctrl+Enter` inside `world`, the confirmation dialog explains that a new `threadSection` will be inserted before `world`.

If the user confirms, the editor inserts:

```text
hello
<thread-section />
world
later
```

The prompt sent from that new section is:

```text
world
later
```

#### Example 7: Plain divider stays out of prompt semantics

Editor content:

```text
<thread-section />
hello
---
world
```

If the user presses `Cmd/Ctrl+Enter` inside `world`, the prompt is:

```text
hello
---
world
```

The plain divider remains normal content inside the explicit thread section. It does not create a new prompt boundary.

#### Example 8: Confirmation dialog preview and suppression

When the dialog opens for a section send:
- it shows the plain-text content that will be sent
- it indicates whether the send reuses an existing thread or starts a new one
- it may note that a new `threadSection` will be inserted first

If the user checks `Do not ask again` and confirms:
- the send proceeds immediately
- later sends skip the dialog
- the user can re-enable the dialog in Settings -> Editor -> `Confirm thread section send`

## Focus And Navigation

On successful section send:
- editor focus is restored back to the card description
- the Card Stage does not auto-switch to the Threads stage
- the bound thread continues to update through the existing linked-thread state

Opening the bound thread remains an explicit action through the section row or the card’s Threads property row.

## Failure Behavior

Current editor-side failure cases:
- no explicit `threadSection` around the cursor -> show hint
- empty section -> show hint
- Codex start/send failure -> show inline error hint and keep editor focus

The failure hint is local to the editor surface and does not replace the Threads stage’s own runtime error handling.

## Examples

### New section, first send

```text
<thread-section label="Parser audit" />
Read the parser and serializer.
List any asymmetries.
```

After first successful send, the description persists as:

```text
<thread-section label="Parser audit" thread="thr_123" />
Read the parser and serializer.
List any asymmetries.
```

### Two explicit runnable regions

```text
<thread-section label="Explore" thread="thr_a" />
Read the existing implementation.
Summarize edge cases.

<thread-section label="Implement" thread="thr_b" />
Make the smallest safe change.
Add regression coverage.
```

Pressing `Cmd/Ctrl+Enter` inside `Explore` sends only the first body.
Pressing `Cmd/Ctrl+Enter` inside `Implement` sends only the second body.

### Existing plain divider remains non-runnable

```text
Research notes
---
Implementation notes
```

This does not create 2 notebook sections. Only typing a fresh `---` in the editor creates a `threadSection` marker at input-rule time.

## Source Of Truth

The narrow implementation source of truth for this feature is:
- shared NFM shape and parsing/serialization
- Card Stage editor rendering and keyboard behavior
- linked Codex thread summary state used by the section row

If this behavior changes, update this document before or alongside broader product-spec text.
