# Page Discussions

A Discussion belongs to one Page and contains ordered Comments. It can refer to
the whole Page, contiguous sibling Blocks in document order, marked text, or a
data point in a Visual. A Discussion retains up to 500 characters of its
original quote. A removed anchor leaves the Discussion orphaned, with the quote
and Comments available. When a Block carrying marked text moves to another Page,
the Discussion follows the text. Resolving retains the anchor and Comments.
Members can reopen a resolved Discussion.

The comment mark uses the Discussion ID. A client can supply UUIDv7 identities
for the Discussion and its first Comment. Repeating the same creation with
either identity keeps the original Discussion and first Comment. The mark and
the Discussion can reach Core in either order. Core recomputes the anchor from
the document when the mark arrives or disappears. A text creation that arrives
first can carry the selected quote. A semantic client can also supply the
observed UTF-16 range and text and create the mark with the Discussion.

When Core applies a Markdown edit, marks stay on whole matching words. If the
edit replaces an entire marked run, the Discussion follows the replacement.
If it replaces only part of a marked run, the Discussion stays on the matching
words that survive.

## Comments and Asks

Comment bodies support paragraphs, lists, inline styles and links, code, and
Page and chat mentions. Use `<nodex://members/MEMBER_ID>` to mention a Space
Member. Core validates the Member and derives the mention list. A Comment can
also address a Member with `questionFor`. A subsequent reply from that Member
clears the waiting condition. Authors can update their own Comment body or
soft-delete their Comment. Other Comments and the original attribution remain
available. An Agent reply is attributed to Nodex on behalf of a Member.

A Comment addressed to Nodex creates a queued Ask. An Ask has a kind of Ask,
Check, Check Page, or in-place Ask. It can specify the Agent selection and the
requester's preferred conversation. The actual Session and Run are recorded when
the dispatcher advances the Ask. The dispatcher reads the queue oldest first
and receives a Page-scoped event when an Ask is queued.

An Ask advances from queued to working, then to answered, needs you, failed or
stopped. The author can retry a failed or stopped Ask. Retry queues the request
again and retains the requested conversation and Agent configuration. A Check
can return a verdict of true, partly true, false or unverifiable with cited
evidence.

The Page setting `nodexAnswersQuestions` defaults to false. When enabled,
Nodex answers eligible unaddressed questions as the Page Owner. Explicitly
addressing a Member directs the question to them.

## Suggested edits

A Suggested edit is attached to a Comment and replaces a contiguous range of
editable Blocks. Core captures the original Nodex Markdown and hash when the
Suggested edit is made. In Suggest mode, Core checks that the original Blocks
still match the copy the person started editing. An editor can accept it when the same Block range still
renders to the captured Markdown. Core applies the change as the accepting
Actor and preserves unchanged Block identities and comment marks. If the
original changed, the Suggested edit becomes stale. An editor or the author can
reject an open Suggested edit.

## Pending blocks and Run revert

A Pending block records an intent and may point to a Discussion. Its Nodex
Markdown is `::pending{intent="Create a weekly chart" discussion="DISCUSSION_ID"}`.
The in-place Ask uses its request as the Block anchor quote.
Omit the `discussion` attribute for an independent placeholder. Portable export
omits Pending blocks. When a single write replaces a Pending block with result
Blocks at its position, its Discussion is anchored to the inserted Blocks.

Revert a Run on one Page to restore changed Blocks and remove created Blocks
that still match the Run's result. The receipt lists reverted Block IDs and
conflicts by Block ID. Later edits remain intact. A deleted existing Block is
reported as a conflict. Consumed Pending blocks stay consumed. The revert is
recorded under the requesting Actor.

## In the Page

- **Starting.** Select text and choose **Comment**, **Fact-check** or **Ask Nodex** in the
  selection menu. Comment and Ask Nodex open a composer under the selection, which stays
  highlighted while the person writes. Escape or pointing elsewhere drops the draft.
  An editor's Comment marks the text in their editor; while suggesting, or for a
  Commenter, Core marks a one-Block selection itself. A selection across Blocks then
  anchors on those Blocks.
- **Composer.** `@` lists the Space's active Members and Nodex. A chosen Member is stored
  as a member mention; choosing Nodex turns on **Send to Nodex** instead of adding
  text. **Send to Nodex** starts on in a personal Space, where nobody else would
  answer, and off in a team Space. Enter sends; Shift+Enter adds a line.
- **Margin.** Open Discussions' text is tinted. When a 248px card fits to the right of
  the content column, cards sit beside their anchors in document order without
  overlapping. The focused card is pinned to its anchor, expanded, and has a reply field.
  Otherwise compact markers sit in the gutter, one per line, showing the number of
  Comments. A spinner means Nodex is working; a tint means something waits for you.
  A marker opens the same cards beneath its line. Clicking marked text focuses its
  Discussion; pointing elsewhere closes it.
- **Cards.** A card shows each Comment with author and time. Nodex's Comments read
  "Nodex for _Member_". A Check shows its verdict with a symbol and a word
  (● True, ◐ Partly true, ✕ Not true, ? Can't verify) and its evidence links. A
  Suggested edit shows a word-level diff with **Accept** and **Reject** for whoever
  may decide; its outcome replaces the buttons. An Ask still running shows its state,
  **View** and **Stop**; a failed or stopped one shows **Retry**. Resolve and Undo
  this Ask appear on hover. A question nobody has answered for five minutes offers a
  quiet **Ask Nodex**. A Discussion whose text was deleted shows the original quote
  struck through.
- **Comments panel.** The toolbar's Comments control counts open Discussions and lists
  every Discussion by filter (**Open**, **For me**, **Nodex**, **Resolved**), newest
  activity first. Choosing one scrolls its anchor into view and opens its card. Its
  foot holds **Nodex answers questions on this Page** for people who may edit.
- **Suggest mode.** The toolbar's Suggest control switches an editor between editing and
  suggesting; a Commenter always suggests. While suggesting, nothing the person types
  reaches the Page. Their first edit copies the Page privately, and they keep editing
  with every editor feature. A bar at the bottom counts the changed runs of Blocks and
  offers **Discard** and **Suggest**. Suggest turns each run into one Suggested edit
  and returns to the live Page after all Suggested edits are saved. If submission
  fails, the private copy stays available. Suggest retries the outstanding edits,
  and Discard returns to the live Page. Blocks with an open Suggested edit carry a
  blue accent.
- **Inbox.** When Discussions wait for the person, the Inbox shows "_N_ in your Pages"
  at the top. Page Owners receive open Suggested edits from other Members and from
  Nodex acting for those Members. An answered Ask leaves the requester's Inbox when
  they reply, resolve the Discussion, or decide a Suggested edit after the answer.
  Choosing an item opens the Page with that Discussion revealed.

## Agent access

Use `nodex discussions` or the equivalent managed `discussions_*` tools. Use a
Suggested edit for corrections and for edits made while acting for a Commenter.
Resolve a Discussion opened by Nodex only if nobody else has commented.
Discussion and Comment queries are also available through the `discussions`
and `comments` SQL relations. Nodex Markdown Page reads omit comment marks.
