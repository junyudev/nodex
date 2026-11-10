# Inbox Behavior

## Intent and authority

The Inbox is what is yours: waiting messages to route, Pages whose current Turn
needs you, Nodex's answers to your Inbox questions, and open Problems. The Library Inbox includes
all Projects and messages without a Project; each Project Inbox filters the same
set. Captured messages remain ordinary Pages and keep today's routing, suggestion
and dispatch rules.

Rust Core owns the Library Inbox Database, each Inbox entry's Inbox, provenance,
and triage state, and versioned dispatch proposals. The Desktop Host owns
routing admission and validated settlement, handoff of confirmed chat work, and the Profile's Inbox
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
- The Inbox composer sends to the Inbox it shows. The all-Projects Library view
  captures without a Project. Agent and CLI ingress use their Project when present.
  Desktop and [Mobile](mobile-companion-behavior.md) choose destinations explicitly.
- The sidebar counts actionable intake, Turns and Problems across all Projects.
  Each Project row shows its own count, muted at zero.

Mobile uses the same Member-scoped projection in the personal Space. Intake
alone offers routing and triage decisions. Turns offer episode-fenced Reply,
question options, Accept or Start, plus Open chat. Answers link their chat.
Problems retain their own identity and one exact fix; desktop-only fixes state
that limitation on the phone. A Turn has no independent Done or dismissal state.

## Problems

A fourth Inbox row kind, `problem`, shows a warning glyph, one-line summary and
one fix. It shares the scope, chronological ordering, counts and sidebar badge
of intake, Turn and answer rows. A Problem is durable failure evidence, not a
message Page; it has no suggestion, message menu or selection actions.

