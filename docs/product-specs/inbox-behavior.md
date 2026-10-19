# Inbox Behavior

## Intent and authority

The Inbox is where a user drops a thought, a todo, or a question without first
deciding which chat it belongs to. The Library Inbox takes anything; each
Project's own Inbox, its Home, takes what is already about that Project. Every
message is saved as an ordinary Page. A bound suggestion Agent may then propose
where it should go; a proposal never confirms itself.

Rust Core owns the Library Inbox Database, each Inbox entry's Inbox, provenance,
and triage state, and versioned dispatch proposals. The Desktop Host owns
suggestion generation, handoff of confirmed chat work, and the Profile's Inbox
preferences. Agent Runtime owns accepted messages, execution queues and Runs.
The renderer owns route presentation, durable authored drafts and pending capture
intents, and selection.

## Library and Project Inboxes

- Each message belongs to exactly one Inbox, fixed when it is captured: the
  Library Inbox or one Project's Inbox. Moving its Page later never changes
  which Inbox it belongs to.
- A Project's Inbox is its Home: the first tab of the Project, which cannot be
  closed or moved. The Project's Views are ordinary tabs beside it. The Home's
  `Open Board` button opens the Project's default View, or focuses it when it is
  already open. The Project's Agent Dock is hidden while the Home is showing,
  since the Home has its own composer.
- The Inbox composer sends to the Inbox it shows. Agent Turns send to their
  chat's Project Inbox, and the command line to its Project's Inbox; both use
  the Library Inbox outside a Project. Only the desktop app chooses an Inbox
  explicitly.
- The sidebar's `Inbox` row counts the Library Inbox. Each Project row shows its
  own Inbox count, muted, in place of nothing when the count is zero.

## Messages are Pages

- A message sent to the Library Inbox becomes a Page in the Library's Inbox
  Database. Core creates that Database lazily on the first send, under the
  Page-key prefix `IN`. It never appears as a standalone sidebar root or Library
  root.
- A message sent to a Project's Inbox becomes a Page in that Project's Database,
  in Triage, with the Project's Page key. It is on the Project's Board at once.
- The whole message becomes the Page body, line for line, and the stream bubble
  shows exactly that body. The Page title is only a label for Board, List,
  search, tabs, and new chats. The stream does not show it; `Open page` in the
  message menu opens the Page.
- A sender may give the title. Otherwise Core labels the Page with a provisional
  title: the message's opening words, cut to about 48 columns, where wide
  characters count twice. Later, the suggestion Agent replaces that title with
  a short name in the message's language. A title the user or an earlier
  suggestion has changed is never replaced.
- A message is saved whether or not any suggestion runtime is available. The
  composer accepts plain text. `Enter` sends, and `Shift+Enter` inserts a line
  break.
- Drafts belong to the current Profile, Inbox and window. Submitting preserves a
  recoverable capture before clearing that draft, so a failed earlier send never
  overwrites the next message. Retrying the same capture preserves its identity.
  A read failure offers retry rather than appearing to be an empty Inbox.
- The Inbox entry records who sent the message. That source is written by Core
  from the connection and never by the caller:
  - **User:** typed in the Inbox composer. Renders as a right-aligned user bubble.
  - **Agent:** sent by a verified Agent Session, with its Run recorded when the
    Provider proves it. Renders left-aligned and labeled
    `From <chat>`; the label opens that chat.
  - **Command line:** sent with `nodex inbox send`. Renders left-aligned and
    labeled `From Command line`. The label names the Project only when a message
    sent from inside one could not land in that Project's Inbox.
- A suggestion is fenced by the Page revision it was computed from. After the
  Page is edited, confirming that suggestion fails; `Suggest again` produces a
  fresh one.

## Editing a message

`Edit` rewrites a message that is still waiting in the Inbox, in its own bubble.
`Enter` saves, `Shift+Enter` inserts a line break, and `Escape` puts the message
back. While it is rewritten, what Nodex made of the old text steps aside.

- Saving is an ordinary write to the message Page under the same rules as
  sending, so the Board, search, and an open Page agree with the stream.
- Suggestions about the old text are withdrawn, and every message they covered
  waits for a new suggestion. A provisional title follows the new opening words;
  a name given by the user or a suggestion is kept.
- An edit started from text that has changed since is refused rather than
  overwriting it. The original text remains fixed for the lifetime of that edit,
  including when another view updates the message while its editor is open.
- Saving the body, updating a provisional title and withdrawing suggestions about
  the old text are one atomic operation.
- A message whose Page holds richer content, or more than the stream shows, is
  edited as its Page: its row offers `Edit as Page` instead.
- Handled messages are a record of what was decided and are not edited from
  History.

## Inbox and History

