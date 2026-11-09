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
conversation like any chat's. The renderer presents intake, Turns, answers and controls.

See [ADR 0078](../adr/0078-nodex-coordinates-managed-work.md) and the
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
  only on an explicit reference, asks one concrete question at a time, and keeps each Turn note to a
  sentence or two.

## Routing

Every suggestion request in the Inbox is answered by Nodex, under the same rules, fences, time
budget and failures as before (see [Suggestions](./inbox-behavior.md#suggestions)). A request
reaches Nodex once, and its time counts from when Nodex starts on it, not while it waits behind
Nodex's other work. An answer Nodex sends after its time ends, or after the request was
replaced, records nothing. A form Nodex gets wrong is returned to it to correct, so a
correctable mistake does not fail the request.

Nodex knows what it already dispatched, so a message that clearly continues ongoing work goes to
that work's chat. Replies to Nodex answers carry the answer with them.

Work handed to a Project chat is that Project's card. Confirming a new chat moves
the message Page into the Project's primary Database in the same decision; sending
a Page still in the Library Inbox Database to an existing Project chat does the
same. It receives the Project's Page key, appears on its Board and follows the
handling's Status while keeping Owner, Assignee, Workspace and thread follows.
Plan steps are created in their chosen Projects' Databases. Projectless chats keep
their Pages in the Library Inbox Database. The original entry keeps its intake
provenance, and Activity records where the work went.

Nodex marks each new-chat or send-to-chat suggestion that answers a request the person themselves
clearly made. For those, its prompt is only a short routing note: the chat receives the person's
own words unchanged. A routing note has at most thirty words and no additions; Nodex corrects
an overlong note or any additions before its suggestion can be recorded.

### Let Nodex start chats for me

`Let Nodex start chats for me`, beside Nodex's other settings in the Inbox panel and in Settings, decides
what happens to Nodex's advice. It is off by default, so every suggestion waits for the person.
When it is on, a new-chat or send-to-chat suggestion that Nodex marked as the person's own clear
request, for a message the person wrote and has not changed since, starts at once, without its
optional additions. The card says where the work went, such as `Nodex is starting a chat in
Nodex`, and Activity says `Sent “<message>” to a new chat on your request`. Every other suggestion — notes, filing, plans,
anything an Agent, the command line or an Automation sent — still waits. While suggestions
are off the switch is unavailable.

Turning it on never starts messages sent before it.

## Managed chats

A chat Nodex watches is managed. Every chat an Inbox dispatch starts or continues, and every chat
a Page start opens, is managed from that moment. `Managed by Nodex` in a chat's menu hands any
other active chat to Nodex or takes one back. The checkbox shows whether the chat is managed;
archived chats do not offer it.

A managed chat is told, on every turn, which work it is doing and to report it. When the work is
ready for review, blocked, failed or turns out unnecessary, the chat calls `report_work` once
with the outcome and a short summary of what changed and the evidence. Ready attempts
In Progress → In Review; dropped attempts Triage/Todo/In Progress → Canceled. Blocked and
failed leave Status unchanged. Each automatic move requires the expected predecessor and
no person Status edit since that attempt began; the report is retained when the move skips.
A report from an older chat cannot move a Page whose active chat has changed.

Nodex hears about a managed chat when it:

- reports its work;
- asks a question or waits for an approval, including a question that remains answerable after its turn ends;
- ends a turn without reporting and with nothing waiting on the person;
- fails;
- seems stalled: still working on the same turn with no progress for twenty minutes and nothing
  waiting on the person.

A managed chat's attention uses its execution tree: live delegated approvals and questions
handed to the person count alongside root requests. Questions still owned by a delegating
Agent stay out of person attention. Page Turns and Inbox share this rollup.

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
each means: most need nothing; a current Turn may receive a note when the derived text needs more context. It may ask a chat that stopped without reporting to report, or tell a chat
that failed on a passing error to continue.

Managed chats yield question, approval and terminal notifications to the Page Turn owner. Unmanaged chats retain their existing policy.

## Nodex in the Inbox

The Inbox shows what is the local Member's to handle. Work Pages enter through
their current Turn, independently of any prose Nodex writes. Nodex uses
`write_turn_note` only when context adds to the exact question, report summary,
failure reason or finished Prerequisites already shown. Notes belong to the
Page and current episode, use delivered Work events, and remain immutable.
They contain at most 100 words. Exact event-set, body and notify retries reuse
the note. An event cannot back two notes in one episode.

Question and approval episodes notify by rule. Nodex chooses notify for review,
blocked, failed and stalled notes only when an interruption helps the person.
The Member, Page and episode identify one durable notification intent. Repeated
notes cannot interrupt twice; stale episodes cannot notify. Answers stay quiet.
Main applies preferences, focus and OS permission.

`answer_inbox_question` answers a pending intake question from Nodex's existing
facts and handles it in the same transaction. Each question has one quiet answer.
A reply to that answer is ordinary intake. A work-Page reply instead goes to its
active chat as the person's unchanged message or exact pending-question answer;
it creates no intake entry and never silently falls back to routing. The reply's
accepted message and requesting Member commit together before delivery. A later
Run uses that retained Member for application authority, including asynchronous
answers after the original native Turn completes or its provider Session goes idle. Actions
revalidate the Turn episode, and missing or ambiguous destinations offer Open chat.

## Work on the Board

Every Page has a Member Owner and one Assignee, either a person or an Agent.
A personal Library has one Member, You; the Owner row stays hidden there. The
Assignee picker lists People before Agents. Agent choices include provider, model
and effort. A Page in a Project's Database can start its Agent work:

Handing an unassigned Page to an Agent chat assigns that chat's Agent instance,
model and effort in the same transaction. This applies to Inbox dispatch, plan
step starts, Page starts and explicit handoffs. It never replaces an existing
Member or Agent Assignee and never grants automatic-start consent.

- **Start automatically** lets an Agent Assignee start once its Prerequisites are
  satisfied. It is a switch in the Assignee menu, and the Assignee row then reads
  `Auto-start` after the name. Only a person grants this consent. Reassigning the Page
  clears it. Without consent, Nodex asks first: Core refuses Nodex's own start, and the
  Page's Status offers the person Start. Person assignments never offer this switch.
- **Waits for** names the Pages it must wait for. A Page cannot wait for itself, and no chain of
  Waits for may lead back to where it started. A Prerequisite is satisfied only when it is active in its retained Data Source and Done.
  In Review awaits acceptance, and Canceled never satisfies a Prerequisite.

A Page's Turn names whose action comes next. Core resolves these rules in order;
Board cards, List rows, the Page, CLI and work briefs use that same answer.

| Actor and reason         | When                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| None                     | Status is Done or Canceled.                                                                                       |
| Paused                   | The most specific effective hold gives the Turn to the Member who paused it.                                      |
| Owner · Question         | The active chat has a pending question.                                                                           |
| Owner · Approval         | The active chat has a pending approval.                                                                           |
| Agent · Working          | The active chat is working with healthy progress. Its Agent executes for the Page's Assignee, including a Member. |
| Agent · Queued           | The active chat awaits Runtime admission. If its Agent is unknown, the chip shows the queue ordinal.              |
| Owner · Blocked / Failed | The active chat's latest report is blocked or failed, or its execution failed without a person's Stop.            |
| Owner · Stalled          | Existing stall detection finds no progress.                                                                       |
| Owner · Review           | Status is In Review.                                                                                              |
| Prerequisite Page        | The first Prerequisite, ordered by Page identity, is unsatisfied.                                                 |
| Start / Agent · Starting | An Agent Assignee has no active chat in Triage or Todo; automatic-start consent selects Starting.                 |
| Member · Working         | A Member Assignee is In Progress.                                                                                 |
| None                     | No earlier rule applies.                                                                                          |

Every surface words a Turn the same way for its reader: the Page's Status row, Board cards,
List rows, Inbox rows and the phone. A Turn waiting for one person addresses the local Member
as you and names anyone else:

| Reason   | For you               | For another person           |
| -------- | --------------------- | ---------------------------- |
| Question | Needs your answer     | Waiting for Alice’s answer   |
| Approval | Needs your approval   | Waiting for Alice’s approval |
| Review   | Ready for your review | Ready for Alice’s review     |
| Blocked  | Blocked · needs you   | Blocked · needs Alice        |
| Failed   | Failed · needs you    | Failed · needs Alice         |
| Stalled  | Stalled · needs you   | Stalled · needs Alice        |

The rest read the same for everyone. Working names the executing Agent by its provider, such as
`Codex is working`, or the Member Assignee (`You’re working`, `Alice is working`); Starting reads
`Codex is starting`. Queued reads `Queued · 2nd` with the queue ordinal, or `Queued` once its
Agent is known. A Prerequisite reads `Waiting for NODEX-2` and links to that Page. Ready work reads
`Ready to start`. A paused Turn reads `Paused`; its tooltip says who paused how much, such as
`You paused this Project`. None says nothing. A phrase that needs the reader uses the attention
tone, or error for Failed; every other phrase is secondary text. Cards and rows lead the phrase
with its reason's glyph, a small spinner for Working, and show Start in place of `Ready to start`.
The interface never calls any of this a Turn.

Working and queued chats use their current Agent selection, falling back to the
admitted chat selection before execution is observed. An unassigned Page still
shows that executing Agent. With a Member Assignee, the phrase names the Agent
because it is the one executing; the Member remains the Assignee.

A Page's Status row carries its Turn: the stage control, then the phrase, then its primary
action: Resume for a Page hold, Resume Project for an inherited Project hold, Resume all work for
a Space hold, Start for ready work, Accept for Review, and Open chat for Question, Approval,
Blocked, Failed, Stalled or Working when there is an active chat. Start explains when this device
cannot run the work. A Page with work always shows its Status row; one without work keeps a plain
Status row. The Assignee row names only the Assignee, such as GPT-5.5; its menu chooses the
model and effort through the provider catalog.

Main records revisioned observations for all active chats, including unmanaged
chats: execution state, pending question/approval identities, queue class and
position, terminal outcome, stall and person-stop facts. Unavailable observation
is distinct from failed execution; it preserves unresolved attention until a
fresh available observation resolves it. Only managed chats publish Coordinator
events. Effective execution holds take precedence immediately after Done
and Canceled and before attention. Core selects the most specific hold first: Page, Project, then Space. Resume clears only that hold; another applicable hold keeps the Page paused.

Each continuous actor/reason pair has a durable Turn episode and start time.
Repeated observations preserve it; actor or reason changes, including returning
to a previous pair, start a new episode. Page-key renaming does not change the
blocking Page's identity. Changing applicable pause holds also begins a new episode. Hold changes invalidate every Page in their scope. Input changes and reverse Prerequisites invalidate
Turn through their LocalCommit.

**Starting.** `Start` on a card, in its Page's Status, on its Inbox Turn row, or an Agent's `start_work` hands
the Page to a new managed chat in its Project, on its Agent Assignee, moving
it from Triage or Todo to In Progress through the guarded transition. The chat receives a brief: the Page's key,
title, Owner, Assignee and body, and for each Prerequisite its key, title, Status and what it reported. `Start
again` opens another attempt and selects its chat as the Page's active chat. Ordinary
related links do not select an active chat. Archiving or unlinking that chat clears the
selection; restoring it does not take work back from a newer attempt. Replies and follow-ups
use the active chat. The brief names that chat as the work destination and lists its followed GitHub
threads.

In a git Project, starting a Page's work creates its own Workspace on an attached
branch based on the default branch's current commit. Work starts, Inbox new-chat
dispatches and a Page's Open in new chat use the same allocation. Every later chat
for that Page reuses it. The selected active chat identifies its work Page, while a first
start carries that Page in its launch. Sending a Page into an existing chat keeps that chat's
directory. Projects without Git keep their local path.

A Page with its own pull request or followed GitHub threads shows a GitHub row of compact
links, such as `PR #2 · Open` and `Issue #14`; its branch waits in the row's tooltip and behind
Copy branch name. A Page with only a checkout shows a Branch row with the branch name. Board
cards show a compact PR indicator. A pull request belongs to the Page only when its head
branch and head repository match the Workspace. Nodex refreshes that observation
after execution and on request, retaining known links when GitHub is unavailable.
Done or Canceled requests checkout cleanup after every consuming chat is idle; the branch
and PR link survive. Starting reopened work restores the same branch.

**GitHub updates.** Sources deliver followed-thread Triggers straight to the Page's
active chat as untrusted Host input through Runtime’s automatic-root admission and the
same execution holds. The Coordinator does not reassess these updates. Human updates remain
eligible after completion; bot and CI updates wake only open work. A verified own
PR supplies guarded lifecycle milestones; context follows never move Status.
Unfollowed assignments, review requests and mentions enter the Inbox with GitHub
provenance and require the person's dispatch decision. See [Sources](sources-behavior.md).

**Acceptance.** The person accepts reviewed work with `nodex page accept <page>`, which moves
In Review to Done. A verified merge of its own PR also records Done. Agents cannot
accept work themselves. Done and Canceled share terminal View filtering,
sorting and `completed_at` behavior, but only Done records acceptance.

**When Prerequisites are satisfied**, a Page that starts automatically starts once, and one that
asks makes Nodex ask the person, naming what finished.

## Pause

A person can pause a Page from its actions menu, a Project from its sidebar context menu,
or all Agent work from the Inbox header. The Space control becomes `Paused · Resume`.
Page, Project and Space holds compose: resuming a Page never clears a Project or Space
hold. Agents cannot change holds, including through their attributed CLI.

Pause commits before native execution is stopped. Runtime acknowledges either that pause
was requested or that all affected native work has stopped. Running work and delegated
Threads stop, while queued inputs, retry intent and delegated results stay durable.
Holds survive application and Runtime restarts. Paused time does not spend a pending
routing request’s deadline, including overlapping holds.

Automatic starts, ready-to-start events, Inbox automatic confirmation and chat delivery,
Coordinator work batches and nudges wait behind the effective hold. A Space hold also
prevents new Host input to Nodex, including routing follow-ups. Monitoring continues to
record facts. On resume, current facts reconcile and each still-live event is delivered
once. A batch with held and eligible work is rebuilt so the eligible work can proceed;
its held events remain pending. Already accepted input stays with Runtime.

The Composer keeps the person's draft and blocks Send while held. A separate `Resume to
send` action clears the Page hold. Parent holds instead offer the explicitly named
`Resume Project` or `Resume all Agent work` action. Each clears only its own scope; sending
never silently changes policy. This keeps the pause's scope visible before broader work
is resumed.

The CLI offers `work pause --page <selector>`, `work pause --project <selector>`,
`work pause --space`, the corresponding `work resume` commands, and `work holds`.
`--idempotency-key` preserves the operation identity across an uncertain response.

## Plans

When one message asks for several distinct pieces of work that must happen in order or belong in
different Projects, Nodex may propose a plan instead of one chat. Its strip lists each step: the
Project, title, Agent and what it waits for. Confirming the plan creates each step as a Page in its
Project's Database, with its Agent Assignee, person-granted Start automatically and Waits for edges, and
starts the steps that wait for nothing; the rest wait until their Prerequisites are Done. A plan never
starts on the `Let Nodex start chats for me` consent.

A plan has 2–8 steps with unique local keys. Every prerequisite names another step and the
complete graph must be acyclic. A Project Inbox plans only in its own Project; the Library
Inbox may plan across eligible Projects, including prerequisites across Projects. Each step
has a title of at most 120 characters and a Nodex Markdown body of at most 4,000 characters.
Its Agent is an offered choice or the Inbox chat default frozen when the person confirms.

Confirmation creates all cards, bodies, automatic grants and edges together, with Status Todo.
A failure creates none of them and leaves the message waiting. Activity records
`Planned N cards from “<message>”`, and the plan keeps the created Pages in step order; retrying the same confirmation returns the same Pages.
Ready steps start through the Host scheduler after this transaction commits.

## Application tools

- `report_work { pageId?, outcome, summary }`: any chat linked to a Page reports its work on it.
  `pageId` may be omitted when the chat is linked to exactly one Page.
- `start_work { pageId, agent? }`: any Agent starts a Page's work in a new managed chat. Nodex
  starts only ready work set to Start automatically, on its assigned Agent; Core refuses any other
  Page, whose Turn already asks the person. Its starts read as Nodex on behalf of the consenting
  person, and another Agent's as that Agent on behalf of the person it works for.
- `write_turn_note { pageId, eventIds, body, notify }`: the Coordinator adds at most 100 words of context to the local Member's current Page Turn, backed by 1–8 delivered Work events. It decides whether review or a problem needs an interruption.
- `answer_inbox_question { questionPageId, body }`: the Coordinator writes one quiet answer and handles that question atomically.
- `inbox_suggest`, `write_turn_note` and `answer_inbox_question` are Coordinator-only tools.

### Managed-chat handback

`hand_back_message { reason }` returns the chat's Host-proved inbound message to
intake. It preserves the person's words, attachments and original author; it is
separate from a Page work report. After returning it, the chat stops working on
that message. A unique receipt supports retries, and the original message can be
returned at most twice. Answering a question prevents returning the earlier inbound.
If the answer starts a continuation, the reply can be returned as its own message,
with the person’s original words and delivery identity.

For Nodex, a returned message is a new routing decision, never new start consent.
It carries the previous chat and reason. Nodex sets `explicit_request: false` and
chooses another destination; only the person can explicitly choose the prior chat.
