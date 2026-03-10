# Collapsed Toggle Boundary Arrow Fix

Commit subject: `fix(editor): defer collapsed toggle boundary arrows`
Commit hash: see git blame of this file

## Problem

Vertical arrow navigation around collapsed toggles was inconsistent when a hidden edge child was a non-inline block.

- `ArrowDown` could jump into the first hidden child instead of moving into the collapsed toggle header when that first child was a non-common block such as an image or divider.
- `ArrowUp` could jump into the last hidden child instead of moving into the collapsed toggle header when that last child was a non-common block.
- The bug showed up in both the main NFM editor and the nested inline toggle-list editor.

The effect was that the editor appeared to "fall into" hidden content even though the toggle was collapsed and the browser-native visual movement should have stayed on visible blocks only.

## Root Cause

This was a ProseMirror vertical-selection edge case, not an inline-summary-only bug and not an image-only bug.

- ProseMirror's vertical arrow handling can switch from native browser movement to selection movement when it thinks the cursor is crossing a block boundary.
- For collapsed toggles, the hidden child group still exists in the document model and DOM.
- If the edge child in the movement direction is a non-inline block, ProseMirror can resolve the arrow movement into that hidden child instead of letting the browser move visually between visible blocks.
- The earlier fix targeted only the `ArrowDown` + first-image-child case, which was too narrow.
- The nested inline toggle-list editor also has a second capture listener for boundary escape, so plain `stopPropagation()` was not strong enough to guarantee the browser-owned path once we decided to defer.

## Fix

The shared arrow-nav helper in `src/renderer/components/kanban/editor/inline-view-arrow-nav.ts` was generalized.

- The defer logic is now direction-aware.
- It checks the adjacent collapsed toggle in the movement direction, not just the current block.
- It inspects the hidden edge child DOM shape and treats any edge child without `.bn-inline-content` as a non-common / non-inline block.
- That means the fix now covers image, divider, and similar leaf blocks without hardcoding a block-type list.
- The shared defer path now uses `stopImmediatePropagation()` so later same-element listeners cannot steal the event after we intentionally give control back to browser-native motion.

Call sites in both editors were updated to use the shared defer helper for `ArrowUp` and `ArrowDown`.

## Decisions

### Why detect "non-inline edge child" instead of specific block types

This matched the actual failure mode better than checking for `image`.

- The bug is caused by hidden non-inline children at the edge of a collapsed toggle, not by images specifically.
- DOM-shape detection is more robust than maintaining a hand-written allow/deny list of block types.
- `.bn-inline-content` is a practical renderer-level signal for "common text-like block" versus "non-inline child block" in this editor stack.

### Why keep the fix in the shared arrow-nav helper

- Both the main editor and nested toggle-list editor needed identical behavior.
- The problem is keyboard-nav policy, so keeping the rule in the shared nav helper keeps the logic DRY and easier to regression-test.

### Why use `stopImmediatePropagation()`

- The nested toggle-list editor installs more than one capture listener on the same element.
- `stopPropagation()` does not block later listeners on the same element.
- Once we choose browser-native movement, we need to fully prevent local follow-up handlers from reclaiming the key event.

## Is This The Best Elegant Clean Fix?

It is the cleanest practical fix in the current architecture.

- It fixes the real issue at the shared keyboard-policy layer.
- It generalizes the buggy case from "image" to "non-inline edge child" without overfitting to individual block specs.
- It avoids invasive changes to BlockNote or ProseMirror internals.
- It keeps the renderer-specific workaround local to our editor integration instead of spreading special cases through multiple components.

It is still a workaround around upstream editor behavior, so "perfect" would mean not needing renderer-side interception at all. But inside this codebase, this is the most direct and least fragile place to own the behavior.

## What Else I Suggest

- Add a short note to `docs/ENGINEERING_LEARNINGS.md` if this class of issue shows up again, especially the distinction between browser-native vertical motion and ProseMirror node-selection fallback around collapsed hidden children.
- If more non-inline block types are introduced, keep relying on the structural `.bn-inline-content` check unless a concrete counterexample appears.
- If similar bugs appear for horizontal movement or selection-extension keys, keep the same discipline: inspect ProseMirror's actual capture path first, then patch only at the shared policy layer.

## Validation

Validation run for the final fix:

- `bun run typecheck`
- `bun run lint`
- `bun test`

Results at handoff:

- typecheck: passed
- lint: passed
- tests: passed (`1025 pass`, `0 fail`)
