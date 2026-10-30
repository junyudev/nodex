# Inbox Behavior

## Intent and authority

The Inbox is where a user drops a thought, a todo, or a question without first
deciding which chat it belongs to. The Library Inbox takes anything; each
Project's own Inbox, its Home, takes what is already about that Project. Every
message is saved as an ordinary Page, written in Nodex Markdown as described in
[Message Content Behavior](./message-content-behavior.md). A bound suggestion Agent may then propose
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
- Every Inbox is the Home of its own tab set: the first tab, which cannot be
  closed or moved. A Project's Inbox is its Project's Home, with the Project's
  Views as ordinary tabs beside it; the Home's `Open Board` button opens the
  Project's default View, or focuses it when it is already open. The Project's
  Agent Dock is hidden while the Home is showing, since the Home has its own
  composer. The Library Inbox is the Home of the Inbox's own tab set: the Inbox
  Database and Library content opened from it open as tabs beside it.
- Every Inbox opens a message's Page beside itself, so reading or editing a
  message keeps the stream in view. The Page opens as a preview in the group to
  the Inbox's right, which the first Page opened creates. Opening another Page
  replaces the preview until the reader works in it or pins it, and closing the
  last tab beside the Inbox returns it to full width. `Open Board` and
  `Open Inbox as a Database` open in the Inbox's own group instead, since a Board
  needs the width.
- The Inbox composer sends to the Inbox it shows. Agent Turns send to their
  chat's Project Inbox, and the command line to its Project's Inbox; both use
  the Library Inbox outside a Project. Only the desktop app chooses an Inbox
  explicitly.
- The sidebar's `Inbox` row counts the Library Inbox. Each Project row shows its
  own Inbox count, muted, in place of nothing when the count is zero.

## Messages are Pages

- A message sent to the Library Inbox becomes a Page in the Library's Inbox
  Database. Core creates that Database lazily on the first send, under the
  Page-key prefix `IN`. It is the Library Inbox's primary Database, as a
  Project's Database is its Inbox's: Space lists it with the Library's other
  content, and it cannot be archived while it is the Inbox's.
- A message sent to a Project's Inbox becomes a Page in that Project's Database,
  in Triage, with the Project's Page key. It is on the Project's Board at once.
- The whole message, read as message text, becomes the Page body, and the stream
  bubble renders that body as the Page holds it now, images included; see
  [Message Content Behavior](./message-content-behavior.md). An edit made in the
  Page, by the user or an Agent, shows in the stream as it lands, as does a
  rename, move or deletion made anywhere else. The Page title is only a label
  for Board, List, search, tabs, and new chats. The stream does not show it; `Open page` in the
  message menu opens the Page.
- A sender may give the title. Otherwise Core labels the Page with a provisional
  title: the message's opening words, cut to about 48 columns, where wide
  characters count twice. Later, the suggestion Agent replaces that title with
  a short name in the message's language. A title the user or an earlier
  suggestion has changed is never replaced.
- A message is saved whether or not any suggestion runtime is available. The
  composer accepts message text and images by paste, drop, or `Add photos`.
  `Enter` sends, and `Shift+Enter` inserts a line break.
- Each image becomes a Library File as soon as it is added and shows in the row
  above the text; the message is sent once every image is in. A sent message is
  its images followed by its text, so its Page opens with them as the stream
  shows them. An image the draft imported and then let go
  of before sending, by removing it, cancelling it while it imports, or
  cancelling the rewrite it was added to, goes to Trash. It stays in the
  Library if it changed or came into use anywhere since it was imported. A
  message's own images are never trashed by a rewrite that drops them.
- Drafts, with their images, belong to the current Profile, Inbox and window.
  Submitting preserves a recoverable capture before clearing that draft, so a
  failed earlier send never overwrites the next message. Retrying the same
  capture preserves its identity, and recovering it restores its text and
  images. A read failure offers retry rather than appearing to be an empty Inbox.
