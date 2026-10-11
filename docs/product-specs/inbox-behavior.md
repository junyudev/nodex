# Inbox Behavior

## Intent and authority

The Inbox is the Profile's single capture surface. A user drops a thought, a todo,
or a question without first deciding which Project or chat it belongs to. Every
message is saved at once as an ordinary Page. A bound suggestion Agent may then
propose where it should go, but nothing runs until the user confirms.

Rust Core owns the Inbox Database, each Inbox entry's provenance and triage
state, and versioned dispatch proposals. The Desktop Host owns suggestion
generation, delivery of confirmed chat work, and the Profile's Inbox
preferences. The renderer owns route presentation, drafts, and selection only.

## Messages are Pages

- Sending a message creates one Page in the Library's Inbox Database. Core
  creates that Database lazily on the first send, under the Page-key prefix `IN`.
  It never appears as a standalone sidebar root or Library root.
- The whole message becomes the Page body, line for line, and the stream bubble
  shows exactly that body. The Page title is only a label for Board, List,
  search, tabs, and new chats. The stream does not show it; the message menu's
  `Open as Page` names the Page key.
- A sender may give the title. Otherwise Core labels the Page with a provisional
  title: the message's opening words, cut to about 48 columns, where wide
  characters count twice. Later, the suggestion Agent replaces that title with
  a short name in the message's language. A title the user or an earlier
  suggestion has changed is never replaced.
- A message is saved whether or not any suggestion runtime is available. The
  composer accepts plain text. `Enter` sends, and `Shift+Enter` inserts a line
  break.
- The Inbox entry records who sent the message. That source is written by Core
  from the connection and never by the caller:
  - **User:** typed in the Inbox composer. Renders as a right-aligned user bubble.
  - **Agent:** sent by an Agent Turn. Renders left-aligned and labeled
    `From <chat>`; the label opens that chat.
  - **Command line:** sent with `nodex inbox send`. Renders left-aligned and
    labeled `From Command line`, with `· <Project>` added when it was sent from
    inside a Project.
- A suggestion is fenced by the Page revision it was computed from. After the
  Page is edited, confirming that suggestion fails; `Suggest again` produces a
  fresh one.

## Inbox and History

The goal is an empty Inbox. A message stays in the Inbox only while it still
needs the user; once handled, it moves to History.

- **Inbox:** open messages whose Page is still in the Inbox Database and that
  have no confirmed chat dispatch. This covers messages being suggested, with a
  suggestion to decide, with a failed suggestion, with no suggestion, or whose
  delivery failed.
- **History:** every handled message: a confirmed chat dispatch (including one
  still being delivered), a Page moved out of the Inbox Database, Keep, or Done.

A failed delivery and an undone move bring a message back to the Inbox. Core
applies the same membership to the stream windows and to the Inbox count.

Each entry has a user-editable kind and a triage state.

- **Kind:** `note`, `todo`, or `question`. A suggestion may propose a kind, and
  the user can change it. A kind never authorizes work.
- **Triage state:** `open`, `kept`, or `done`.
  - Keep dismisses open suggestions and marks the entry `kept`.
  - Done means it was handled elsewhere.
  - `Return to Inbox` in History sets a kept or done entry back to `open`.

The Inbox reads like a conversation: newest at the bottom, resting against the
composer, with time shown the way a chat shows it. A centered time appears above
the first message once it is over an hour old, and above any message sent over an
hour after the one before it. A message's own time appears beneath its checkbox
after the pointer rests on the message for about a second, without moving
anything. A handled message folds out of the stream. Keep and Done
confirm with an `Undo` toast; a chat dispatch confirms where it is going.
Clearing the last message shows an `All clear` state with a way to History.

History is a dense log, newest first and grouped by day. Each line shows the
message's Page title and where it went:

- the receiving chat and its live status;
- the Project it was moved to;
- `Kept as <kind>`;
- `Done`.

