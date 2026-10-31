# Page Editor Prompt Block Behavior

Status: Active
Last updated: 2026-10-31

## Purpose

A Prompt is a Page Block whose content is meant for a chat. Writing a draft in a
Page beside its chat and sending it is one gesture: the caret inside a Prompt and
`⌘↵`. The Prompt stays in the Page as the record of what was asked, where it went
and how that chat is doing, so a Page can hold a running series of prompts or a
prompt someone reuses.

Storage, Nodex Markdown syntax and send-time projection are defined in
[Nodex Markdown](../references/nodex-markdown.md) and
[Page Prompt Image Inputs](nfm-page-prompt-image-inputs.md).

## Anatomy

A Prompt is an enclosed container: a rich first line followed by any child
Blocks, inside one hairline-bounded surface.

- A leading `↳` marker identifies it. When the Prompt has children, the marker
  becomes a disclosure under the pointer: it folds the children away or shows
  them again. A folded Prompt always shows the disclosure.
- The empty first line reads `Write a prompt to send to a chat`.
- The trailing send button uses the Composer's send glyph. It appears while the
  pointer is over the Prompt or the caret is inside it, and stays visible while a
  send is in flight. An empty Prompt cannot be sent.
- After a send, a status chip sits before the send button. It follows the chat
  that received the Prompt: `Working…`, `Working in background`, `Needs you`, or
  `Sent 5m ago` once the chat is idle. Its tooltip names the chat; activating it
  opens that chat.

Read-only previews and lightweight renderers show the marker, first line and
children without the send button.

## Sending

The send button, `⌘/Ctrl+Enter` with the caret anywhere inside the Prompt (including
its children), and the editable `Send to chat` command (default
`⌘/Ctrl+Shift+Enter`) with a bare caret inside it all send the Prompt. The button's
tooltip formats the fixed `Modify current block` shortcut for the current platform.

- Beside a chat — the Page is shown in that chat's Scene — the Prompt goes to
  that chat. The button's tooltip names it.
- Elsewhere the Prompt starts a new chat in the Page's Project, the same
  destination as `New chat` in Send to chat.
- To send a Prompt somewhere else, select it and use Send to chat; that picker
  sends it as a Prompt as well.

The chat receives the Prompt's content — the first line as a paragraph followed by
its children — never the Prompt wrapper or its send record. Images and Agent
config behave as in any Page send. A Prompt with Agent config always starts a new
Turn; otherwise a chat in a Turn receives it according to the Composer's Queue or
Steer default. While the chat beside the Page is in a Turn, the send button's
tooltip adds which of the two will happen.

After the chat accepts the Prompt, Nodex records the receiving Session and the
send time on the Block and folds a Prompt that has children. Sending again
replaces the record. Failures leave the Prompt unchanged and report the reason.
The record is history: it never sends anything by itself, stays editable and
copyable when that chat is later archived or deleted, and Agents must not write
one.

## Creating

- `/prompt` inserts a Prompt.
- `Turn into → Prompt` converts selected Blocks, and the text selection menu's
  block type list includes Prompt.

## Verification

Pure model tests own status labels, send labels and caret resolution. The
Electron send-to-chat scenario owns slash insertion, `⌘↵` delivery and the
recorded status.
