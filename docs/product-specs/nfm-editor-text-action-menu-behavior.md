# Page Editor Text Action Menu Behavior

Status: Active
Last updated: 2026-10-31

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

## Window boundaries

Editor action and formatting menus retain their preferred placement when it fits
within an `8px` window inset. They try the opposite side before shifting along
both axes. A tall multi-line selection may leave neither side enough room;
the menu then overlaps the selection as needed to keep its actions visible.

## Layout

From top to bottom the menu holds the chat actions, the block type picker, and
two rows of formatting controls ending in `More`, which opens the
[Block side menu](nfm-block-side-menu-behavior.md) for the same selection,
including `Move to`. The menu contains only working actions.

## Chat submission

When the Page can reach a chat, the menu opens with its chat actions:

- `Send to chat`, on the Composer's send glyph. Beside a chat — the Page is shown
  in that chat's Scene, whether it is a Project Page or a Library Page beside a
  Project chat — activating it sends the selection there at once. Its tooltip names
  that chat and the current `Send to chat` binding, and a `Send to another chat` chevron beside it
  opens the destination picker. Without a chat beside the Page, `Send to chat`
  opens the picker itself.
- `Add to composer`, only beside a chat: the selection's content joins the end of
  that chat's draft as its own paragraphs, its images become draft attachments,
  and the Composer takes focus. Its tooltip shows the current `Add to composer` binding.

The picker lists the chat beside the Page first as `This chat`: its live Thread,
or a first Turn in it while it has none and may start one there. The Page's
Linked chats follow, marked `Linked`, then recent chats with the Page's Project
first, and `New chat` at the bottom. Typing searches every chat by title and
history. There is one kind of send: the content goes to the chat and the Page
stays as it is.

Both actions use the Blocks covered by the selection, including their
descendants. A completed send collapses the selection, so the menu closes, and
confirms with a toast; a failure reports its reason without changing the Page.
Selected [Prompt](nfm-editor-prompt-block-behavior.md) Blocks record the send.
Library image references are captured through the source Page before a chat is
created or a message is submitted; see
[Page image inputs](nfm-page-prompt-image-inputs.md). A Page send into a chat in a
Turn follows the Composer's Queue or Steer default, and while that chat is in a
Turn the send control's tooltip says so on a second line: `Queues after its current
turn` or `Steers its current turn`.

## Keyboard

`Send to chat` sends the selection, or with a bare caret the Prompt holding it, to the
chat beside the Page. Without a chat beside the Page it opens the Block side menu
on `Send to chat` with the picker shown. `Add to composer` adds the selection to the beside
chat's composer.

Both commands are editable in Settings → Keyboard shortcuts and match only events
inside the Page editor root, ignoring IME composition. Their defaults are
`⌘/Ctrl+Shift+Enter` and `⌘/Ctrl+Alt+Enter`, respectively. Menus and tooltips use
the command registry's current platform labels; unassigned commands show no hint.
Prompt activation remains the fixed `Modify current block` shortcut,
`⌘/Ctrl+Enter`, with a platform-formatted tooltip.