Expanding a line shows the message, its Page key, and icon buttons:

- `Open chat` or `Open in Project`;
- `Open Page`;
- `Return to Inbox`, for kept or done messages;
- `Delete…`, while the Page is still in the Inbox Database.

The sidebar count and the `Inbox` tab count are the number of messages in the
Inbox. They are never an unread count.

## Suggestions

When suggestions are enabled, Main reads pending entries in batches of up to
eight, waiting briefly so a burst of messages can be considered together. The
suggestion Agent sees each message's text plus a bounded routing context of
active Projects, recent chats, and open suggestions. It has no tools and cannot
read the Library.

Its single write records one proposal per message or group. Each proposal has
one exact action:

- **Keep:** keep it as a note.
- **New chat:** start a chat in a Project or without one, with a prompt.
- **Send to chat:** send a prompt to an existing chat.
- **Move to Project:** file the message Page in a Project's Database.

Main rejects a proposal whose target is not in the routing context. A suggestion
can never invent a destination.

In the same pass, the Agent names each message that still has its provisional
title. Main applies the name before recording the proposal, and only if the Page
is still exactly the revision the Agent read. The proposal is then fenced by the
named Page. Any edit made in the meantime wins: the name is skipped, and the
message waits for a new pass.

What Nodex made of a message is not a reply. It is a strip joined to the
message itself: the message fills the top of one rounded object, and the strip
sits beneath it inside the same outline. The ways to act sit in one row just
under that card and exactly as wide, all at its trailing end. The first of its icons
opens the message menu: `Open as Page`, `Dispatch…`,
`Suggest again`, `Mark done`, and `Delete…`. With nothing to say yet, the card is
the message alone. Once a message has a kind, the
kind's glyph leads its strip in every state. Hovering the glyph names the kind,
and clicking it changes the kind; this is the one place a kind is changed. The
strip and its row show one of these:

- **Working:** `Finding where this goes…` while the suggestion runs.
- **Suggestion:**
  - a one-line summary. Hovering it shows the rationale and the runtime that
    suggested it;
  - the prompt, collapsed to two lines;
  - a primary button named for the action. Hovering it names the exact
    destination, which the strip never states a second time;
  - `Edit`, which opens the dispatch editor in place of the strip;
  - `Keep`.
- **Failure:** a failed suggestion or delivery, with one short reason, `Retry`,
  `Dispatch…`, and `Keep`.
- **No suggestion:** `Dispatch…`, `Suggest` when suggestions are on, and `Keep`.

Only the decision keeps a text label, with its action's glyph: the suggested
action, or `Dispatch…` when there is no suggestion. It ends the row, flush with
the card's right edge, so it is always in the same horizontal place. `Edit`,
`Keep as a note`, `Retry`, `Suggest`, `Mark done`, `Dispatch…` on a failure, and
the message menu are icon buttons named by their tooltips, gathered at the
trailing edge just before any decision. Every suggestion offers the `Mark done` check. The Nodex
mark stands for the AI. It appears only on actions that ask for a suggestion and
never decorates the suggestions themselves. The same glyph
marks each dispatch kind in the strip, the dispatch editor, and History, and each
kind (note, todo, question) everywhere the kind is shown or changed. A grouped
suggestion renders once, on the newest message in its group; the others say
which message carries it. A missing sign-in is reported as
`Sign in to the suggestion agent first`.

## Dispatch

Only a user action turns a suggestion into work: confirming a proposal, or
submitting the dispatch editor. Confirmation is fenced by the message revisions
the proposal was computed from.

- **New chat:** Core creates the Session atomically with the confirmation, titled
  after the first message. Main then starts its first Turn. The prompt is the
  confirmed prompt, followed by the original messages quoted as context with
  their Page keys.
- **Send to chat:** delivery waits while the target chat is busy. History shows
  `Queued for “<chat>”` and delivers when the chat becomes idle.
