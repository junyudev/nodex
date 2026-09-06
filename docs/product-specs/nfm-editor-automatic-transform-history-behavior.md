# NFM Editor Automatic Transform History Behavior

Status: Active
Last Updated: 2026-08-26

## Purpose

This document is the user-visible source of truth for Undo and Redo when the NFM Editor automatically converts recently typed text into richer editor content. An automatic transform includes inline Markdown formatting, Block-prefix conversion, and linkification while typing.

## History model

The literal text entered by the user and the editor's automatic transform are consecutive, independently undoable history entries.

For example, typing `**ABC**` first creates the literal text and then converts it to bold `ABC`. The first Undo removes only the bold formatting and restores the complete literal `**ABC**`. The second Undo removes the typed text. Redo restores the literal text first and the bold form second.

The transform remains isolated from immediately following typing. If the user types `X` after bold `ABC`, Undo removes `X` first, restores literal `**ABC**` second, and removes the literal input third. This ordering does not depend on typing speed or a timeout.

Every retained editor contributes automatic transforms to the window's authority-scoped content history alongside Page title and Database edits. Its native capture tracks only its own local changes; remote collaborative changes never enter local history. Switching participants closes the typing group before another local capture can merge across an intervening action.

## Inline formatting

The history contract applies uniformly to every enabled typing rule for bold, italic, strike, inline code, and any future inline format. A rule that does not meet its syntax or context guards leaves the literal text unchanged and does not create an empty history entry.

The current typing delimiters are:

- bold: `**...**`, `__...__`, `＊＊...＊＊`, and `＿＿...＿＿`
- italic: `*...*`, `_..._`, `＊...＊`, and `＿...＿`
- strike: `~~...~~`
- inline code: `` `...` ``, `´...´`, and `｀...｀`

Full-width delimiters follow the same boundary and whitespace guards as their ASCII forms. A single `~` remains literal text; strike requires `~~`.

Undo restores the complete delimiters exactly once and restores the caret to the position immediately after the literal input. Redo reapplies the format and restores the caret to the end of the formatted content.

## Block-prefix transforms

Heading, list, checklist, quote, code-block, divider, toggle, thread-section, and future Block-prefix rules use the same two-entry history model. Space-triggered and Enter-triggered forms restore an editable literal prefix on the first Undo; the second Undo removes the user input.

An immediate Backspace after an automatic transform may restore its literal input as the editor's input-rule convenience. It restores the literal syntax once and never duplicates the final delimiter, whitespace, newline, or other trigger. This convenience does not replace or fork the normal Undo/Redo history lane.

## Composition input

Input-method composition is not transformed during an active composition. Once composition commits, an eligible transform follows the same literal-input and transform history model as ordinary keyboard input. Composition never inserts a trigger twice, creates an empty history entry, or moves the caret to another Block.

## Autolink

When typing autolink is enabled, the URL text and its terminating separator are committed before linkification. The first Undo removes only the automatically added link mark and keeps the complete literal text. Paste remains one paste action even when pasted content contains multiple eligible links.

URL recognition, settings, path guards, and paste eligibility remain defined by [NFM Editor Autolink Behavior](nfm-editor-autolink-behavior.md).

## Non-user maintenance

Schema repair, generated Block IDs, collaborative synchronization, and other maintenance-only document changes do not become visible automatic-transform history entries. History separation is based on user-visible editing semantics, not on whether implementation code happens to use a follow-up transaction.
