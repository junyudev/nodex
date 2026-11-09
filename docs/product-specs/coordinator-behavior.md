# Coordinator Behavior

## Intent and authority

Running many Agent chats at once makes the person the bottleneck: every chat finishes, asks,
fails or stalls on its own. Nodex, the Profile's Coordinator, takes that coordination on. It routes
every Inbox message, watches the chats it manages, and speaks in the Inbox only when the person
must act or can use a result. The aim is the right help at the right time and nothing at any
other time.

Rust Core owns the Coordinator binding, Managed chats, Work reports, Work events and their
delivery batches, Agent work, Prerequisites, and every Inbox record Nodex writes. The Desktop
Host owns the Coordinator's lifecycle and standing instructions, observing Managed chats,
delivering Work events, automatic starts and notifications. Agent Runtime owns the Coordinator's

[Inbox behavior](./inbox-behavior.md) it extends.

## Nodex

- Nodex is one long-lived chat per Profile, created the first time it is needed and running on
  the Agent and model chosen under `Nodex runs on` in Inbox settings. It never appears in the
  sidebar, chat lists, search, or as a place to send work.
- `Open Nodex` in the Inbox header opens its conversation like any chat. The person can talk to
  it there; what arrives from Nodex itself (routing requests and work updates) reads `Sent by
  Nodex`.
- Nodex's conversation is working memory. What it decides lives in the Inbox, on Pages and in
  linked chats, so `Start fresh` under Nodex in Inbox settings archives the conversation and the next
  need starts a new one without losing anything.
- Standing instructions reach Nodex on every turn: it routes and watches but never does the work
  itself, never rewrites a request it starts on its own, attaches a message to an existing chat
  sentence or two.

## Routing

Every suggestion request in the Inbox is answered by Nodex, under the same rules, fences, time
budget and failures as before (see [Suggestions](./inbox-behavior.md#suggestions)). A request
reaches Nodex once, and its time counts from when Nodex starts on it, not while it waits behind
Nodex's other work. An answer Nodex sends after its time ends, or after the request was
replaced, records nothing. A form Nodex gets wrong is returned to it to correct, so a
correctable mistake does not fail the request.

Nodex knows what it already dispatched, so a message that clearly continues ongoing work goes to

Work handed to a Project chat is that Project's card. Confirming a new chat moves
the message Page into the Project's primary Database in the same decision; sending
a Page still in the Library Inbox Database to an existing Project chat does the
same. It receives the Project's Page key, appears on its Board and follows the
handling's Status while keeping Owner, Assignee, Workspace and thread follows.
Plan steps are created in their chosen Projects' Databases. Projectless chats keep
their Pages in the Library Inbox Database. The original entry keeps its intake

Nodex marks each new-chat or send-to-chat suggestion that answers a request the person themselves
clearly made. For those, its prompt is only a short routing note: the chat receives the person's
own words unchanged. A routing note has at most thirty words and no additions; Nodex corrects
an overlong note or any additions before its suggestion can be recorded.


what happens to Nodex's advice. It is off by default, so every suggestion waits for the person.
When it is on, a new-chat or send-to-chat suggestion that Nodex marked as the person's own clear
request, for a message the person wrote and has not changed since, starts at once, without its
optional additions. The card says where the work went, such as `Nodex is starting a chat in
are off the switch is unavailable.

Turning it on never starts messages sent before it.

## Managed chats

A chat Nodex watches is managed. Every chat an Inbox dispatch starts or continues, and every chat
a Page start opens, is managed from that moment. `Managed by Nodex` in a chat's menu hands any
other active chat to Nodex or takes one back. The checkbox shows whether the chat is managed;
archived chats do not offer it.

A managed chat is told, on every turn, which work it is doing and to report it. When the work is
ready for review, blocked, failed or turns out unnecessary, the chat calls `report_work` once

Nodex hears about a managed chat when it:

- reports its work;
- asks a question or waits for an approval, including a question that remains answerable after its turn ends;
- ends a turn without reporting and with nothing waiting on the person;
- fails;
- seems stalled: still working on the same turn with no progress for twenty minutes and nothing
  waiting on the person.

A pending question remains Attention until it is answered, cancelled or can no longer be
answered. Ending its Run alone does not resolve it. A turn that ends with a question still
waiting on the person produces no unreported-turn update.

Nodex learns these by reading each managed chat's current state, without its transcript, when
the chat changes, whenever chats are invalidated, and every two minutes, and comparing it with
what it saw last. After a restart it compares with its saved observation, so work that ended or
failed while the app was closed reaches Nodex once. Only a chat it has never observed since it became managed
starts with a baseline: its existing finished work stays quiet, but its pending questions reach
Nodex. The stall clock starts fresh after a restart; time with the app closed is never a stall.
A chat Nodex cannot reach is never taken to have failed; a stall is a candidate for Nodex to check,
never a change to the chat's status. A Run the person stopped stays quiet: it produces no failure
or unreported-turn update, and Nodex does not nudge it.

Each of these reaches Nodex once, in a batch with others, even across restarts. Nodex decides what
that failed on a passing error to continue.


## Nodex in the Inbox


## Work on the Board




**When Prerequisites are satisfied**, a Page that starts automatically starts once, and one that
asks makes Nodex ask the person, naming what finished.

## Plans

When one message asks for several distinct pieces of work that must happen in order or belong in
different Projects, Nodex may propose a plan instead of one chat. Its strip lists each step: the
Project, title, Agent and what it waits for. Confirming the plan creates each step as a Page in its

A plan has 2–8 steps with unique local keys. Every prerequisite names another step and the
complete graph must be acyclic. A Project Inbox plans only in its own Project; the Library
Inbox may plan across eligible Projects, including prerequisites across Projects. Each step
has a title of at most 120 characters and a Nodex Markdown body of at most 4,000 characters.
Its Agent is an offered choice or the Inbox chat default frozen when the person confirms.

Ready steps start through the Host scheduler after this transaction commits.

## Application tools

- `report_work { pageId?, outcome, summary }`: any chat linked to a Page reports its work on it.
  `pageId` may be omitted when the chat is linked to exactly one Page.
- `start_work { pageId, agent? }`: any Agent starts a Page's work in a new managed chat. Nodex
  Page, whose Turn already asks the person. Its starts read as Nodex on behalf of the consenting
  person, and another Agent's as that Agent on behalf of the person it works for.