- **Move to Project:** the user's own Library relocation moves the Page into the
  Project's Database, with Undo. Core then completes the suggestion only after
  the Page is actually there. History shows `Moved to <Project>`.
- **Keep:** marks the entries `kept`.

Confirmed chat work is a durable outbox in Core. After a restart, Main re-reads
it, and launch identities derive from the proposal. A retried delivery therefore
never starts a second chat or sends a prompt twice.

A delivered message's History line shows the chat's title and live status. A
failed delivery returns to the Inbox with its reason and `Retry`.

## Deleting a message

A message sent by mistake, for example one holding a key or something private,
can be deleted:

- from the message menu (`Delete…`);
- for the whole selection, from the selection bar;
- from an expanded History line, while its Page is still in the Inbox Database.

A message that was moved into a Project is that Project's Page now and is
deleted there.

Deleting is erasure and is confirmed once. The dialog shows the message and
says that text already sent to a suggestion agent or a chat cannot be recalled,
and that an exposed secret should be rotated. There is no Undo.

In one Core transaction, the Inbox:

- removes the entry;
- removes every suggestion that names the message, since a summary or prompt may
  quote it. Other messages those suggestions covered keep their outcome: handled
  ones become `done`, and the rest wait for a new suggestion;
- tombstones the Page and its owned Blocks;
- deletes every revision of its Documents, pinned ones included;
- requests erasure.

The Page leaves every View, search, and the Inbox at once. Store maintenance
then collects its remaining storage first, regardless of trash retention, and
the request wakes the Block maintenance lane instead of waiting for its idle
interval. Existing backups are not rewritten.

## Selecting several messages

Each message is selected with the checkbox beside it, shown on hover or focus.
Selecting messages outlines them inside their own border and floats a compact bar
above the composer. Selecting never resizes or shifts the stream: the scroll
gutters stay reserved. The bar's actions are icon buttons:

- **Suggest together:** asks for one grouped suggestion.
- **Dispatch…:** opens the dispatch editor for the whole selection.
- **Keep as notes**
- **Mark done**
- **Delete…**
- **Clear selection**

Grouped suggestions and dispatches accept at most 16 messages.

## Agent and command-line drop-in

Agents and scripts can only append to the Inbox. They can't read, triage, or
dispatch it.

- **Agent tool:** an Agent Turn uses the `send_to_inbox` application tool. Core
  records the source chat and Project from the frozen Turn authority. Read-only
  Turns are refused. A Turn can send at most five messages.
- **Command line:** `nodex inbox send [TEXT] [--title TITLE]` reads TEXT or
  redirected stdin.
  Inside a Project's source or managed worktree, or with `--project`, the
  message is labeled with that Project. Anywhere else it is still accepted and
  labeled only as coming from the command line.

Both paths accept an optional title, which is final. Without one, the message
gets a provisional title like any other message. Both paths also accept an
idempotency key. A retry with the same key returns the original receipt and
never creates a second message.

## Entry points and settings

- The sidebar's `Inbox` row sits directly above `New chat`.
- `⌘/Ctrl+Shift+D` opens the Inbox and focuses its composer. The command palette
  exposes the same command as `Open Inbox`.
- The route header offers:
  - the `Inbox` and `History` tabs;
  - `Open Inbox as a Database`, which opens the backing Database View;
  - `Inbox settings`.
- `Settings → Inbox` holds these Profile preferences:
  - whether suggestions run;
  - the suggestion runtime and optional model;
  - free-text routing preferences given to the suggestion Agent;
  - the runtime for chats the Inbox starts.

  Messages sent to an existing chat use that chat's runtime.

## Current limits

- The composer accepts text only. Images and files can be added afterward by
  opening the message Page.
- Delivery to a busy chat waits for idle; it never steers a running Turn.
- Capture happens inside the app window. There is no system-wide capture
  shortcut.
- Messages are named only when suggestions run. With suggestions turned off or
  failing, a message keeps its provisional title until the user renames it.
