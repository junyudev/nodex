# Ask Nodex from a Page

A Member can address Nodex in a Discussion, use Check on a statement, check a
whole Page, or ask for work in a pending block. The request appears as “Ask from
Page” in the conversation with a link to the Page. The Run also receives the
anchor quote, nearby Nodex Markdown and earlier Comments.

## Conversation and authority

An Ask uses the requester's selected conversation when they own it, it is
available in the Space, and it has no Page links or Page workspace. Otherwise
Nodex opens a conversation for that Member and Discussion in the Page's Project,
using the ordinary Project workspace. Follow-ups reuse the Discussion's conversation.

The Page reference in the Ask message supplies context for the Run. Starting an
Ask leaves the Page's Status and Assignee as they are. An Ask has no entry in
**Linked chats** and creates no Page workspace, branch, or worktree. Nodex acts with the requester's
Member role and execution policy. Another Member's Ask in the same Discussion has
its own requester and conversation.

A choice from the Page's Agent config chip applies to that Ask. With no choice,
Nodex uses the Inbox's **Agent and model Nodex runs with** setting, as Ask for
change does.

## In the Page

- **Ask in place.** In an empty line, `@` → **Nodex** (also offered for `@no` and
  `@agent`) or `/ask` opens a composer at that line with the Agent config chip. Its
  default runs the Agent and model Nodex runs with. Enter submits. The line becomes a
  pending block; a line that already has text keeps it and the pending block goes
  below it. The request does not stay in the body: it becomes the first Comment of a
  Discussion anchored on the pending block. The Ask can use the chat beside the Page
  when it meets the conversation rules above.
- **The pending block** shows Nodex's intent, or the request until Nodex sets one, with
  its state, the recent actions of the Run, the requester and elapsed time. It offers
  **View work**, **Stop** while it runs, and **Retry** and **Remove** after a failure
  or stop. Its card stays closed, because the block already shows progress. When
  Nodex replaces it, the card holds Nodex's reply.
- **Ask about a selection.** The selection menu's **Ask Nodex** opens the Comment
  composer with Nodex addressed. **Fact-check** sends "Is this true?" as a Check
  without a composer.
- **Attribution and undo.** Resting the pointer on a Block Nodex wrote shows
  "Nodex for _Member_ · time" at its top-right. Choosing it opens the Ask's
  Discussion, whose card offers **Undo this Ask** once an in-place Ask is answered.
- Someone suggesting, or a Commenter, cannot ask in place, because it writes the Page.

## Progress and results

The Space host picks up queued Asks when it starts and when new Asks arrive.
Each attempt submits one message to the Agent runtime. The host resumes tracking
the same message and Run after a restart.

- **Queued** waits for dispatch. **Working** includes time waiting for the
  conversation to start the Run.
- **Needs you** means the Run has a question or approval, or Nodex replied with a
  question for a Member. A waiting Run can return to Working.
- **Answered** means the Run ended and left a reply in the Discussion.
- **Failed** or **Stopped** records an unsuccessful or interrupted Run. When the
  Run ends without a reply, Nodex leaves a short Comment with a link to its
  conversation.

Stop belongs to the requester and Page editors. It cancels the Ask's queued or
active Run without stopping other work in that conversation. Failed and stopped
Asks can be retried. A retry starts another attempt and retains the request.
The Page can show the Run start time and up to five recent actions from the
conversation.

An in-place Ask begins in a pending block. Nodex sets its intent, then replaces
it in one write so the Discussion follows the result. A failure leaves the
pending block available for retry or removal. The Page can show the last
recorded writer of each Block and use the writer's Run to undo its changes.

A Check replies with a verdict and linked evidence. A correction is a Suggested
edit. Check Page opens Discussions where a claim needs correction and posts a
Page-anchored summary. An ordinary Ask answers the question and changes the
Page when requested. Nodex records a card-sized reply in the originating
Discussion.

## Auto-answer and Inbox

With **Nodex answers questions on this Page** on, a new Discussion's first
question goes to Nodex on behalf of the Page Owner. A question can use a
question mark in English or Chinese. Questions addressed to Nodex or to another
Member already have a destination.

The Discussion Inbox includes mentions, replies to Discussions a Member
participated in, questions and approvals waiting for that Member, answers to
their Asks, and open Suggested edits on Pages they own. One row updates per
Discussion and opens at the Discussion on its Page. See [Inbox](inbox-behavior.md).
