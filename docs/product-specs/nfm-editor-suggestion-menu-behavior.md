# Page Editor Suggestion Menu Behavior

Status: Active
Last updated: 2026-08-26

## Purpose

Typed suggestion menus appear only where the trigger character expresses an
editor action rather than ordinary text. The editor owns one suggestion
session at a time; the popup is only a presentation of that live session.

The command catalog is owned by
[Page Editor Slash Menu Behavior](nfm-editor-slash-menu-behavior.md). Page and
chat result semantics are owned by
[Page Connections](nfm-editor-page-reference-behavior.md)
and the corresponding thread-mention specification.

## Typed triggers

Slash commands use `/` and fullwidth `／`. Japanese locales also accept `；`.
They open only at the start of a text Block or immediately after a Unicode
separator such as an ordinary, non-breaking, or fullwidth space. Letters,
ASCII digits, punctuation, and inline content atoms are not boundaries.
URL-like `http:/` and `https:/` input remains literal.

Broad mentions use `@`, while Page-focused mentions use `+` and `[[`. `@` and
`+` open at Block start or after whitespace, `(`, `)`, `[`, or `]`;
word-adjacent input such as `name@` and `name+` remains literal. `[[` opens as
soon as the second bracket completes the pair, including after adjacent text
such as `name[[`.

Emoji search uses `:`. It opens at Block start or after whitespace, `{`, `[`,
or `(`; word-adjacent input such as `time:` remains literal. The emoji grid is
shown after two query characters.

Code Blocks do not open typed suggestion menus. `+` also stays literal when the
host cannot create a Page mention.

Programmatic actions may open a named suggestion flow without passing the
typed-trigger boundary. A programmatic mention inserts a separating space when
needed, then a visible `@`, in the same editor transaction.

## Session lifecycle

A trigger accepted from typed input creates one editor-local session. Trigger
characters typed inside its query remain query text; they do not start a
second session. A deliberate programmatic handoff may replace the current
session atomically.

During a slash or Page-mention session, the complete trigger-to-caret range
uses one subtle theme-derived temporary-input treatment. It is a non-persistent
editor decoration: serialization, clipboard, search, and the durable Document
retain only the literal text. An empty slash session shows `Type to search` as
an assistive ghost after the caret; continuing to type keeps the query in the
same treatment and removes the placeholder. The focused completion may also
appear as an assistive ghost, but never during IME composition. An empty `+`
session shows its completion without opening a result popup; continuing to type
opens the Page-focused menu. An empty `[[` session may show recent Pages.

Accepting an ordinary item atomically consumes the tracked query and, when the
session owns it, the complete visible trigger; it closes that same session
before inserting the result. An authoritative asynchronous action instead
leases the tracked range while it is pending. Success closes the session only
after the authoritative Document update is visible; failure restores the live
session with its literal trigger and query. Dismissal does not consume the
user's typed text.

The session and popup close together when the user accepts or dismisses it,
presses Escape, clicks outside, expands the selection, moves the caret before
the trigger, moves to another Block, enters a Code Block, blurs or pointer-
repositions the editor, removes the owning controller, or types a terminally
invalid query. A leased authoritative action may transfer focus into its own
nested destination picker without ending the session. The destination picker
replaces the result list inside the same opaque popup surface; it never stacks
another menu or renders as an unowned transparent layer. Closing the picker
rolls the lease back and restores the literal query. If the parent suggestion
session ends first, its picker and lease end with it, and a later trigger always
starts a fresh result session. Two consecutive spaces terminate a slash query.
A stale async result cannot restore a replaced or closed session.

IME composition is part of the active session. Temporary empty results do not
close the menu during composition; the final committed query is evaluated
after composition ends.
