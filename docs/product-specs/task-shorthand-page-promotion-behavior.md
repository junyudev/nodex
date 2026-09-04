# Task Shorthand Page Promotion Behavior

## Scope

Task shorthand is an authoring aid for promoting ordinary NFM Blocks into Database Pages.
It is not a Page-title syntax, a renderer-side Property mutation, or a configurable rule engine.

## Grammar

Version 1 recognizes a compact prefix token at the first character of a rich title, followed by one or more whitespace characters and a non-empty title:

```text
<priority><estimate?><tags?> <title>
```

- Priority is `0`, `1`, `2`, or `3`.
- Estimate is optional and ASCII case-insensitive: `XS`, `S`, `M`, `L`, or `XL`.
- Tags are optional, comma-separated names inside one parenthesized group.
- Tags are trimmed with the Unicode `White_Space` property, NFC-normalized,
  de-duplicated in first-seen order, limited to 32 names, reject Unicode control
  characters, and use the Database option-name bound.
- The prefix is limited to 1024 UTF-8 bytes.
- The required separator uses the Unicode `White_Space` property.
- Parsing may cross adjacent styled text spans, but never strips across a Link, mention, line break, or other rich-text atom. A token that would become a candidate only by flattening across such a boundary is preserved as a rich-text boundary rejection; a complete token and separator before the boundary may still apply to the following rich title.
- Leading whitespace, P4, empty tag segments, missing titles, and every colon form remain literal.
- A compact prefix is not a shorthand candidate until the complete prefix is
  followed by whitespace. Candidate recognition precedes validation, so
  ordinary titles such as `3abc`, `4abc`, `3XLabc`, and malformed-looking runs
  without a separator are `no_match`, not rejected shorthand.

Examples:

```text
1XL(ui, unclear) Fix import  →  Fix import · P1 · XL · ui · unclear
1 Investigate               →  Investigate · P1
1XL(ui): Fix import          →  literal title
4abc                        →  literal title, no shorthand evidence
4 Later                     →  preserved invalid shorthand candidate
```

## Commit authority

The renderer submits only `literal` or `task_shorthand_v1` as the Page-promotion policy.
Core reads the exact durable rich title and target Data Source schema, then compiles title rewrite, Property values, missing tag options, membership, View group, View position, and source move/copy into the existing atomic `BlockTransfer` mutation.

Each root is independently all-or-literal.
A root is stripped only when every shorthand field can be represented without loss.
Priority or Estimate conflicts with the direct target grouping or
position-derived writable sort values preserve the complete title; the chosen
drop position wins, matching scalar values merge, and Tags merge as a set.
Existing Tags options are reused by exact NFC name.
Missing Tags options are created only with schema authority and within the option bound; otherwise the affected root remains literal while other roots may still apply.

The typed transfer evidence reports `not_requested`, `not_applicable`, `no_match`, `applied`, or `preserved` and identifies the applied canonical option IDs.
A real mutation error still rolls back the entire transfer batch.

## Interaction

The Pages setting exposes one preference: **Task shorthand on Block → Page**.
New Profiles default to Off.
When either former parse or strip preference exists, the pair migrates to On only when neither was explicitly Off; the legacy keys are then removed.

Static authoring feedback is presentation-only.
A quiet inline decoration marks a recognized prefix; it never adds a trailing summary chip, changes the document model, enters Yjs, or changes clipboard serialization.
Hovering the prefix or placing the caret within it reveals only the parsed result, for example `P1 · XL · 2 tags`.
The window-local drag session may carry a compact preview hint, but serialized native drag data continues to contain stable IDs and type hints only.

Database View drag feedback describes Move/Copy, Page count, and the predicted shorthand summary across Board and List layouts.
Drag feedback uses only the window-local active session and MIME type because native drag payload data is protected before `drop`; presentation feedback must never gate whether the destination accepts the drop.
Alt/Option selects Copy.
Shift forces `literal` for that drop and composes with Alt/Option.
After commit, applied or preserved outcomes are aggregated into one quiet notification; ordinary literal drops stay silent.

Core evidence is final.
The authoring preview is deliberately visible but non-authoritative.

## Undo

Core persists the inverse recipe with the durable Block → Page mutation and
explicitly identifies batches with a complete symmetric capability. Those
promotions and List reorders share one chronological session history, so
Command/Ctrl+Z reverses the latest eligible Database View action after Board/List
layout changes. The success notification invokes that same history rather than
retaining a separate callback snapshot. A batch without a complete inverse leaves
a barrier and no notification Undo action; the unused one-way token is released.

Move Undo removes the promoted Page from its destination and restores the original source Block tree and rich title in one durable mutation.
Copy Undo removes only the copied Page from its destination and leaves the source unchanged.
The explicit Core-only single-direction transfer Undo can also remove tag options
created solely by the transfer and restore the Tags schema. That capability is
not admitted into interactive surface history without complete symmetric coverage.

Core separately returns a structural `history` capability for a complete
symmetric inverse. It retains the same Page, Document, membership, Page Key,
Property values and manual positions across repeated Undo and Redo. Schema
changes and Relation-carrying batches do not advertise that capability; their
explicit transfer Undo token must not be treated as a promise of symmetric
surface history. Required destination access, schema and Relation evidence,
Document heads and File versions are checked before replay changes content.

Undo is revision-fenced.
Core rejects the entire inverse mutation if the source Document, promoted Page, target projection, relevant schema, or created tag options changed after promotion.
A conflict never overwrites later work or partially restores the source.
Replaying the same Undo operation ID returns the original typed receipt; a consumed token cannot authorize a different Undo operation.