Reconnect opens GitHub settings. Retry re-arms the exact failing delivery or
reply without changing its destination; success removes the problem. Open card
opens an unresolved delivery's Page so the person can start or select a chat.
Resolved problems remain in Activity. The [Sources contract](sources-behavior.md#health-and-problems) defines
problem kinds and their opening thresholds.

## Activity

Activity, the header's second tab beside Inbox, is the one timeline of everything handled or
done in its scope, newest first and grouped by local calendar day. Its filters read the same
Core projection, each with one cursor bound to the scope and filter:

- **All:** every fact below, with deliveries, Channel replies and Turn notes.
- **Messages:** handled messages. Each decision about a message is one fact: sent to a chat,
  filed in a Project, kept, marked done, or returned to the Inbox. A routing suggestion is not a
  fact of its own: one still open belongs to the Inbox, and the decision that settles it is the
  message's fact, carrying Nodex's reason.
- **Nodex & automations:** what Nodex, Automations and Sources decided: starts, Automation
  decisions, Trigger dispositions and their reason, own-PR milestone moves and skipped moves,
  handbacks, and the messages Nodex handled on someone's behalf.
- **Problems:** Problems opening and resolving.

Rows are dense single lines: time, actor glyph, a past-tense description, a quiet reason when
one exists, and a trailing link naming its subject. Clicking a row expands it on the same
surface, without nested cards. Activity has no message composer. Actors are Nodex, a Source, a
Member or a chat, as supported by each committed fact. Pages, chats and remote URLs remain links
to their own evidence. Windows are bounded and newest first. Project Activity shows the
associated Project's facts; a message belongs to the Inbox that received it.

Descriptions name the committed event with a past-tense verb and a quoted message or chat,
retaining the reason separately. Actor glyphs use the monochrome Nodex mark, GitHub, person or
chat glyph in the same tertiary tone; Activity's tab glyph is a list. A trailing link names its
subject: the Page key (or title), Automation name, chat title, or `owner/repo #number`.
Automation links open that Automation's detail. Only Source-level problems name `GitHub`, which
opens GitHub settings. Reasons truncate before descriptions; rows stay on one line. Skipped
milestones retain the stage at observation time and why it did not move.

A handled message reads `Sent “<message>” to “<chat>”`, `Sent “<message>” to a new chat`,
`Filed “<message>” in <Project>`, `Kept “<message>”`, `Marked “<message>” done`,
`Planned N cards from “<message>”`, or `Returned “<message>” to the Inbox`; an Automation's run
the person started reads `Started “<Automation>”`, and a question Nodex answered reads
`Answered “<message>”`. A chat's handback reads `Sent “<message>” back`, by that chat, with
its reason. A start Nodex made reads `on your request` to the person who asked, and
`on Alice’s request` to everyone else. The reason is Nodex's routing reason. A message sent to a
chat links that chat, with a dot for its live state while its work is under way; any other
message links its Page. Expanding the line shows the message
as its Page holds it now, the full reason, who decided, the Page key, and icon buttons:

- `Open chat` or `Open in Project`;
- `Open page`;
- `Copy`;
- `Mark done` or `Reopen`, for work handed to a chat;
- `Return to Inbox`, for kept or done messages;
- `Delete`, while the Page is still in its Inbox's Database.

Each line records its decision as it was made; its buttons act on the message as it stands now.
Deleting a message erases its lines, and a message whose Page is no longer in use leaves
Activity. An empty filter reads `Nothing here yet` and says what collects under it.

Automation decisions appear under Nodex & automations and All. Dry run says `Would have started
“<Automation>”`, Ask first says `Proposed “<Automation>”`, and Run says `Started “<Automation>”`. Skipped,
withdrawn and failed settlements begin with “Skipped”, “Withdrew”, or “Could
not run”, alongside the original decision at its original time. An Automation's generic
routing proposal does not duplicate its Proposed row; the person's confirmed start is the
message's own fact. The original decision keeps its name when the Automation
is renamed before confirmation; the confirmed start links to the resulting chat
under its current title. Run now without a held proposal says
“Started” under its explicit manual admission; Dry run still records only what
would have started. A terminal record without a dry run, proposal or
admission shows only its settlement; it never invents an earlier start or proposal.
The reason stays separate; the Automation
is the primary link even when Dry run created no Page or chat. Execution links
hydrate only after the bounded fact window is selected.

## Messages are Pages

- A message sent to the Library Inbox becomes a Page in the Library's Inbox
  Database. Core creates that Database lazily on the first send, under the
  Page-key prefix `IN`. It is the Library Inbox's primary Database, as a
  Project's Database is its Inbox's: Space lists it with the Library's other
  content, and it cannot be archived while it is the Inbox's.
- A message sent to a Project's Inbox becomes a Page in that Project's Database,
  in Triage, with the Project's Page key. It is on the Project's Board at once.
- Confirming a new chat in a Project puts its message Pages in that Project's
  primary Database as part of the same decision. Sending a Library Inbox Page
  to an existing Project chat moves it there too. The Page gets the Project's
  key and appears on its Board; Status follows the handling, and Owner,
  Assignee, Workspace and thread follows stay with the Page. A projectless chat
  keeps the Page in the Library Inbox Database. A plan creates each step's card
  directly in its chosen Project's Database.
- Dispatch preserves the entry's original Inbox, authoring Member and origin
  Actor. Relocation and assignment history name the Actor confirming the handoff,
  including a Coordinator acting on a Member's behalf. The receiving Agent stays
  separate from this authorship. Library Activity still shows the message and the
  Project chat or plan it went to.
- The whole message, read as message text, becomes the Page body, and the stream
  bubble renders that body as the Page holds it now, images included; see
  [Message Content Behavior](./message-content-behavior.md). An edit made in the
  Page, by the user or an Agent, shows in the stream as it lands, as does a
  rename, move or deletion made anywhere else. The Page title is only a label
  for Board, List, search, tabs, and new chats. The stream does not show it; `Open page` on the
  message text opens the Page.
- A sender may give the title. Otherwise Core labels the Page with a provisional
  title: the message's opening words, cut to about 48 columns, where wide
  characters count twice. Later, Nodex replaces that title with
  a short name in the message's language. A title the user or an earlier
  suggestion has changed is never replaced.
- A message is saved whether or not any suggestion runtime is available. The
  composer accepts message text and images by paste, drop, or `Add photos`.
  `Enter` sends, and `Shift+Enter` inserts a line break. A title given with
  `C`'s `Add title` (see [Entry points](#entry-points-and-settings)) shows above
  the text in whichever composer holds the draft, so it is never sent unseen;
  `Enter` there returns to the text, and `Backspace` or `Escape` in an empty
  title closes it.
- The composer has a chat composer's rows: the text above, and beneath it
  `Add photos` at the left and send at the right. The text grows with what it
  holds up to a quarter of the window's height, then scrolls by itself, so the
  controls and any title stay in place. An image dragged over the composer marks
  it as the place to drop.
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
  A reply stays in the composer until its save is confirmed. A capture being saved
  offers no recovery action; Retry appears only after saving fails or recovery
  cannot establish the earlier outcome.
- The Inbox entry records who sent the message. That source is written by Core
  from the connection and never by the caller:
  - **User:** typed in the Inbox composer. Renders as a right-aligned user bubble.
  - **Agent:** sent by a verified Agent Session, with its Run recorded when the
    Provider proves it. Renders left-aligned and labeled
    `From <chat>`; the label opens that chat.
  - **GitHub:** an external request found by a Source, with a quiet glyph,
    `owner/repo #n` and its author linking to the thread. It retains external
    authorship and requires a routing decision; see [Sources](sources-behavior.md).
  - **Command line:** sent with `nodex inbox send`. Renders left-aligned and
    labeled `From Command line`. The label names the Project only when a message
    sent from inside one could not land in that Project's Inbox.
  - **Automation:** an Ask first decision from a clock Automation; see
    [Automation decisions](#automation-decisions). Renders left-aligned and labeled
    `From <Automation>` with the Automation glyph; the label opens the Automation.
- A message is its Page body, read as Nodex Markdown, with the Library images in
  it. That is what the stream shows, what a suggestion reads, and what a chat
  it is handed to receives; the Page title is only its label.
- A suggestion is about the message it read. Editing the message, its text or
  its images, in the stream or in the Page, makes the suggestion outdated rather
  than withdrawing it, and never asks for new advice by itself; see
  [Suggestions](#suggestions). A write that leaves the message as it was, such
  as a rename, a move, or opening the Page, changes nothing.

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
  Activity.

## Inbox and Activity

The goal is an empty Inbox. A message stays in the Inbox only while it still
needs the user; once handled, it leaves the Inbox, and Activity records the decision.

- **Inbox:** open messages with no confirmed chat dispatch or an uncertain delivery. This covers
  messages awaiting advice, with a concrete suggestion to decide, with a failed
  suggestion, with no advice asked for, or whose delivery failed.
- **Handled:** a confirmed chat dispatch (including one still being delivered), a message
  filed in a Project, Keep, or Done. [Activity](#activity) holds each of these decisions.

Where a message's Page lives never decides this. Moving the Page by other means,
such as dragging it on a Board, leaves the message in its Inbox until it is
handled. Failed or uncertain delivery and an undone move bring a message back to the
Inbox. Core applies the same membership to the stream windows and to every
Inbox count. Opening the chat a decision has not started yet, from the Chats list on
a desktop or a phone, shows that it is starting, or why it could not start with the
Retry Core would admit, without looking up its message; a decision Core would not send
again says to review its message in the Inbox. Core reads this for the chat itself, and
the open chat refreshes as its start changes.

Returning to an Inbox, after switching tabs or relaunching, lands in the view and
Activity filter the reader left and at their place in it. Each view keeps its own place: its
newest rows if the reader was following them, otherwise the message or Activity line that was
at the top of the view, even when rows around it were handled or loaded meanwhile. A row
further back than the first windows loads them to find it; one gone since opens the view at
its newest rows. Choosing another Activity filter opens it at its newest lines, and sending a
message always shows the newest messages. Opening a handled message from elsewhere, such as a
notification, shows its newest line in Activity, expanded.

Each entry has a user-editable kind and a triage state.

- **Kind:** `note`, `todo`, or `question`. A suggestion may propose a kind, and
  the user can change it. A kind never authorizes work.
- **Triage state:** `open`, `kept`, or `done`.
  - Keep dismisses open suggestions and marks the entry `kept`.
  - Done means its work is finished: handled elsewhere, or, for work handed to a
    chat, closed by the user. A chat finishing never marks it done.
  - `Return to Inbox` in Activity sets a kept or done entry back to `open`.
    Work handed to a chat cannot return; `Reopen` only takes back its Done.

Activity describes each recorded decision. A Page moved elsewhere and then kept
or marked done still shows Keep or Done and can return to its original Inbox;
returning does not move its Page.

A message's Page shows its handling on its Board. It waits in Triage; handing
its work to a chat moves it to Doing, keeping or filing it to Plan, and marking
it done to Done. Returning it to the Inbox, reopening it, or undoing the decision moves it
back the same way. Each step happens only while the Page still shows the status
the previous handling gave it, and only to a status its Database still offers,
so a status set on the Board is never overwritten. Delivery does not change it:
a failed delivery leaves the Page in Doing.

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
anything; a star never moves it. Once it shows, the time is also a link to the
message's Page: choosing it opens the Page, as `Open page` on the message text
does. It is named by the time it reads. Hidden, it cannot be chosen. A message never
simply vanishes: once decided, its card first says where it went, in its own
place: `Starting a chat in <Project>` or `Sending to “<chat>”` with
`Open chat`, `Moved to <Project>`, `Kept as <kind>`, or `Done`. It folds out of
the stream after a moment, or soon after the pointer resting on it leaves. Keep,
Done and filing also offer `Undo` in a toast. A message handled elsewhere simply
folds away. Clearing the last message shows an `All clear` state, and beneath
it [how the Inbox plans](#how-the-inbox-plans).

Every badge counts actionable intake plus current eligible Turns in that scope.
Answers do not inflate it. It is never an unread count.

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
  it off that list, and `Return to Inbox` brings it back with its mark. Activity
  does not show the mark.

## Turns, notes and answers

Core returns one mixed window of `intake`, `turn` and `answer` rows. All share
one time-and-identity ordering and one scope-bound cursor. Counts use the same
membership as the window. The badge counts actionable intake and Turns; answers
stay visible without increasing it. `all` includes every Project; `library`
means messages without a Project.

A Turn row belongs to the local Member and has reason question, approval,
review, blocked, failed or stalled. A managed chat's attention includes live approvals
from delegated descendants and questions handed to the person, using the same tree
rollup as root Session activity. Questions still owned by a delegating Agent do not
create person attention. Ready-to-start appears only for a Page with
Prerequisites that are all now Done. Backlog cards without Prerequisites and
paused Pages stay out. The row is ordered by the current episode's start time;
a new episode enters at its own time. It has no dismissed or done state and
leaves as soon as the Turn belongs elsewhere. Activity retains handled messages
and answered conversations, never the complement of all Page Turns.

The first line shows the Page key, title and whose move the Page waits for, in
the words its Status row uses for the reader, such as `Needs your answer` or
`Ready for your review`. Beneath it are one or two lines of the current episode's
newest Turn note, led by Nodex's monochrome mark, named Note from Nodex, only
when Nodex wrote that text. Without a note Core shows the exact pending question,
report summary, failure reason, or which Prerequisites finished.

Actions revalidate the episode. Questions show the exact option labels: four
buttons then More… when needed, plus Reply. Approval offers Open chat. Review
offers Accept, Open PR when linked, and Reply. Blocked, failed and stalled offer
Open chat and Reply. Newly ready work offers Start. Accept moves reviewed work
to Done through the work command a person, or an Agent acting for them, uses.
An Agent may take any of these actions on a Turn of the Member it acts for, and never on
another Member's Turn; its instructions limit it to what the person told it to answer or
asked it to handle. Execution approvals stay with the person's chosen permission mode.

Reply sends the person's unchanged words to the Page's active chat through the
durable person-dispatch outbox. Its single pending question is answered directly
when the reply is a valid choice or custom answer. No active chat, ambiguity,
approval or an invalid required choice is explained with Open chat; there is
no fallback to intake routing. A reply retains its authored episode across
restart and never becomes an intake entry.

Only the Coordinator writes `write_turn_note { pageId, eventIds, body, notify }`.
The note is immutable, at most 100 words by countWords, and binds to the current
local-Member episode. Events must have been delivered to that Coordinator and
concern the Page or its active chat. Each event backs one note per episode;
exact retries preserve the note. A note neither creates a row nor changes order.

`answer_inbox_question { questionPageId, body }` creates a quiet answer Page and
handles its pending question atomically. One question has one answer; exact
retries reuse it. Answers look like Nodex's conversation messages. Reply to an
answer continues with Nodex as ordinary intake, retaining the answer's context.

## Suggestions

Each suggestion request reaches Nodex's conversation as a message carrying its
Inbox entries, images, and possible destinations. Nodex records the answer with
`inbox_suggest`. A request keeps its conversation and deadline across restarts.
Starting Nodex fresh leaves any unsettled requests with the previous conversation.
Five requests can await Nodex by default. Inbox settings can raise or lower that
limit. A request has five minutes from when Nodex starts on it: time it waits
behind Nodex's other work does not count, and requests Nodex takes up together
share one start, kept across restarts. A request Nodex has not started thirty
minutes after it was handed over fails with Retry. Nodex can correct an invalid
answer within its deadline. If Nodex ends its turn without answering, it gets
one follow-up naming the unanswered request and its latest refusal, if any.
This follow-up survives app restarts and keeps the original deadline. If Nodex
ends that follow-up without answering, the request fails immediately with Retry
and an explanation.
Answers that arrive after settlement, replacement, withdrawal, or failure record
nothing. The request text remains in its conversation after the Inbox entry is deleted.

When Suggestions choose models is off, each routing request explicitly offers
no Agent choices. New chats use the Inbox default; Nodex must leave the Agent,
model and effort fields empty, including each plan step's Agent. Choices from
earlier requests do not apply.

A chat suggestion can offer up to three skills available to its destination.
The skill list sits above the additions. Each skill is selected by default and
can be turned off before confirming. A skill the person invoked with `$name`
stays part of their request. Automatic starts omit optional skills.

Changing the receiving Agent or chat can make a suggested skill unavailable.
If a selected skill becomes unavailable before the chat receives the message,
the handoff proceeds with the skills the chat can use.

Each suggestion spends the usage of the Agent Nodex runs on, so only a send asks for
one on its own. The `Suggestions` preference chooses when they run:

- **Automatically**, the default: each message gets advice once, when it is
  sent or its rewrite in the stream is saved.
- **When I ask:** a message gets advice only when the user asks with `Suggest`,
  `Suggest again`, `Retry`, or `Suggest together`.
- **Off:** nothing suggests, and the Inbox offers no way to ask.

Automatic suggestions also step back when the Agent Nodex runs on is about to run
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
from Activity, or removing another member of its group leaves it with no
advice until the user asks. Undoing a decision restores the suggestion it
decided.

Main gathers messages waiting for automatic advice in batches of up to eight,
waiting briefly so a burst of messages can be considered together. One request
never mixes Inboxes. Explicit grouped requests retain all selected members, up
to sixteen, rather than being split by the automatic batch size. Each request
and response is fenced by its identity; an old success or failure cannot
replace a newer request.

Up to five requests can await Nodex at once, admitted oldest first.
`Settings → Inbox` changes the limit, from one to sixteen. Raising it admits waiting messages at once; lowering it stops nothing
already running, and new requests wait until fewer are. Messages sent while the
limit is reached wait for the next free place and are gathered into one request
then, which keeps a long burst from spending a request per message.

A running suggestion can be stopped from its spinner, which becomes a stop button
under the pointer or keyboard focus. Stopping ends the work and the usage it
spends at once, for a message still waiting its turn as well as one being read.
The message keeps any advice it already had, or otherwise has none and offers
`Suggest`; it is not asked again on its own. A message gathered with others stops
alone, and the others are gathered again without it. A group asked about together
is one decision, so it stops together. If advice lands as the user stops, the
advice stays.

Suggestions cover only open messages whose Pages are active. Archiving or
deleting a Page withdraws the whole request or unconfirmed proposal that
included it; its remaining open messages have no advice until the user asks. A
late success or failure cannot restore that advice or hold up other requests,
including after a restart. A restored archived message can be asked for advice
again.

Nodex reads each message whole: its body as Nodex Markdown, as the
user wrote it, with its Library images attached as images in the order they
appear, each marked in the text where it sits. An image that cannot be read is
marked as unavailable rather than dropped silently. One request reads at most
20 images: automatic batches stop short of that, a single message with more
fails with that reason, and a selection with more is refused. It also receives
eligible routing candidates: Projects with their source directories, and
relevant chat previews.

Before proposing, it looks things up whenever that lets the prompt point the
chat at something concrete or fit its model to the work: it reads files in a
Project's sources or searches the web. It might search the web for an
unfamiliar product or library, find where in a Project's sources the work lives
and how large it is, or check which Project or chat already owns it. Notes and
reminders get no look, and it stops after a few reads or searches, as soon as
more would not change the proposal. It decides where and how work runs and
never does the work: it answers no question, investigates no cause, runs no
build or test, and changes no file, Nodex content or other state. The rationale
says what it checked. The request supplies each eligible Project's source
directories so Nodex can identify where the work belongs.

A chat suggestion separates what the user asked for from what the suggestion
adds on its own. Its prompt is what the user wants: the task, its scope and
every requirement the user wrote, plus anything the suggestion is sure the chat
must know, such as a finding that changes the task. Its additions are sentences
the suggestion adds itself that the user might rather not send: how the chat
could run the work, such as handing part of it to another model, or what it
could consult, such as a file or link a lookup found. An addition never adds to
what the chat delivers, and nothing the user asked for is ever an addition, so
dropping one never drops a requirement. A suggestion carries as many additions
as it finds worth offering, up to twelve of 600 characters each.

The Coordinator receives standing routing instructions on every turn. Its
normal Runtime configuration and permissions apply, while its role directs it
to treat captured text, personal and Project instructions, and lookup results
as routing data. It leaves the receiving chat to follow that chat's own
instructions and does not restate them in a proposal. Routing preferences are
the user's standing instructions for these decisions.

Image markers use `[Image #N]`, followed by ` (caption: <alt text>)` when the
occurrence has alt text. Within a message, repeated occurrences of a Library
image reuse its number. Suggestion numbering spans the messages in a request;
confirmed chat handoffs deduplicate images across all included messages.
Availability notes follow the marker rather than changing its format.

While suggestions choose models, it also receives every Agent that can take a
chat now, with each model's effort and speed choices, the note Nodex's model
guide keeps for it, and the Agent's usage windows. A window that has reset since
it was read is left out; with none remaining, the budget is unknown. Each window
gives the share left, the hours until it resets, how old the reading is when it
is old, and a pace that compares the share left with the time left: ample,
steady, tight or spent. It also receives what a chat runs on when it leaves the
choice to the Inbox. How it weighs strengths and budgets is guidance in its
prompt rather than a rule Nodex enforces: a nearly spent weekly window is
something to avoid unless the work needs that model or the window resets soon,
not a hard cut-off.

The user's routing preferences are its standing instructions, not data. They
outrank Nodex's model guide and every guideline in its prompt, including how
to route, how to weigh budgets, when to delegate and when to look things up.
Only the required output structure, the allowed actions, the eligible targets,
the Inbox's scope, covering every message and changing nothing stay above them.
So turning the guide off and writing the same knowledge, or a different view, as
preferences takes effect at least as strongly as the guide did.

Only the verified Coordinator Session may submit `inbox_suggest`. Its strict
tool schema and the Inbox validator constrain the output; validation errors
are returned to the Coordinator for correction without settling the request.

A Project's Inbox narrows that context to the Project. Its messages are already
that Project's Pages, so a new chat starts in the Project, an existing chat must
be one of the Project's own, and a move can only file the message in another
Project. The same limits apply to dispatches written by hand.

Its single write records one proposal per message or group. Each proposal has
one exact action:

- **Keep:** keep it as a note.
- **New chat:** start a chat in a Project or without one, with a prompt. While
  suggestions choose models, a new chat may also name what it runs on: an
  Agent, model and effort. When another model clearly suits part of the work,
  an addition says so to the chat's Agent, which decides whether and how to
  delegate it; a suggestion never plans subtasks or steps.
- **Send to chat:** send a prompt, with its additions, to an existing chat.
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
one it was offered, since Nodex starts the chat on it exactly. An explicit group produces one concrete suggestion
covering all its members. Generation and transport failures remain failures
with Retry; they do not masquerade as completed advice. A failure names its own
cause: a timeout, missing sign-in, a rate limit, an answer too long or in a form
Nodex cannot read, or the Agent's own reason when it gives one. Nodex can correct
an invalid tool submission within its deadline. A request that
cannot be settled fails on its own and can be retried explicitly.
Nodex cannot read, or the Agent's own reason when it gives one. Advice Core will
not accept is a failure too, explained as advice that could not be saved or a
message or destination that changed or became unavailable, without internal
operation details. It is not generated again until the user retries;
one message's failure never holds up the others. A suggestion's time budget is three minutes, the longest
any utility request may run, and the Agent Runtime waits all of it, so a slow
suggestion fails only as its own timeout.

In the same pass, the Agent names each message that still has its provisional
title. Core atomically applies all titles, concrete proposals, and request
settlement. Keeping the existing provisional title finalizes that name and saves
the advice without changing the Page's saved revision. A message edited while
its request ran still receives its suggestion, outdated at once, so advice
already paid for is never discarded and asked for again; only the title of a
message whose text is unchanged is applied.

What Nodex made of a message is not a reply. It is a strip joined to the
message itself: the message fills the top of one rounded object, and the strip
sits beneath it inside the same outline. The ways to act sit in one row just
under that card and exactly as wide, all at its trailing end. The first of its icons
opens the message menu, which holds only what the message does not already offer,
so no action appears twice: `Handle manually`, `Suggest again` and
`Mark done` unless the row shows them (beside a suggestion, `Handle manually`
stays in the menu, where it changes the suggestion); `Reopen` for a message
marked done; `Mark important` or `Unmark important`; `Kind`; and `Delete`. A
Nodex post takes no advice, so it has no menu. `Handle manually` opens the dispatch editor
in place of the strip, starting from the current suggestion when there is one.
`Open page`, `Copy` and `Edit` act on the message itself, so they sit on its
text, in that order: in the bottom-right corner of the message text, shown while
the message is hovered or one of them has keyboard focus. Hidden, they leave the
text beneath them selectable; shown, they float on the text's own color without
moving it. The message is its Page's body, so `Open page` opens that Page, on
every message. `Copy` copies the whole message, reading it from the Page when the
stream shows only part of it, and confirms with a check for a moment. `Edit`
appears on every message still waiting in the Inbox except one whose delivery
failed, and not while its dispatch is being edited; while the message itself is
rewritten, none of the three shows. With nothing to say yet, the card is
the message alone. A kind only steers suggestions, so the card never shows it.
The menu's `Kind` names it, the user's own or else the one the suggestion
proposes, and is the one place to change it; each kind keeps its own glyph there.
A note is a sheet with its corner turned, while a todo and a question, both
asking for work, share a circle around a check or a question mark. The strip
and its row show one of these:

- **Suggestion running:** no strip. The `Handle manually` icon decides by hand
  without waiting. Every message waiting for advice shows a small spinner at the
  end of its row, the place where its decision appears once advice arrives. The
  spinner ends where the card's bottom-right corner curve meets its bottom edge,
  and is also how the suggestion is stopped.
- **Suggestion:**
  - for a new chat or a send to a chat, the prompt it will send, read like the
    message above it: the same size and color, the card's full width, and
    collapsed after as many lines as a user message in a chat. Its additions
    follow, one per line with a checkbox, all checked. Unchecking one fades and
    strikes it through, and confirming then sends only the additions still
    checked. Other suggestions say what they do in a one-line summary;
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
own retry glyph. Each dispatch kind has one glyph, the same in the strip and the
dispatch editor. A grouped
suggestion renders once, on the newest message in its group; the others say
which message carries it. A missing sign-in is reported as
`Sign in to the suggestion agent first`.

Editing a grouped dispatch keeps its full membership and revision. Handling just
one member requires an explicit new decision; the remaining members cannot keep
an old prompt that still includes the removed work. Changing a suggestion's
destination or prompt happens in `Handle manually`, which starts from that
suggestion, including the model chosen on its decision; its prompt there is
plain text holding the additions still checked, each as its own paragraph.
Manual target selection
searches eligible chats beyond the recent list. For a new chat, the dispatch
editor shows what it runs on beside `Start chat`, as the composer shows its
model beside Send, and opens the same model menu.

## How the Inbox plans

An empty Inbox, cleared or not yet used, shows how it will plan the next
messages beneath its heading, so suggestions never have to be taken on trust.
It reads the same settings, catalog and usage readings suggestions are written
with, reads the catalog again every minute while it shows, and shows nothing
until the Inbox's settings have loaded. A Project's Inbox shows the same plan,
since its settings and Agents are the Profile's; its closing line adds that
chats stay in the Project.

- `Suggested by` names Nodex's model at the effort suggestions
  run it, such as `GPT-6.1 Sol · High`, and opens the composer's model menu to
  choose another. It reads `When you ask` beside it when suggestions run only on
  request, and `Paused` while automatic suggestions are paused.
- While suggestions choose models, `Model guide` lists each family of Nodex's
  model guide among the models suggestions are offered on each Agent able to
  take a chat, at most twelve an Agent, with the guide's note in one line, then
  each other such Agent by name. Each line carries its Agent's mark in the
  rail's usage ring and what is left of that Agent's weekly window, or of its
  longest window, named, when it has no weekly one; a window that limits one
  model only stays in the Agent's usage card, which the ring opens on hover as
  the rail's does when the Agent reports any windows. A family the guide marks free reads `Free`. Without
  the guide, the list is `Budgets`: each Agent once, with its budget alone.
- Nothing is claimed that is not known. A window that has reset since it was
  read reads `Reset since read`, an Agent that reports no usage reads
  `Not reported`, and an old reading is faded, as on the rail, and says how
  long ago it was read. The rail reads each account on its own schedule, so the
  two can differ for a moment.
- While suggestions only route, `New chats` shows what every chat the Inbox
  starts runs on, with the composer's model menu.
- `Routing preferences` quotes the user's preferences, or offers
  `Add your own…`. Choosing them edits them in place: `⌘↵` or `Save` saves,
  and `Escape` or `Cancel` keeps them as they were.
- A closing line says what each suggestion weighs: what a model does well and
  how much of its weekly budget is left, or each Agent's budget alone without
  the guide, after following the routing preferences first when there are
  some. While suggestions only route, it says they choose where a message goes
  and not which model runs it.

With suggestions off, it says so and shows only what new chats run on. Turning
suggestions, model choice or the guide on and off stays in the settings gear
and `Settings → Inbox`.

## Dispatch

Work starts when the user confirms a proposal or submits the dispatch editor.
Confirmation is fenced by the message the user reviewed, including for an
outdated suggestion.

With `Let Nodex start chats for me` on, Nodex confirms a new suggestion on the user's behalf
only when it is a new chat or a send to a chat, every message it covers is the
user's own, Nodex marked it as the user's clear request for work now, and the
message still reads as it did when Nodex wrote the suggestion. Core checks all
of this when it records the confirmation. Such a start sends the prompt without
any of the suggestion's optional additions, and its decision records that Nodex
made it. Keep, filing, plans and scheduled runs always wait for the user. A
retried start reuses the same chat and decision. Turning the preference on never
starts a suggestion written before it.

Every confirmation, including an edited action, checks the message the user
reviewed. It freezes the complete original message, final prompt and
destination; a chat receives each message as written, its images attached in
place. New chats also retain the resolved Agent instance, model and
options: the one their decision names, chosen by the suggestion or by the user,
or else the Inbox's own. Retries do not re-read the current defaults. A choice the catalog cannot run is refused
with its reason; it never silently starts on another Agent or model. What the
Inbox shows before the decision is read against the same catalog with the same
rules, so it names the model the chat will start with. Confirmed text is ordinary
message content and cannot override that selection through inline Agent config
instructions.

- **New chat:** Core creates the Session atomically with the confirmation, titled
  after the first message. Main then starts its first Turn. The prompt is the
  confirmed prompt, then each confirmed addition as its own paragraph, then the
  original messages quoted as context with their Page keys. A send to a chat
  composes its message the same way.
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
  transaction. If the Page has no Assignee, that transaction assigns it to the
  receiving chat's Agent instance, model and effort, without automatic-start consent.
  An existing Member or Agent Assignee stays unchanged. The Page then shows that chat and its live status on its Board,
  List and Page for as long as the chat exists, well after the message has left
  the Inbox.
- **Move to Project:** Core moves every member and records the filing in one
  transaction. A conflict leaves every Page and Inbox state unchanged. Filing
  is final: Activity keeps it as `Filed “<message>” in <Project>`, and it
  never opens again in that Project's Inbox. The move's
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

A delivered message's Activity line links the chat with its live status; a
chat run by Agent Runtime reports its live Session activity.
Before admission it shows that Nodex is delivering to the chat and
already links to its Session. Failed or uncertain delivery returns to the Inbox
with its reason and the recovery action appropriate to that result.

## Automation decisions

A clock Automation set to Ask first holds each due decision as an editable intake message; [Automations Behavior](./automations-behavior.md#decisions-that-ask-in-the-inbox)
owns when that happens and how the run executes. The message is a todo titled
`<Automation> · <date>`, its body is the Automation's instructions, and its decision comes
from the Automation rather than from Nodex. Suggestions never consider it,
its menu offers no `Suggest again`, and no suggestion can write a run decision.

- The text is this run's instructions, so `Edit` adjusts this run. A Page that
  only the Automation has written still follows the Automation's own edits.
- The strip under it says when the Automation fell due, how many times it has since
  (`Due 3 times since Mon, 9:00 AM`), and where it runs: `Worktree`, `Local`, a
  folder count, `New workspace` for a projectless Automation, or `Continues its chat`
  for a Heartbeat. It never repeats the instructions.
- The decision reads `Run in <Project>`, `Run without a Project`, or for a
  Heartbeat `Run in “<chat>”`. Hovering it adds `Runs on` with what the run uses
  and `From your Automation`. Its menu half opens the model menu for this run
  alone, starting from the Automation's own choice, and names a different choice on
  the button. A Heartbeat runs on its chat's Agent, so its decision has no menu.
- The row offers the message menu and `Skip this run`, the `Mark done` check.
  There is no Keep: a run is run, skipped, or handed elsewhere.
- `Handle manually` adds `Run` to the dispatch editor, with the run's model
  menu and `Edit Automation`, which opens the Automation where its folders, workspace and
  schedule change for every run. Choosing another action hands the message on
  as any message and withdraws the run.

Running it reads `Started “<Automation>”` in Activity, linking the run's chat with
its live status once the run reaches one, until the user marks it done. A run that
fails before reaching a chat returns with `Couldn’t run — <reason>` and `Retry`.
Skipping a run marks its message done, and Activity says `Skipped “<Automation>”`.
A run whose Automation was deleted says `Its Automation was deleted, so it can’t run`
and offers `Mark done` and `Handle manually`.

A run that needs the user after it starts says so with `send_to_inbox`; a
message from an Automation run's chat is labeled with its Automation's name.

## Deleting a message

A message sent by mistake, for example one holding a key or something private,
can be deleted:

- from the message menu (`Delete`);
- for the whole selection, from the selection bar;
- from an expanded Activity line, while its Page is still in its Inbox's
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
remain fenced Inbox workflows; only the user, or the user's own `Let Nodex start chats for me`, confirms work. Inbox
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
- `⌘/Ctrl+Shift+D` goes to the Inbox where the user is: in a Project or one of
  its chats it shows that Project's Inbox Home, and anywhere else it opens the
  Library Inbox. Either way it focuses the composer. The command palette
  exposes the same command as `Open Inbox`.
- `C` (or `⌘/Ctrl+Shift+C`), `Capture to Inbox` in the command palette, writes
  a message to that same Inbox without leaving. It opens that Inbox's own
  composer over the current place, with the same draft, title and images. The
  Inbox it lands in is named above it, with `Add title` opposite for a sender
  who wants to name the message rather than leave it to Nodex. `Enter` sends
  and closes it with `Sent to <Inbox>` and an `Open` action; `Escape` closes it
  and keeps the draft. A message that cannot be saved waits in that Inbox to be
  retried or recovered. When the Inbox's composer is already on screen, `C`
  focuses it instead. Text selected on an app surface starts the message. A
  capture is never linked to the chat it was written in: the Inbox is for
  deciding later where it belongs.
- The Inbox header offers:
  - the `Inbox` and `Activity` views, as pills with their glyphs like a
    Database's views, the Inbox showing its count;
  - `Open Inbox as a Database` in the Library Inbox, or `Open Board` in a
    Project's Inbox;
  - `Open Nodex`, the Nodex mark, which opens Nodex's own conversation;
  - `Inbox settings`, a panel that changes in place what routes and what new
    chats run on: under `Nodex`, when suggestions run, what Nodex runs on, and
    `Let Nodex start chats for me`; then whether suggestions choose each new chat's models
    and the model new chats otherwise run on, each with the composer's model
    menu. `Routing preferences and more` opens `Settings → Inbox`.

  Each Inbox is a tab, so its header spans the tab like a Board's: views at
  the start and tools at the end, in the same places as on every other tab.

- `Settings → Inbox` holds these Profile preferences:
  - under `Nodex`: when suggestions run (automatically, when the user asks, or
    never), `Let Nodex start chats for me` (off by default), and `Nodex runs on` (the Agent,
    model, effort and speed selected in the model menu);
  - how many suggestions can await Nodex at once, five by default;
  - `Start fresh` archives Nodex's conversation;
  - free-text routing preferences are the user's standing instructions to Nodex
    and take priority over its defaults;
  - whether a chat the Inbox starts opens with its message Pages in its right
    panel, which is on by default;
  - whether suggestions choose each new chat's models, which is on by default;
  - what chats the Inbox starts run on otherwise, chosen with the composer's
    model menu: the Agent, its model, and the model's effort and speed;
  - whether suggestions read Nodex's model guide, which is on by default and can
    be read in full there. It covers GPT-6.1, Claude Opus 5.5 and the models
    OpenCode offers free, which it marks free so suggestions can spend no budget
    on routine work. The guide changes with Nodex; the user's own view of each
    model belongs in the routing preferences.

  Choices read the Runtime's existing provider and model catalog without forcing
  discovery on open. Cached choices remain visible during background refresh;
  a first load shows Loading, and a failed read offers Retry without declaring
  the saved choice unavailable. Only a loaded catalog can establish that a choice
  is missing or unavailable, and an Agent whose status check has not answered yet,
  such as one still timing out while its models load, shows Checking models while
  Nodex checks again; work that needs it, Open Nodex included, waits for that
  check within its bounded catalog wait. Agent setting changes refresh the choices.
  An unavailable instance retains its real name rather than appearing as another Agent.
  Suggestions run often, so an omitted suggestion model resolves to
  GPT-6.1 Sol on Codex, and otherwise, or when the catalog lacks it, to that
  instance's catalog default. They look things up and choose models as well as
  routing, so an omitted suggestion effort is high on Codex and medium on Claude.
  Until a chat model is chosen, chats the Inbox
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

### Remote Member admission

Authenticated remote Members may read Activity and the mixed Inbox projection,
retry Problems, and use its
person actions: answer an option, Reply, Accept and Start. Commands retain their
current episode and request fences, and receipt replay belongs to the initiating
Member. Turn notes and Inbox answers require the Coordinator's Agent authority;
managed-chat handback requires captured Agent execution authority. These Agent tools
cannot be called directly by a remote Member. Notification-intent reads and claiming
belong to the Host. New commands remain denied remotely until explicitly admitted.

## Returning a message for routing

A managed chat calls `hand_back_message { reason }` when it is the wrong destination
for its current inbound message. The Host supplies that identity from the proved
execution; the model cannot choose a message ID. Core returns the original intake
Pages, or creates one envelope for a direct-chat message, preserving words, images,
author and dispatch history. A receipt makes exact retries return the same result.
The row shows `<chat> sent this back: <reason>` and re-enters at the return time.

Handback never grants consent to start work. Nodex routes with `explicit_request`
false, so a returned message never starts without the person. Its routing context names
the previous chat and keeps it a destination: Nodex's instructions route elsewhere unless
the person insists on that chat, and the person may choose it in the manual destination
picker. Core enforces at most two handbacks per
original message across rerouting and refuses already-answered questions, replaced
delivery attempts and changed, closed or erased original Pages. Unavailable causal identity or
attachments produce a refusal, preserving the message in its current owner.

Runtime remains the chat-content owner. Core retains hashes, bindings and receipts;
binary attachments of direct-chat messages are published with their new intake Page
in one transaction. A partial attachment failure creates no intake Page or File.
