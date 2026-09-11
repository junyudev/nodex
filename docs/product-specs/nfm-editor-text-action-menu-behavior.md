# NFM Editor Text Action Menu Behavior

Status: Active
Last updated: 2026-08-26

## Purpose

The text action menu is a projection of an executable editor selection. Its
visibility and selection paint must never outlive the selection or an explicit
handoff owner.

## Selection lifecycle

The menu appears only for an eligible expanded text selection after the
pointer gesture has settled. It stays hidden while the pointer is down or a
drag is active. Pointer cancellation, drag completion, window blur, and editor
unmount all settle the gesture state so a later valid selection cannot remain
permanently suppressed.

Collapsed selections, Block-level selections, table-cell selections, Code
Block selections, and selections owned by a nested editor do not open the text
action menu. Only the active editor surface paints its selection presentation.

## Handoff owners

Focusing the toolbar may retain the expanded inline selection for formatting
or link entry. Opening a Block action such as `Send to chat` or `Move to`
atomically hands the same command range to a Block-level lease: the inline
selection paint is removed and the selected Blocks receive one Block-level
presentation. Action execution reads the Block IDs captured by that lease.

Closing, accepting, or unmounting a child surface releases its lease. The
editor either restores an eligible live inline selection or clears both the
selection presentation and command target. A CSS highlight without a live
selection or active lease is invalid state.

## Chat submission

`Send to chat` shares its destination picker, modes, retained Block targets, and
Page image capture with the [Block side menu](nfm-block-side-menu-behavior.md).
Library image references are captured through the source Page before a Chat is
created or a message is submitted; see [Page image inputs](nfm-thread-section-image-inputs.md).