- The Inbox entry records who sent the message. That source is written by Core
  from the connection and never by the caller:
  - **User:** typed in the Inbox composer. Renders as a right-aligned user bubble.
  - **Agent:** sent by a verified Agent Session, with its Run recorded when the
    Provider proves it. Renders left-aligned and labeled
    `From <chat>`; the label opens that chat.
  - **Command line:** sent with `nodex inbox send`. Renders left-aligned and
    labeled `From Command line`. The label names the Project only when a message
    sent from inside one could not land in that Project's Inbox.
  - **Scheduled task:** a run of a task that asks first; see
    [Scheduled runs](#scheduled-runs). Renders left-aligned and labeled
    `From <task>` with the Scheduled glyph; the label opens the task.
- A suggestion is about the message text it read. Editing that text, in the
  stream or in the Page, makes the suggestion outdated rather than withdrawing
  it, and never asks for new advice by itself; see
  [Suggestions](#suggestions). A write that leaves the text as
  it was, such as a rename, a move, or opening the Page, changes nothing.

## Editing a message

`Edit` rewrites a message that is still waiting in the Inbox, in its own bubble,
with the composer's text and images: images can be added or removed, and those
kept are written back exactly as the Page has them. `Enter` saves,
`Shift+Enter` inserts a line break, and `Escape` puts the message back. While it
is rewritten, what Nodex made of the old text steps aside.

- Saving is an ordinary write to the message Page under the same rules as
  sending, so the Board, search, and an open Page agree with the stream.
- Saving is a send of the new text: a suggestion about the old text stays,
  outdated, until new advice replaces it, and the message waits for automatic
  advice as a new message does. A provisional title follows the new opening
  words; a name given by the user or a suggestion is kept.
- An edit started from text that has changed since is refused rather than
  overwriting it. The original text remains fixed for the lifetime of that edit,
  including when another view updates the message while its editor is open.
- Saving the body, updating a provisional title and queueing the message for
  advice are one atomic operation.
- A message whose Page no longer has the message shape, Library images at its
  start or end around its text, or holds more than the stream shows, is edited
  as its Page:
  its row offers `Edit as Page` instead.
- Handled messages are a record of what was decided and are not edited from
  History.

## Inbox and History

The goal is an empty Inbox. A message stays in the Inbox only while it still
needs the user; once handled, it moves to History.

- **Inbox:** open messages with no confirmed chat dispatch or an uncertain delivery. This covers
  messages awaiting advice, with a concrete suggestion to decide, with a failed
  suggestion, with no advice asked for, or whose delivery failed.
- **History:** every handled message: a confirmed chat dispatch (including one
  still being delivered), a message filed in a Project, Keep, or Done.

Where a message's Page lives never decides this. Moving the Page by other means,
such as dragging it on a Board, leaves the message in its Inbox until it is
handled. Failed or uncertain delivery and an undone move bring a message back to the
Inbox. Core applies the same membership to the stream windows and to every
Inbox count.

Returning to an Inbox, after switching tabs or relaunching, lands in the view the
reader left and at their place in it. Each view keeps its own place: its newest
messages if the reader was following them, otherwise the message that was at the
top of the view, even when messages around it were handled or loaded meanwhile.
A message further back than the first windows loads them to find it; one handled
since opens the view at its newest messages. Sending a message always shows the
newest.

Each entry has a user-editable kind and a triage state.

- **Kind:** `note`, `todo`, or `question`. A suggestion may propose a kind, and
  the user can change it. A kind never authorizes work.
- **Triage state:** `open`, `kept`, or `done`.
  - Keep dismisses open suggestions and marks the entry `kept`.
  - Done means its work is finished: handled elsewhere, or, for work handed to a
    chat, closed by the user. A chat finishing never marks it done.
  - `Return to Inbox` in History sets a kept or done entry back to `open`.
    Work handed to a chat cannot return; `Reopen` only takes back its Done.

History describes the recorded decision. A Page moved elsewhere and then kept
or marked done still shows Keep or Done and can return to its original Inbox;
returning does not move its Page.

A message's Page shows its handling on its Board. It waits in Triage; handing
its work to a chat moves it to Build, keeping or filing it to Plan, and Done to
Ship. Returning it to the Inbox, reopening it, or undoing the decision moves it
back the same way. Each step happens only while the Page still shows the status
the previous handling gave it, and only to a status its Database still offers,
so a status set on the Board is never overwritten. Delivery does not change it:
a failed delivery leaves the Page in Build.

The Inbox reads like a conversation: newest at the bottom, resting against the
composer, with time shown the way a chat shows it. A centered time appears above
the first message once it is over an hour old, and above any message sent over an
hour after the one before it.

A message's first line opens with where its Page already stands outside the
Inbox, since a Page moved on its Board or linked to a chat stays in the Inbox
until the message is handled: the Page's Board status in its Board color, once it
has left Triage, then the chats the Page is linked to, with their live state.
Choosing that mark opens the chat, or lists them when there are several. The
words follow on the same line, and the lines after it take the message's full
width. A message only waiting in Triage shows neither, and while it is rewritten
neither shows. The status only says where the Page stands; it is changed on the
Board or the Page. A row that already offers `Open chat`, after a decision or an
unconfirmed delivery, keeps that way to the chat for itself.

A message's own time appears beneath its checkbox and star, on the bubble's
side, after the pointer rests on the message for about a second, without moving
anything; a star never moves it. Once it shows, the time is the message's link to
its Page: choosing it opens the Page, as
`Open page` in the menu does. Hidden, it cannot be chosen. A message never
simply vanishes: once decided, its card first says where it went, in its own
place: `Starting a chat in <Project>` or `Sending to “<chat>”` with
`Open chat`, `Moved to <Project>`, `Kept as <kind>`, or `Done`. It folds out of
the stream after a moment, or soon after the pointer resting on it leaves. Keep,
Done and filing also offer `Undo` in a toast. A message handled elsewhere simply
folds away. Clearing the last message shows an `All clear` state with a way to
History.

History is a dense log, newest first. Work still under way leads under
`In progress`: messages handed to a chat that is being delivered, working,
waiting on the user, in error, or holding a reply the user has not read, until
the user marks their work done. These lines show the day they were sent unless
it is today. Everything else follows, grouped by day. Each line shows the
message's Page title and where it went:

- the receiving chat and its live status, or `Done` once the user closed it;
- the Project it was moved to;
- `Kept as <kind>`;
- `Done`.

Expanding a line shows the message, its Page key, and icon buttons:

- `Open chat` or `Open in Project`;
- `Open page`;
- `Copy`;
- `Mark done` or `Reopen`, for work handed to a chat;
- `Return to Inbox`, for kept or done messages;
- `Delete`, while the Page is still in its Inbox's Database.

Every count, in the sidebar and on the `Inbox` tab, is the number of messages in
that Inbox. It is never an unread count.

## Important messages

What matters most is rarely what is newest, and a stream that reads like a
conversation lets an important but unhurried message sink behind newer ones.
The user can mark a message important so it stays within reach while it waits.

- Only the user marks a message important, with `Mark important` in its menu; a
  suggestion never does. It is one mark, not a priority scale: what is urgent
  already announces itself. Importance belongs to the Inbox entry, not to the
  Page, so it is not a Database priority.
- An important message carries a gold star beside its card, between the card
  and its checkbox, level with its first line. It stays through hover and
  selection: the checkbox appears beside it, never over it. A message without
  the mark shows no star, even while hovered; only `Mark important` in the
  message menu marks one. Choosing the star takes the mark off, as
  `Unmark important` in the menu does. The card and its row are unchanged.
- While an important message waiting in the Inbox is out of view, a pill floats
  at the top of the stream. Like the selection bar above the composer, it never
  resizes or shifts the stream. It names the longest-waiting important message
  out of view by its Page title, how long it has waited, and, when there are
  several, its place among them, oldest first (`1/3`). Its surface stays opaque
  under the pointer, so the stream never shows through its words.
- Choosing the pill brings that message to the middle of the stream and rings it
  in gold for a moment, loading earlier messages to find it. The pill then names
  the next important message out of view, or leaves once every one is in view.
- Each Inbox points only at its own important messages. Handling a message takes
  it off that list, and `Return to Inbox` brings it back with its mark. History
  does not show the mark.

## Suggestions

Each suggestion spends the suggestion Agent's usage, so only a send asks for
one on its own. The `Suggestions` preference chooses when they run:

- **Automatically**, the default: each message gets advice once, when it is
  sent or its rewrite in the stream is saved.
- **When I ask:** a message gets advice only when the user asks with `Suggest`,
  `Suggest again`, `Retry`, or `Suggest together`.
- **Off:** nothing suggests, and the Inbox offers no way to ask.

Automatic suggestions also step back when the suggestion Agent is about to run
out. When one of its usage windows is used up, or is spending its share faster
than its time and has less than 10% left, a message sent then waits with
`Suggest` instead, and a quiet line above the composer, marked with the pause
glyph, names that window, how much of it is left and when it resets; hovering
it says why. They resume
for messages sent after usage recovers. Asking for advice works while they are
paused.

Messages sent while advice does not run on its own keep no claim on it: they
never receive it later because the mode changed or usage recovered. Every
other change leaves advice where it is. Editing a message's Page makes its
suggestion outdated without asking again. Reopening a message, returning it
from History, or removing another member of its group leaves it with no
advice until the user asks. Undoing a decision restores the suggestion it
decided.

Main gathers messages waiting for automatic advice in batches of up to eight,
waiting briefly so a burst of messages can be considered together. One request
never mixes Inboxes. Explicit grouped requests retain all selected members, up
to sixteen, rather than being split by the automatic batch size. Each request
and response is fenced by its identity; an old success or failure cannot
replace a newer request.

Suggestions cover only open messages whose Pages are active. Archiving or
deleting a Page withdraws the whole request or unconfirmed proposal that
included it; its remaining open messages have no advice until the user asks. A
late success or failure cannot restore that advice or hold up other requests,
including after a restart. A restored archived message can be asked for advice
again.

The suggestion Agent receives bounded message text and eligible routing
candidates, including relevant chat previews. Its prompt asks only for a
structured proposal.

While suggestions choose models, it also receives every Agent that can take a
chat now, with each model's effort and speed choices, the note Nodex's model
guide keeps for it, and the Agent's usage windows. Each window gives the share
left, the hours until it resets, how old the reading is when it is old, and a
pace that compares the share left with the time left: ample, steady, tight or
spent. It also receives what a chat runs on when it leaves the choice to the
Inbox. How it weighs strengths and budgets is guidance in its prompt rather
than a rule Nodex enforces: a nearly spent weekly window is something to avoid
unless the work needs that model or the window resets soon, not a hard cut-off.

The user's routing preferences are its standing instructions, not data. They
outrank Nodex's model guide and every guideline in its prompt, including how
to route, how to weigh budgets and when to delegate. Only the required output
structure, the allowed actions, the eligible targets, the Inbox's scope and
covering every message stay above them. So turning the guide off and writing
the same knowledge, or a different view, as preferences takes effect at least
as strongly as the guide did.

It uses the shared Agent Runtime utility policy, which is
full-access with automatic native approvals; the prompt and output schema are
behavioral constraints, not a separate tool or content permission boundary.

A Project's Inbox narrows that context to the Project. Its messages are already
that Project's Pages, so a new chat starts in the Project, an existing chat must
be one of the Project's own, and a move can only file the message in another
Project. The same limits apply to dispatches written by hand.

Its single write records one proposal per message or group. Each proposal has
one exact action:

- **Keep:** keep it as a note.
- **New chat:** start a chat in a Project or without one, with a prompt. While
  suggestions choose models, a new chat may also name what it runs on (an
  Agent, model and effort), parts of the work its Agent hands to another model
  (each a one-line description and its Agent, model and effort), and a short
  plan written to its Agent. Most chats delegate nothing.
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
never invent a destination, and every Agent, model and effort it names must be
one it was offered, since Nodex starts and delegates to them exactly. An explicit group produces one concrete suggestion
covering all its members. Generation and transport failures remain failures
with Retry; they do not masquerade as completed advice. A failure names its own
cause: a timeout, missing sign-in, a rate limit, or an answer too long or in a
form Nodex cannot read. The Agent Runtime waits a suggestion's whole time
budget, so a slow suggestion fails only as its own timeout.

In the same pass, the Agent names each message that still has its provisional
title. Core atomically applies all titles, concrete proposals, and request
settlement. A message edited while its request ran still receives its
suggestion, outdated at once, so advice already paid for is never discarded and
asked for again; only the title of a message whose text is unchanged is applied.

What Nodex made of a message is not a reply. It is a strip joined to the
message itself: the message fills the top of one rounded object, and the strip
sits beneath it inside the same outline. The ways to act sit in one row just
under that card and exactly as wide, all at its trailing end. The first of its icons
opens the message menu, which holds only what the row does not already offer, so
no action appears twice: `Open page`; `Handle manually`, `Suggest again` and
`Mark done` unless the row shows them (beside a suggestion, `Handle manually`
stays in the menu, where it changes the suggestion); `Reopen` for a message
marked done; `Mark important` or `Unmark important`; `Kind`; and `Delete`. `Handle manually` opens the dispatch editor
in place of the strip, starting from the current suggestion when there is one.
`Copy` and `Edit` act on the text itself, so they sit on it: in the bottom-right
corner of the message text, shown while the message is hovered or one of them
has keyboard focus. Hidden, they leave the text beneath them selectable; shown,
they float on the text's own color without moving it. `Copy` copies the whole
message, reading it from the Page when the stream shows only part of it, and
confirms with a check for a moment. `Edit` appears on every message still
waiting in the Inbox except one whose delivery failed, and neither appears
while the message or its dispatch is being edited. With nothing to say yet, the card is
the message alone. A kind only steers suggestions, so the card never shows it.
The menu's `Kind` names it, the user's own or else the one the suggestion
proposes, and is the one place to change it; each kind keeps its own glyph there.
A note is a sheet with its corner turned, while a todo and a question, both
asking for work, share a circle around a check or a question mark. The strip
and its row show one of these:

- **Suggestion running:** no strip. The `Handle manually` icon decides by hand
  without waiting. Only the newest such message shows a small spinner at the end
  of its row, the place where its decision appears once advice arrives. The spinner
  ends where the card's bottom-right corner curve meets its bottom edge.
- **Suggestion:**
  - for a new chat or a send to a chat, the prompt it will send, read like the
    message above it: the same size and color, the card's full width, and
    collapsed after as many lines as a user message in a chat.
    Other suggestions say what they do in a one-line summary;
  - a primary action with its exact destination visible without hovering.
    Hovering it adds a chat suggestion's summary and the rationale. For a new
    chat it then says `Runs on` with the Agent's mark, name, model, effort and
    speed the chat will start with. Last, apart from that, `Suggested by` names
    the Agent and model that wrote the suggestion;
  - for a new chat, a split decision. Its menu half opens the composer's model
    menu for that message alone: every available Agent's models, then the chosen
    model's effort and speed. What the chat runs on, chosen by the suggestion or
    on the decision, shows its model on the menu half whenever it differs from
    the Inbox's own, so the decision never hides it, and the menu then offers
    `Use for all Inbox chats`;
  - for a planned chat, beneath its prompt, each part it hands off with that
    Agent's mark and model, then its plan, so how it will run is visible before
    anything is sent;
  - the member count for a group, with access to its complete scope;
  - `Keep`.
- **Failure:** one short reason and a new decision. A failed suggestion, or a
  delivery that can be tried again, ends the row with `Retry`, with
  `Handle manually` outlined beside it. Definite rejection ends it with
  `Handle manually`. Uncertain delivery ends it with `Open chat`, with
  `Send again` outlined beside it, and never retries on its own.
- **Outdated suggestion:** the suggestion as it was, in the muted color, under
  `Suggested before this message changed`. Its decision remains, outlined
  rather than solid, and can be confirmed as it reads. Asking again is now the
  obvious next step, so `Suggest again` ends the row as the primary button: the
  refresh glyph alone, named by its tooltip. While new advice runs, that button
  becomes a spinner and the suggestion stays until the new one arrives; a
  failure says so in place of the note, and the same button retries. Editing the
  text back makes the suggestion current again.
- **No advice requested, or suggestions off:** `Handle manually`, `Suggest`
  unless suggestions are off, and `Keep`.

The row ends with its decision, flush with the card's right edge, so the step
the row recommends is always in the same horizontal place. A labeled action
always has an edge: solid when it is that step, outlined when it is the
alternative just before it, such as `Handle manually` beside `Retry` or an
outdated suggestion beside `Suggest again`. With no step to recommend, as on a
message without advice, `Handle manually` ends the row outlined. A recommended
step whose glyph says it all, `Suggest again` or `Retry`, is a solid icon named
by its tooltip. A row without a decision, the spinner of a running suggestion or
a row of icons, ends where the card's bottom-right corner curve meets its bottom
edge. `Keep as a note`, `Suggest`, `Mark done`, `Handle manually` while a
suggestion runs, and the message menu are quiet icon buttons named by their
tooltips, gathered at the trailing edge before any decision. Every suggestion offers the `Mark done` check.
Every action that asks for advice, `Suggest`, `Suggest together`, `Suggest
again` and a failed suggestion's `Retry`, uses the refresh glyph wherever it
appears, the message menu included: asking first and asking again are one
action. Suggestions themselves carry no AI mark. Retrying a delivery keeps its
own retry glyph. Each dispatch kind has one glyph, the same in the strip, the
dispatch editor, and History. A grouped
suggestion renders once, on the newest message in its group; the others say
which message carries it. A missing sign-in is reported as
`Sign in to the suggestion agent first`.

Editing a grouped dispatch keeps its full membership and revision. Handling just
one member requires an explicit new decision; the remaining members cannot keep
an old prompt that still includes the removed work. Changing a suggestion's
destination or prompt happens in `Handle manually`, which starts from that
suggestion, including the model chosen on its decision. Manual target selection
searches eligible chats beyond the recent list. For a new chat, the dispatch
editor shows what it runs on beside `Start chat`, as the composer shows its
model beside Send, and opens the same model menu. A planned chat's parts each
keep their own model menu and can be removed, leaving that part to the chat's
own Agent, and its plan can be rewritten.

## Dispatch

Only a user action turns a suggestion into work: confirming a proposal, or
submitting the dispatch editor. Confirmation is fenced by the message text the
user reviewed, including for an outdated suggestion.

Every confirmation, including an edited action, checks the message text the
user reviewed. It freezes the complete original text, final prompt and
destination. New chats also retain the resolved Agent instance, model and
options: the one their decision names, chosen by the suggestion or by the user,
or else the Inbox's own. A planned chat's delegation instructions are written
at confirmation against the catalog that resolved it and frozen with it. Retries do
not re-read the current defaults. A choice the catalog cannot run is refused
with its reason; it never silently starts on another Agent or model. What the
Inbox shows before the decision is read against the same catalog with the same
rules, so it names the model the chat will start with. Confirmed text is ordinary
message content and cannot override that selection through inline Agent config
instructions.

- **New chat:** Core creates the Session atomically with the confirmation, titled
  after the first message. Main then starts its first Turn. The prompt is the
  confirmed prompt, then a planned chat's delegation instructions, then the
  original messages quoted as context with their Page keys. The instructions
  give the plan, then each part with the exact `delegate_task` target Nodex
  resolved for it; the chat's Agent keeps integration and the final review. A
  part whose target cannot run when the chat starts still reaches the Agent,
  which can choose another with `list_agent_models` or do it itself.
  The window that confirmed it puts the message Pages in the new chat's right
  panel, the first message's active and the rest as tabs after it, while the
  Inbox stays in view; opening the chat then shows what it was started from
  beside it. `Settings → Inbox` can turn this off.
- A chat message sent from the Inbox carries the Library images of its messages
  with the text, each image once and in reading order. Core freezes them with
  the text at confirmation. Up to 20 images are sent, each fitted to what an
  Agent takes with one message as
  [Message Content Behavior](./message-content-behavior.md) describes; an image
  of a kind an Agent cannot read, or one no longer in the Library, stays on its
  Page, which the text names.
- **Send to chat:** a local chat receives the message into its Runtime queue even
  while busy. Its own queue controls when execution starts.
- Both make every message Page a Linked Page of the receiving chat in the same
  transaction. The Page then shows that chat and its live status on its Board,
  List and Page for as long as the chat exists, well after the message has left
  the Inbox.
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

A delivered message's History line shows the chat's title and live status; a
chat run by Agent Runtime reports its live Session activity.
Before admission it shows that Nodex is starting or sending to the chat and
already links to its Session. Failed or uncertain delivery returns to the Inbox
with its reason and the recovery action appropriate to that result.

## Scheduled runs

A scheduled task that asks in the Inbox before it runs sends each due run as a
message; [Scheduled Route Behavior](./scheduled-route-behavior.md#tasks-that-ask-before-running)
owns when that happens and how the run executes. The message is a todo titled
`<task> · <date>`, its body is the task's instructions, and its decision comes
from the task rather than the suggestion Agent. Suggestions never consider it,
its menu offers no `Suggest again`, and no suggestion can write a run decision.

- The text is this run's instructions, so `Edit` adjusts this run. A Page that
  only the task has written still follows the task's own edits.
- The strip under it says when the task fell due, how many times it has since
  (`Due 3 times since Mon, 9:00 AM`), and where it runs: `Worktree`, `Local`, a
  folder count, `New workspace` for a projectless task, or `Continues its chat`
  for a Heartbeat. It never repeats the instructions.
- The decision reads `Run in <Project>`, `Run without a Project`, or for a
  Heartbeat `Run in “<chat>”`. Hovering it adds `Runs on` with what the run uses
  and `From your scheduled task`. Its menu half opens the model menu for this run
  alone, starting from the task's own choice, and names a different choice on
  the button. A Heartbeat runs on its chat's Agent, so its decision has no menu.
- The row offers the message menu and `Skip this run`, the `Mark done` check.
  There is no Keep: a run is run, skipped, or handed elsewhere.
- `Handle manually` adds `Run task` to the dispatch editor, with the run's model
  menu and `Edit task`, which opens the task where its folders, workspace and
  schedule change for every run. Choosing another action hands the message on
  as any message and withdraws the run.

Running it shows `Starting “<task>”` until the run reaches a chat, then
`Ran “<task>”` with that chat's live status, in History's `In progress` until
the user marks it done. A run that fails before reaching a chat returns with
`Couldn’t run — <reason>` and `Retry`. A skipped run reads `Skipped` in History.
A run whose task was deleted says `Its scheduled task was deleted, so it can’t run`
and offers `Mark done` and `Handle manually`.

A run that needs the user after it starts says so with `send_to_inbox`; a
message from a scheduled run's chat is labeled with its task's name.

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

Each message is selected with the checkbox beside it, shown on hover or focus,
just outside an important message's star.
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
  Library Inbox on its Inbox tab; tabs opened beside it stay open. A Project
  row opens that Project on its Inbox Home.
- `⌘/Ctrl+Shift+D` captures where the user is: in a Project it shows that
  Project's Inbox Home, and anywhere else it opens the Library Inbox. Either
  way it focuses the composer. The command palette exposes the same command as
  `Open Inbox`.
- The Inbox header offers:
  - the `Inbox` and `History` views, as pills with their glyphs like a
    Database's views, the Inbox showing its count;
  - `Open Inbox as a Database` in the Library Inbox, or `Open Board` in a
    Project's Inbox;
  - `Inbox settings`, a panel that changes in place what suggests and what new
    chats run on: when suggestions run and the suggestion model, then whether
    suggestions choose each new chat's models and the model new chats otherwise
    run on, each with the composer's model menu. `Routing preferences and more`
    opens `Settings → Inbox`.

  Each Inbox is a tab, so its header spans the tab like a Board's: views at
  the start and tools at the end, in the same places as on every other tab.

- `Settings → Inbox` holds these Profile preferences:
  - when suggestions run: automatically, when the user asks, or never;
  - the suggestion Agent and model, chosen with the composer's model menu among
    the Agents that can write suggestions. Suggestions run each model at a fixed
    effort, high on Codex and medium on Claude, so the menu offers no effort or
    speed;
  - free-text routing preferences: the user's standing instructions to the
    suggestion Agent, which outrank Nodex's own guidance;
  - whether a chat the Inbox starts opens with its message Pages in its right
    panel, which is on by default;
  - whether suggestions choose each new chat's models and plan its delegation,
    which is on by default;
  - what chats the Inbox starts run on otherwise, chosen with the composer's
    model menu: the Agent, its model, and the model's effort and speed;
  - whether suggestions read Nodex's model guide, which is on by default and can
    be read in full there. The guide changes with Nodex; the user's own view of
    each model belongs in the routing preferences.

  Choices read the Runtime's existing provider and model catalog without forcing
  discovery on open. Cached choices remain visible during background refresh;
  a first load shows Loading, and a failed read offers Retry without declaring
  the saved choice unavailable. Only a loaded catalog can establish that a choice
  is missing or unavailable. Agent setting changes refresh the choices.
  An unavailable instance retains its real name rather than appearing as another Agent.
  Suggestions run often, so an omitted suggestion model resolves to
  GPT-6.1 Sol on Codex, and otherwise, or when the catalog lacks it, to that
  instance's catalog default. Until a chat model is chosen, chats the Inbox
  starts use the Agent's catalog default model at that model's own effort and
  speed. A chosen effort or speed the model does not offer falls back to the
  model's own; choosing another model keeps the ones it also offers. Messages
  sent to an existing chat use that chat's own Agent and model.

## Current limits

- The composer takes images but no other files. Other files can be added
  afterward by opening the message Page.
- Delivery to a busy local chat uses its Runtime queue; it never steers a
  running Turn.
- Capture happens inside the app window. There is no system-wide capture
  shortcut.
- Messages are named only when suggestions run. With no advice asked for, or
  failing, a message keeps its provisional title until the user renames it.