The goal is an empty Inbox. A message stays in the Inbox only while it still
needs the user; once handled, it moves to History.

- **Inbox:** open messages with no confirmed chat dispatch or an uncertain delivery. This covers
  messages awaiting advice, with a concrete suggestion to decide, with a failed
  suggestion, with suggestions disabled, or whose delivery failed.
- **History:** every handled message: a confirmed chat dispatch (including one
  still being delivered), a message filed in a Project, Keep, or Done.

Where a message's Page lives never decides this. Moving the Page by other means,
such as dragging it on a Board, leaves the message in its Inbox until it is
handled. Failed or uncertain delivery and an undone move bring a message back to the
Inbox. Core applies the same membership to the stream windows and to every
Inbox count.

Each entry has a user-editable kind and a triage state.

- **Kind:** `note`, `todo`, or `question`. A suggestion may propose a kind, and
  the user can change it. A kind never authorizes work.
- **Triage state:** `open`, `kept`, or `done`.
  - Keep dismisses open suggestions and marks the entry `kept`.
  - Done means it was handled elsewhere.
  - `Return to Inbox` in History sets a kept or done entry back to `open`.

History describes the recorded decision. A Page moved elsewhere and then kept
or marked done still shows Keep or Done and can return to its original Inbox;
returning does not move its Page.

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
- `Open page`;
- `Copy`;
- `Return to Inbox`, for kept or done messages;
- `Delete`, while the Page is still in its Inbox's Database.

Every count, in the sidebar and on the `Inbox` tab, is the number of messages in
that Inbox. It is never an unread count.

## Suggestions

When suggestions are enabled, Main reads pending entries in batches of up to
eight, waiting briefly so a burst of messages can be considered together. One
request never mixes Inboxes. Explicit grouped requests retain all selected
members, up to sixteen, rather than being split by the automatic batch size.
Each request and response is fenced by its identity and the Page revisions it
read; an old success or failure cannot replace a newer request.

The suggestion Agent receives bounded message text and eligible routing
candidates, including relevant chat previews. Its prompt asks only for a
structured proposal. It uses the shared Agent Runtime utility policy, which is
full-access with automatic native approvals; the prompt and output schema are
behavioral constraints, not a separate tool or content permission boundary.

A Project's Inbox narrows that context to the Project. Its messages are already
that Project's Pages, so a new chat starts in the Project, an existing chat must
be one of the Project's own, and a move can only file the message in another
Project. The same limits apply to dispatches written by hand.

Its single write records one proposal per message or group. Each proposal has
one exact action:

- **Keep:** keep it as a note.
- **New chat:** start a chat in a Project or without one, with a prompt.
- **Send to chat:** send a prompt to an existing chat.
- **Move to Project:** file the message Page in another Project's Database.

Every successful suggestion request produces a concrete action for every member.
Tasks and questions favor a new chat; a clear continuation can target an existing
chat. In the Library Inbox, work without a suitable Project can start a projectless
chat. Notes, references and ambiguous fragments get a focused Keep proposal.
An uncertain selected group can be kept as notes together. The Agent never
completes a request by asking the user to handle the message manually.

Main rejects unknown targets, invalid action fields, duplicate or missing members
and overlong prompts instead of repairing or truncating them. A suggestion can
never invent a destination. An explicit group produces one concrete suggestion
covering all its members. Generation and transport failures remain failures
with Retry; they do not masquerade as completed advice.

In the same pass, the Agent names each message that still has its provisional
title. Core checks the complete request's source versions and atomically applies
all titles, concrete proposals, and request settlement. The proposals are
fenced by the resulting Page versions. Any intervening edit rejects the entire
stale result; no title or partial suggestion from it is applied.

What Nodex made of a message is not a reply. It is a strip joined to the
message itself: the message fills the top of one rounded object, and the strip
sits beneath it inside the same outline. The ways to act sit in one row just
under that card and exactly as wide, all at its trailing end. The first of its icons
opens the message menu: `Open page`, `Handle manually`,
`Suggest again`, `Mark done`, and `Delete`. `Handle manually` opens the dispatch editor
in place of the strip, starting from the current suggestion when there is one.
`Copy` and `Edit` act on the text itself, so they sit on it: in the bottom-right
corner of the message text, shown while the message is hovered or one of them
has keyboard focus. Hidden, they leave the text beneath them selectable; shown,
they float on the text's own color without moving it. `Copy` copies the whole
message, reading it from the Page when the stream shows only part of it, and
confirms with a check for a moment. `Edit` appears on every message still
waiting in the Inbox except one whose delivery failed, and neither appears
while the message or its dispatch is being edited. With nothing to say yet, the card is
the message alone. Once a message has a kind, the
kind's glyph leads its strip in every state. Hovering the glyph names the kind,
and clicking it changes the kind; this is the one place a kind is changed. The
strip and its row show one of these:

- **Suggestion running:** no strip. The `Handle manually` icon decides by hand
  without waiting. Only the newest such message shows a small spinner at the end
  of its row, the place where its decision appears once advice arrives. The spinner
  ends where the card's bottom-right corner curve meets its bottom edge.
- **Suggestion:**
  - for a new chat or a send to a chat, the prompt it will send, read like the
    message above it: the same size and color, the card's full width after the
    kind's glyph, and collapsed after as many lines as a user message in a chat.
    Other suggestions say what they do in a one-line summary;
  - a primary action with its exact destination visible without hovering.
    Hovering it adds a chat suggestion's summary, the rationale and the runtime
    that suggested it;
  - the member count for a group, with access to its complete scope;
  - `Keep`.
- **Failure:** one short reason and a new decision. Suggestion failures and
  temporarily unavailable delivery offer `Retry`. Definite rejection requires
  reviewing `Handle manually`; uncertain delivery offers `Open chat` and `Send again`
  without an automatic retry.
- **No advice requested, or suggestions off:** `Handle manually`, `Suggest`
  when suggestions are on, and `Keep`.

Only the decision keeps a text label, with its action's glyph: the suggested
action, or `Handle manually` when there is no suggestion. It ends the row, flush with
the card's right edge, so it is always in the same horizontal place. A row
without one, the spinner of a running suggestion or a row of icons, ends where
the card's bottom-right corner curve meets its bottom edge.
`Keep as a note`, `Retry`, `Suggest`, `Mark done`, `Handle manually` while a
suggestion runs or after a failure (always the last icon, right of `Mark done`), and
the message menu are icon buttons named by their tooltips, gathered at the
trailing edge just before any decision. Every suggestion offers the `Mark done` check. The Nodex
mark stands for the AI. It appears only on actions that ask for a suggestion and
never decorates the suggestions themselves. The same glyph
marks each dispatch kind in the strip, the dispatch editor, and History, and each
kind (note, todo, question) everywhere the kind is shown or changed. A grouped
suggestion renders once, on the newest message in its group; the others say
which message carries it. A missing sign-in is reported as
`Sign in to the suggestion agent first`.

Editing a grouped dispatch keeps its full membership and revision. Handling just
one member requires an explicit new decision; the remaining members cannot keep
an old prompt that still includes the removed work. Changing a suggestion's
destination or prompt happens in `Handle manually`, which starts from that
suggestion. Manual target selection searches eligible chats beyond the recent
list.

## Dispatch

Only a user action turns a suggestion into work: confirming a proposal, or
submitting the dispatch editor. Confirmation is fenced by the message revisions
the proposal was computed from.

Every confirmation, including an edited action, checks the message versions
the user reviewed. It freezes the complete original text, final prompt and
destination. New chats also retain the resolved Agent instance, model and
options; retries do not re-read the current defaults. Confirmed text is ordinary
message content and cannot override that selection through inline Agent config
instructions.

- **New chat:** Core creates the Session atomically with the confirmation, titled
  after the first message. Main then starts its first Turn. The prompt is the
  confirmed prompt, followed by the original messages quoted as context with
  their Page keys.
- **Send to chat:** a local chat receives the message into its Runtime queue even
  while busy. Its own queue controls when execution starts.
- **Move to Project:** Core moves every member and records the filing in one
  transaction. A conflict leaves every Page and Inbox state unchanged. Filing
  is final: the message is kept in History as
  `Moved to <Project>` and never opens again in that Project's Inbox. The move's
  single `Undo` restores the entire group and its original Inbox state, or
  refuses the whole undo when a member has changed since.
- **Keep:** marks the entries `kept`.

Confirmed chat work is a durable outbox in Core. After a restart, Main re-reads
it with the same immutable input and launch/message identities. Local handoff
ends when Agent Runtime durably accepts that message. Runtime command receipts
make this handoff replayable across lost replies; provider execution and recovery
remain the chat's responsibility. Accepted does not mean the Agent completed
the task. A definite rejection is shown as a failure instead of being retried
forever.

An explicit remote Codex chat retains its remote execution owner. When a send's
result cannot be established, it remains awaiting confirmation and is not
automatically sent again. Other local handoffs can continue.

A delivered message's History line shows the chat's title and live status.
Before admission it shows that Nodex is starting or sending to the chat and
already links to its Session. Failed or uncertain delivery returns to the Inbox
with its reason and the recovery action appropriate to that result.

## Deleting a message

A message sent by mistake, for example one holding a key or something private,
can be deleted:

- from the message menu (`Delete`);
- for the whole selection, from the selection bar;
- from an expanded History line, while its Page is still in its Inbox's
  Database.

A message filed in another Project is that Project's Page now and is deleted
there.

Deleting is erasure and is confirmed once. The dialog shows the message and
says that text already sent to a suggestion agent or a chat cannot be recalled,
and that an exposed secret should be rotated. There is no Undo.

In one Core transaction, the Inbox:

- removes the entry;
- removes advice and unsubmitted payloads that name the message, since a summary
  or prompt may quote it. Other messages keep their actual outcome. If a group
  handoff has already started, its remaining members retain a redacted,
  uncertain-delivery record and the destination link for checking; deletion does
  not infer delivery or authorize a resend;
- tombstones the Page and its owned Blocks;
- deletes every revision of its Documents, pinned ones included;
- requests erasure.

The Page leaves every View, search, and the Inbox at once. Store maintenance
then collects its remaining storage first, regardless of trash retention, and
the request wakes the Block maintenance lane instead of waiting for its idle
interval. Existing backups are not rewritten.

## Selecting several messages

Each message is selected with the checkbox beside it, shown on hover or focus.
Selecting messages rings them on their own border, never clipped by the stream,
and floats a compact bar
above the composer. Selecting never resizes or shifts the stream: the scroll
gutters stay reserved. The bar's actions are icon buttons:

- **Suggest together:** asks for one grouped suggestion.
- **Handle manually:** opens the dispatch editor for the whole selection.
- **Keep as notes**
- **Mark done**
- **Delete**
- **Clear selection**

Grouped suggestions and dispatches accept at most 16 messages.

## Agent and command-line drop-in

The Agent and command-line Inbox interfaces append messages. Triage and dispatch
remain explicit Inbox workflows, and a suggestion never confirms itself. Inbox
messages are ordinary Pages and retain the Profile's full content access, including
for parent, child and background Agents and planning interactions.

- **Agent tool:** an Agent uses the `send_to_inbox` application tool. Core records
  its chat and Project from the verified execution source, and the message lands
  in that Project's Inbox, or the Library Inbox for a projectless chat. A proven
  Run can send
  at most five messages. When the native protocol cannot prove a Run, Core leaves
  it null and applies the same five-message budget to that native connection,
  independently of foreground Runs. Model-authored fields cannot replace the source.
- **Command line:** `nodex inbox send [TEXT] [--title TITLE]` reads TEXT or
  redirected stdin.
  Inside a Project's source or managed worktree, or with `--project`, the
  message lands in that Project's Inbox. Anywhere else it lands in the Library
  Inbox.

Both paths accept an optional title, which is final. Without one, the message
gets a provisional title like any other message. Both paths also accept an
idempotency key. A retry with the same key returns the original receipt, never
creates a second message, and does not count against the Agent budget again.

## Entry points and settings

- The sidebar's `Inbox` row sits directly above `New chat` and opens the
  Library Inbox. A Project row opens that Project on its Inbox Home.
- `⌘/Ctrl+Shift+D` captures where the user is: in a Project it shows that
  Project's Inbox Home, and anywhere else it opens the Library Inbox. Either
  way it focuses the composer. The command palette exposes the same command as
  `Open Inbox`.
- The Inbox header offers:
  - the `Inbox` and `History` tabs;
  - `Open Inbox as a Database` in the Library Inbox, or `Open Board` in a
    Project's Inbox;
  - `Inbox settings`.
- `Settings → Inbox` holds these Profile preferences:
  - whether suggestions run;
  - the suggestion runtime and optional model;
  - free-text routing preferences given to the suggestion Agent;
  - the runtime for chats the Inbox starts.

  Choices read the Runtime's existing provider and model catalog without forcing
  discovery on open. Cached choices remain visible during background refresh;
  a first load shows Loading, and a failed read offers Retry without declaring
  the saved choice unavailable. Only a loaded catalog can establish that a choice
  is missing or unavailable. Agent setting changes refresh the choices.
  An unavailable instance retains its real name rather than appearing as another Agent.
  Suggestions run for every message, so an omitted suggestion model resolves to
  GPT-6.1 Sol on Codex, and otherwise, or when the catalog lacks it, to that
  instance's catalog default. Chats the Inbox starts keep the catalog default;
  messages sent to an existing chat use that chat's runtime.

## Current limits

- The composer accepts text only. Images and files can be added afterward by
  opening the message Page.
- Delivery to a busy local chat uses its Runtime queue; it never steers a
  running Turn.
- Capture happens inside the app window. There is no system-wide capture
  shortcut.
- Messages are named only when suggestions run. With suggestions turned off or
  failing, a message keeps its provisional title until the user renames it.
