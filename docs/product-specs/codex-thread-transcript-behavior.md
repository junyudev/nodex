# Codex Thread Transcript Behavior

## Intent

This document is the source of truth for visible Codex Threads transcript behavior in Nodex.
It defines what appears in chat, what stays internal, how transcript state is projected, and how live and restarted threads stay consistent.

Other product specs should link here instead of restating transcript behavior.
Detailed Auto-review preset and approval-lifecycle rules are specified in [Auto-review Behavior](./auto-review-behavior.md).

## Scope

This spec covers:

- canonical transcript projection and entry ordering
- pending prompt projection and authoritative echo reconciliation
- visible item kinds and transcript rendering rules
- turn bucketing and composer-shell request rules
- transcript-only UI behaviors such as request-user-input rows, plan follow-up prompts, exploration summaries, searchable content units, and agent-body collapse
- v2 mixed-family activity classification, grouping, summaries, leaves, and agent-body collapse
- persistence and restart recovery rules
- internal bootstrap/context visibility rules

This spec does not cover:

- general workbench shell layout
- thread auth/account flows
- worktree creation, environment setup, and the client-only initialization item,
  which are specified in
  [Codex Worktree Creation Behavior](codex-worktree-creation-behavior.md)
- managed-worktree availability, restore, retention, and execution-location
  movement, which are specified in
  [Codex Managed Worktree Lifecycle Behavior](codex-managed-worktree-lifecycle-behavior.md)
- approval policy configuration outside its visible transcript effects

## Canonical Model

- The visible transcript is one canonical ordered array of `CodexTranscriptEntry` values for durable/read-model history. Live active-thread prose is reduced by the current renderer owner and shared through revisioned conversation patches; main remains the app-server transport, persistence, and fallback snapshot authority.
- Renderer surfaces consume canonical conversation snapshots and owner-published patches; JSX components do not reconstruct chat rows from raw runtime payloads or sort rows independently by timestamp.
- Renderer derives turn-scoped view models from that canonical transcript (`thread detail -> turn buckets -> render blocks`), but transcript merge/reconciliation stays outside the JSX layer.
- A canonical turn projects its params-sourced user input before its raw items. A matching raw `userMessage` echo is suppressed when it carries the same client identity or the same structural text/image input, provided that only permitted metadata items precede it. A blocked submit remains visible with `not sent` delivery semantics and no sent timestamp.
- A submitted prompt is represented by that params-owned turn occurrence, not by a synthetic transcript item. `CodexTranscriptEntry.source` distinguishes live, bootstrap, and replay projection only; it has no optimistic source variant.
- Fresh thread creation, pending prompt submit, live runtime updates, resume, and restart recovery must all feed the same projection rules and produce the same visible transcript shape.
- Resume, older-history pages, complete-history loads, rollback snapshots, and include-turn thread reads materialize only fully loaded protocol turns. Their hydrated turn context supplies the leading user row before raw items, so a matching server `userMessage` echo is suppressed structurally; partial `summary`/`notLoaded` turns fail the history boundary instead of producing an incomplete transcript.
- Runtime item normalization is an internal parse layer only. It may help extract tool metadata or streaming content, but it is not the renderer-facing transcript contract.
- Every user-visible agent turn requests the app-server's readable reasoning-summary stream with the Electron-compatible `concurrent_reasoning_summaries` capability and `detailed` default; an explicit per-turn summary override remains authoritative. The owner, follower, canonical optimistic state, and resumed thread settings use the same resolved policy.

## Visibility Rules

- Only actual conversation and visible tool/reasoning state belongs in the transcript.
- Internal bootstrap/context content such as `AGENTS.md`, developer instructions, and other session setup wrappers is not part of the visible transcript.
- Raw rollout `response_item.message` rows are not themselves visible transcript truth.
- Restart must not reveal transcript rows that were hidden in the live session.

## Ordering and Identity

- Transcript order is owned by the projection layer, not inferred ad hoc in the renderer.
- Projection assigns one canonical sequence order for visible entries.
- Params-owned submitted prompts and later authoritative user-message entries must reconcile into one visible row instead of rendering twice.
- Transcript identity and duplicate reconciliation operate at the transcript-entry layer, not by mixing raw rollout ids directly into renderer state.
- The detailed turn-level classifier, conditional assistant-promotion rule, and post-classification lane order are specified in [../codex-thread-turn-ordering-and-assistant-promotion.md](../codex-thread-turn-ordering-and-assistant-promotion.md).

## Transcript Entry Kinds

The visible transcript can contain these projected kinds:

- `userMessage`
- `assistantMessage`
- `reasoning`
- `plan`
- `userInputRequest`
- `commandExecution`
- `fileChange`
- `toolCall`
- `systemEvent`

Not every runtime payload becomes a transcript row. Only entries explicitly projected into these visible kinds render in chat.
MCP and dynamic app-server tool calls are specialized `toolCall` rows with canonical renderer state: MCP rows preserve plugin ids, app resource URIs, result metadata, and normalized resource content; dynamic rows preserve namespace, tool, arguments, status, output content, success, duration, and the exact canonical raw item.

## Prompt and Turn Behavior

- Sending from a new-chat composer creates a session-owned thread; editor/card send-to-chat flows keep focus in the originating surface.
- As soon as submit begins, the transcript projects the submitted user prompt from a nullable in-progress turn's params and keeps that row above the pending turn-body `Thinking` state until live response items arrive. The nullable turn contains no synthetic raw user item. In an active owned thread, the renderer owner appends and publishes that params-owned occurrence, calls `turn/start` through the owner-scoped app-server facade with the same `clientUserMessageId`, then rebinds the occurrence to the app-server turn id and publishes that rebind revision. A local conversation with no stream role resumes into renderer ownership before appending it; there is no direct main-owned submit branch. Follower submits wait for the owner revision before resolving.
- When the live user-message item later arrives, its canonical raw item remains in turn state for protocol identity. It is deduped against the params-owned user row only when its `clientId` matches the submitted `clientUserMessageId` or its input is structurally equal and only the reference-approved metadata prelude precedes it. A user message after actual turn work projects as a `steered` lifecycle marker even when the client id matches. Incremental item notifications must apply the same whole-turn duplicate policy as resume, rebind, and complete-history projection.
- A user message that represents a thread-goal submission carries a canonical `goal: true` transcript marker, including locally synthesized `/goal ...` rows and app-server `userMessage` items. The user bubble renders a persistent footer status, `Sent as goal`, with the goal target icon. This marker must survive normalization, transcript projection, duplicate merge, owner-published patches, and restart recovery; it is not inferred from the current saved goal alone.
- Editing the last user message is an owner-local visible transcript transaction. If the active local conversation does not yet have a stream role, Nodex first resumes the thread and makes the renderer the owner; it does not call a main-owned rollback+start helper. The renderer owner waits for pending owner publishes to settle, re-reads the current conversation and verifies the target is still the latest editable turn, then calls `thread/rollback` through the owner-scoped app-server facade. It projects the raw rollback response against the latest local state, records tombstones for removed turn/item ids so late notifications cannot recreate the old bubble, synchronously commits the rollback-only conversation to React, and publishes that rollback snapshot before starting the replacement through the normal owner-local pending-turn/rebind path. Inline edit does not request a source-null snapshot after submit, and followers wait for the replacement start revision when available before the edit action resolves. The rollback-only commit is an explicit UI boundary: the old bubble must be absent before the replacement user bubble can become visible.
- Forking from a turn is also owner-scoped. Followers first ask the owner to load complete history and wait for that revision; a local no-role fork first resumes into renderer ownership. The owner then sends `thread/fork` through the owner-scoped app-server facade instead of a separate renderer fork IPC.
- Active-thread owner actions that call app-server methods normally run through an owner-scoped request-client facade. The owner mutates visible conversation state locally and publishes the resulting stream revision; main validates ownership, performs the allowlisted request, and maintains recovery state without emitting source-null visible stream updates. Queued follow-ups and steer recovery are the deliberate semantic-command exception: Main owns their durable transition and transport, then gives the active renderer owner one fenced, immutable projection and closed optimistic-transcript directive to publish. Followers must not observe source-null patches for owner-visible actions such as normal turn start, edit rollback/replacement, fork-from-turn routing, queue state, pending steer state, thread settings/goals, or plan-implementation request removal, and follower actions wait for the owner-published revision when one is returned.
- Follow-up prompts steered into an already-running turn insert an optimistic `steeringUserMessage` transcript bubble without an extra lifecycle label. That bubble participates in the turn's canonical item order from creation, so later assistant output cannot render above the steer. Matching backend `item/started` `userMessage` notifications are treated as server echoes and must not accept or duplicate that bubble. When the matching authoritative backend `item/completed` `userMessage` arrives for the same target turn and equivalent input, the runtime accepts the bubble and appends a separate ordered `steered` lifecycle marker immediately after it. `steeringStatus` and the `steered` marker remain canonical state for ordering, queue recovery, and collapse persistence, but neither renders `Steering conversation` or `Steered conversation` in the transcript.
- While a turn is already running, composer submit intent resolves to an explicit action before submission: empty draft keeps `Stop`, non-empty primary submit is `Steer` or `Queue` based on the queue-follow-ups preference, and the alternate shortcut carries the opposite explicit action for one submit.
- Stopping an ordinary turn is immediate and leaves its latest turn `interrupted`. Once the thread is idle, the circular composer action becomes `Resume` only when the composer is completely empty, the latest turn remains interrupted, no saved thread goal or request surface owns continuation, and no other submit blocker is present. The Resume control keeps the ordinary 28px action geometry, uses a filled play glyph with `aria-label="Resume"`, has no ordinary tooltip, and shows the shared spinner while its request is pending. Typing or attaching anything replaces it with the ordinary Send action.
- Resume is an explicit owner-routed userless turn start. A no-role renderer first resumes and adopts thread ownership; a follower forwards to the current owner. The owner revalidates that the latest turn is still interrupted and no runtime, goal, request, steer, or duplicate Resume is active, appends one nullable in-progress turn with `input: []`, and sends app-server `turn/start` with that empty input plus the thread's current settings. It never replays the prior prompt, inserts `continue`, or creates a user-message row. A failed Resume removes its userless optimistic placeholder and restores the interrupted state so the action can be retried.
- `Queue` does not start a turn immediately. Main freezes the complete prepared Composer payload, appends a stable follow-up identity to the Core-backed ordered ledger, and asks the active renderer owner to publish the resulting queue projection. The Main queue Module is the only automatic/manual delivery owner. Automatic delivery is strict FIFO and stops at a loading/error state, an active turn, an in-flight row, or any paused head; manual `Steer`/`Retry` may target a later row without reordering it.
- A selected row remains present and disabled while `turn/start` or `turn/steer` is pending. It disappears only after transport succeeds and Core accepts the exact-revision removal. Transport failure retains the same identity, payload, and position with a failed pause and `Retry`; that failed head blocks automatic delivery. Retry reuses the stable `clientUserMessageId`.
- Authoritative terminal completion, rather than the submit or Stop response, resolves an optimistic steer that never received its matching authoritative user-message completion. Interrupted completion restores it once at the front and applies the interruption pause to every otherwise-sendable row atomically. Any other terminal completion restores only that unaccepted steer at the front as a failed row with `Run ended before the steer was accepted.`; the failed head blocks automatic delivery and remains available for `Retry`. A clean inactive-steer rejection instead falls back to an ordinary turn start with the same prepared message and does not create a duplicate queue row.
- Interrupted completion never starts queued work. `Queue paused because you interrupted` is shown while any such pause remains, and its `Resume` action clears only interruption pauses before reevaluating FIFO; it neither clears genuine failures nor starts the separate userless interrupted-turn Resume.
- Sending a fresh ordinary message while idle and an interruption-paused queue exists opens `Send message?`. `Send message` preserves the old rows and removes their interruption pauses only after the fresh start succeeds; `Clear queue` removes the old rows only after that success. Failure, Escape, and dismissal preserve both draft and queue. If the turn becomes active while the dialog is open, current Queue/Steer rules win and the stale idle policy is not committed. A fresh steer never resumes, clears, or drains the existing queue.
- Queue edit is copy-on-submit. Opening `Edit message` leaves the durable row in place while the Composer holds its stable identity and ledger revision. Queue replacement preserves that identity and position only if the exact revision still matches; sending the edit as a steer, ordinary message, or Side chat removes the original only after the new submission succeeds. A stale replacement or failed submission preserves the original and recoverable draft.
- Dictation is a separate Electron-only authoring path, not realtime voice. It inserts finalized text at the current Composer selection or passes that same text through the ordinary submit path; it does not author a transcript item or bypass prompt reconciliation. Capture, recovery, global paste, and Voice behavior are owned by [Dictation Behavior](dictation-behavior.md).
- If a turn is active and no visible response item has arrived yet, the renderer may show a pending `Thinking` fallback at the bottom of that turn. It is render-time activity presentation and never a synthetic raw or bucket item.

## Server Request Lifecycle

- Canonical pending-request state stores each complete app-server request envelope in arrival order. Repeated deliveries are retained as repeated entries; request state is not timestamp-sorted, deduplicated, or rebuilt from method-specific view fields.
- `RequestId` remains its original `string | number` scalar across app-server, main, owner/follower transport, response routing, and server withdrawal. Numeric `73` and textual `"73"` are distinct. A type-tagged string may be derived only for UI/map identity and never replaces the scalar protocol id.
- Every stored request ingress raises the conversation's request-side `hasUnreadTurn` flag. Request completion, local response, and withdrawal do not lower it; only the separate explicit read-state flow may do so.
- Command/file approvals, direct user input, and private picker requests require a present, non-empty-string thread id; invalid ingress creates no state or response. Valid command/file and private picker requests are pending envelopes without synthetic transcript items. Permission, user-input, and supported MCP elicitation requests retain the pending envelope and may also upsert their request-caused synthetic item. Ordinary dynamic tool calls dispatch without entering the pending queue; every delivered occurrence with a truthy thread id executes and receives a response independently, including equal-ID occurrences, while a falsy thread id produces neither dispatch nor response. That guard is downstream of classification: validated picker/setup/onboarding variants remain stored request-plane rows in an isolated waiter lane even with an empty thread id, so a generic dynamic completion or owner transition cannot consume or reject them.
- `serverRequest/resolved` is a server-side withdrawal, not a client response. It selects the first request whose scalar id strictly matches, completes that request's permission/user-input/MCP synthetic item with the family-specific empty response state when applicable, then removes every pending envelope with the same strict scalar id. A missing match creates no synthetic item or value-level request change, but still publishes the reference's filtered-array structural transition. Empty-string thread ids remain valid for withdrawing previously stored specialized occurrences.
- Ordinary approval, permission, user-input, and MCP replies carry their owning Thread id and select an exact pending occurrence in that Thread and request family before changing canonical state. They never infer a Thread by globally scanning request ids or consume a same-id occurrence from another family. Within the selected Thread, the canonical reducer still requires the expected first strict-ID non-plan envelope; a local plan request is skipped, but a wrong-family non-plan collision blocks the action. Command and file approval actions remain distinct end to end, so each symmetrically no-ops when the first non-plan match belongs to the other approval method. Missing, already-resolved, and wrong-family responses are ordinary no-ops and do not force owner recovery. A valid command/file response removes every same-ID request without creating a synthetic item. Permission and user-input responses complete their synthetic item before removal. MCP responses do the same: `accept` defaults omitted content to `{}`, while `decline` and `cancel` always carry `content: null`; accepting a connector-auth elicitation responds to every arrival-ordered equivalent connector request before removing them.
- Specialized onboarding/setup/picker replies inspect the first strict-ID envelope without excluding plan requests, so a leading same-ID plan entry blocks the action. Direct option/setup pickers return their typed response payload. Dynamic option/setup variants return a successful input-text wrapper containing the JSON payload; onboarding verifies only the stored method/tool at reply time and wraps its normalized `answers`; setup-step replies must match the original `role`, `task`, or `context` request and wrap the response without its `step` discriminant. Stored duplicate requests receive at most one real protocol response while all same-ID canonical envelopes are removed.
- `currentTime/read` bypasses resume and thread-start request buffers, replies immediately with integer Unix seconds, and never enters conversation state. Auth-token refresh, attestation, and legacy approval request methods likewise create no conversation state and intentionally produce no renderer-owned response; unsupported MCP elicitation is declined immediately without storage.
- Pending request-card placement, blocking/bucketization, and raw-request-to-renderer projection are downstream view concerns. They consume the canonical queue and synthetic history but may not redefine request lifecycle or identity.

## Conversation Read State

- Request ingress can only raise `hasUnreadTurn`; explicit read/unread actions are the only user control that lowers or restores it. The thread unread registry is durable independently of project-session rows, while every linked session derives its sidebar unread state from the thread.
- Selecting an unread conversation in the sidebar or command palette, viewing/refocusing it in the active focused viewport, or interacting with that viewport by pointer, keyboard, or wheel marks it read. The session/thread context action toggles `Mark as read` and `Mark as unread`. Archiving clears unread state.
- Explicit read-state changes synchronize loaded conversations, thread summaries, linked sessions, and other windows through a standalone message. They do not call the app server or advance the revisioned conversation stream; an in-flight owner cursor rebases locally without a corrective publication. Repeated same-state changes are no-ops, an older owner publication cannot restore the superseded value, and archive eviction rejects late request/unread/dynamic resurrection.

## Request User Input

- `item/tool/requestUserInput` presents a questionnaire in UI; selecting a preset answer is itself an explicit submission action rather than the first half of a select-then-confirm flow.
- While unanswered, `request_user_input` does not render inline in the scroll body. It appears in the composer shell above the input editor.
- After resolution, answered `request_user_input` remains visible as a compact `Asked N question(s)` disclosure row.
- That answered row stays collapsed by default and expands to reveal the question/answer pairs.
- A preset option is initially selected for roving keyboard focus but is never submitted without deliberate activation. Click, `Enter`, `Space`, and number keys `1`–`9` share one activation path. Ordinary user-input cards hold the activated option for a 180ms acknowledgement, then advance to the next question or submit on the last question. Setup-task suggestions use the same advance/submit contract without the acknowledgement delay. Approval, permission, authorization, and private option-picker forms remain explicit select-then-submit surfaces.
- Multi-question `request_user_input` cards preserve keyboard continuity: `Left` / `Right` moves to the previous or next question and restores the equivalent answer-control focus, `Up` / `Down` moves through preset options, `ArrowDown` from the last preset option can enter the free-form row, and `ArrowUp` from the start of that free-form field returns to the preset options. In free-form controls, unmodified `Enter` advances or submits, `Shift+Enter` keeps a textarea newline, and composition `Enter` is ignored.
- Ordinary questionnaire drafts are renderer-memory state keyed by conversation plus the type-tagged protocol request id and question signature. Navigation/remount restores the current question and answers for the same request, while an interleaved or replacement request cannot inherit them. Successful submit, dismiss, host timeout, server withdrawal, and app-server disconnect clear the matching draft. A request replayed after reconnect begins a fresh generation even if the server reuses its scalar request id. Drafts are not durable thread state.
- Non-blocking user-input requests participate in main-hosted inactivity resolution; blocking requests wait indefinitely for an explicit response. A non-blocking request presented in a focused window waits for 60 seconds of activity-free time before beginning a 90-second countdown; one not presented in a focused window begins the 90-second countdown immediately. A mounted task whose request surface is fully hidden behind another full-width panel is not presented. The visible badge is limited to the last 60 seconds. General pointer/keyboard activity resets only the initial inactivity wait, while any interaction inside the request card—including Dismiss or Escape intent—permanently snoozes auto-resolution for that request before the manual outcome is selected. Timeout first makes the request terminal, then sends an empty answer object through the ordinary response lifecycle and never chooses the preselected option.
- In an owned live stream, command/file approval, permissions approval, request-user-input, and MCP elicitation request ingress is reduced by the renderer owner and published as revisioned stream-state patches. Main keeps the app-server JSON-RPC pending response only; it must not emit a competing source-null request patch for these rows.
- Ordinary dynamic app-server tool-call requests are gated through the renderer owner when one exists, then executed by main from the original pending request and ACKed without creating a request card. Validated picker/setup/onboarding dynamic-tool branches remain canonical request-plane rows; their final card/form projection remains downstream request-UI work.
- URL-mode MCP elicitation requests that are not renderable as a supported HTTPS URL action or Codex Apps auth failure are declined immediately and do not create request cards.
- Owner-side request responses remove the pending request and publish the completed request item state immediately. Response UI surfaces route by the owning `conversationId` before local request lookup, so a stale follower that missed a request patch still forwards approval, permission, user-input, MCP, and notification actions to the current owner instead of calling direct fallback response IPC. Main-hosted timeout follows that same response boundary and forwards a synthetic `serverRequest/resolved` notification to the renderer owner after the empty response succeeds, preventing the owner from retaining a stale card. Later real `serverRequest/resolved` notifications are still accepted through the same revisioned stream patch path: the first strict scalar-id match supplies any family-specific completed permission, user-input, or MCP elicitation synthetic state, and every pending envelope with that scalar id is withdrawn.

## Plan Mode Follow-Up

- `item/plan/delta` streams incremental proposed-plan text only for an existing plan item; it must not create a proposed-plan card by itself.
- The final `item/completed` plan item `{ type: "plan", id, text }` is the authoritative proposed-plan content and overwrites any streamed draft text.
- `turn/plan/updated` remains the source for structured todo/checklist progress and must not be bucketed as a proposed-plan card. In an owned live stream, it is reduced by the renderer owner and published as a conversation patch.
- Every completed-plan signal type-scans and replaces prior same-turn `planImplementation` rows before appending one fresh item/request, even when its trimmed plan text is unchanged. The fresh request raises unread state and remains at the request tail.
- Removing a plan-implementation request completes every matching same-turn item without changing its existing timestamps and removes every same-turn canonical request. Starting another turn completes older plan-implementation items and globally removes stale or orphan request entries, including entries whose turn is outside the loaded page.
- When a completed turn’s latest visible plan item is non-empty, the composer swaps into an `Implement this plan?` request surface.
- That surface offers `Yes, implement this plan` and `No, and tell Nodex what to do differently`.
- Only the active parent `implementPlan` request exposes one request-owned intelligence footer below the rounded questionnaire card. It reuses the normal composer’s model, effort, and speed selector; background requests may remain above it, while every other request family continues to hide all composer controls.
- Accepting the plan waits for the displayed intelligence selection to commit, then starts one `Default`-mode follow-up turn prefixed with `PLEASE IMPLEMENT THIS PLAN:` using that exact model, effort, and speed. Starting the turn owns stale request cleanup so a settings or turn-start failure leaves the plan available for retry. Dismissal switches to `Default` before removing the request; freeform feedback preserves the current collaboration mode.

## Turn Rendering

- The renderer groups transcript entries by `turnId`, projects a flat renderer-item stream, bucketizes that stream, and then renders each turn in fixed block order:
  - `modelChanged`
  - leading `hook` items that appear before the first user message
  - `userMessage`
  - selected `modelRerouted`
  - tool activity blocks (`commandExecution`, materialized `patch`, `mcpToolCall`,
    `dynamicToolCall`, non-empty `webSearch`, `multiAgentAction`, inline `hook`,
    completed `mcpServerElicitation`, completed `userInputResponse`, and
    `contextCompaction`) plus auxiliary subagent activity state; canonical
    `reasoning` remains available only as turn-level fallback input and is hidden
    from tool topology
  - `systemEvent`
  - `assistantMessage`
  - post-assistant artifacts such as trailing `hook` items and trailing automatic approval review
  - inline incomplete `mcpServerElicitation`
  - `proposedPlan`
  - render-time live activity fallback when the current open activity slice resolves to `thinking`
  - completed inline `turn diff`
  - trailing status markers (`remoteTaskCreated`, `personalityChanged`, `forkedFromConversation`)
- The parent activity resolver computes global state, the main activity-slice
  state, and one mutually exclusive fallback owner. The latest open group owns
  reasoning only while that group is the latest visible unit, the slice remains
  open, and global state is `thinking`; otherwise an eligible fallback is
  standalone or absent. The fallback is not a canonical item, bucket entry,
  search unit, or persisted transcript row.
- Exploration, incomplete proposed plans, blocking requests, safety buffering,
  pending generated output, and final assistant output participate in the parent
  state machine instead of being leaf-level exceptions. A trailing visible
  assistant commentary closes the main slice; before final-answer output, the
  parent may still derive a post-assistant standalone fallback when no later unit
  owns the space. Commentary followed by later tools is not treated as trailing
  commentary for that later slice. The fallback uses the latest readable,
  non-comment reasoning-summary line or generic `Thinking`. An active tool always
  keeps its concrete family label and never displays reasoning in that label.
- Raw item lifecycle uses one shared decision contract in main fallback and renderer-owner flows. A started item replaces the first same-ID slot or appends; an authoritative completed item does the same only after an existing same-ID/same-protocol-type row is found, except that user messages, hook prompts, and subagent activity may complete without a start. Rejected orphan work completions can still establish turn timing, but never materialize a transcript row.
- The first raw work item in a turn stamps `firstTurnWorkItemStartedAtMs`; only `userMessage` and `hookPrompt` are excluded, so an `agentMessage` start counts as work and independently stamps `finalAssistantStartedAtMs`. Later events do not overwrite the first-work stamp, while duplicate agent starts may refresh the final-assistant stamp.
- Statusless reasoning, assistant-message, and plan items retain a lifecycle ledger
  in the canonical turn sidecar. One occurrence is identified by item ID plus
  protocol type: duplicate lifecycle events are idempotent and delayed starts
  cannot reopen a terminal occurrence, while a later item of another protocol
  type may reuse the ID as a new occurrence. Owner/follower snapshots carry the
  ledger through checkpoint recovery.
- Command lifecycle timing is turn-owned. `item/started.startedAtMs` overwrites the command ID's observed start, while completion with a non-null duration backfills only a missing value from `completedAtMs - durationMs`. Final command payloads replace provisional raw state instead of resurrecting fields absent from the authoritative completion.
- Ordinary generated lifecycle items retain their raw protocol identity. Image-generation rows add normalized `src`; collaboration rows emit receiver-thread hydration and add ordered receiver metadata; context-compaction rows add completion/source state. Review-mode markers remain hidden raw identities, so they count when resolving placeholder turns without creating transcript rows. Pending steering comparison uses the shared exact non-comment text plus image-count key, excludes comment-attachment label/placeholder inputs, and consumes a matching steer only on authoritative user completion.
- Active running turns with `firstTurnWorkItemStartedAtMs` project a first-class `workedFor` block before the first non-user item. That visible block renders as a plain `Working` label for sub-second elapsed time, then `Working for Xm Ys`, followed by a `border-current/20` divider. It is not a button and has no hover background or chevron. It is presentation-only timing and must not participate in the live-activity eligibility decision.
- Completed turns with first-work timing project the same internal block before the final assistant boundary, but completed collapsible agent bodies consume it as collapse-label input and remove it from visible expanded body rows.
- Incomplete permission requests and MCP elicitations block the same in-progress surfaces as approval and request-user-input state.
- Unknown replay/app-server tool payloads do not render a generic transcript tool row. The mounted transcript only renders supported tool families with dedicated surfaces (`exec`, `patch`, `mcpToolCall`, `dynamicToolCall`, `webSearch`, `turnDiff`) and keeps any remaining raw tool metadata internal to the canonical conversation state.

## Collapse and Search

- Agent-body collapse applies after a renderable final-answer boundary has started, or after a settled turn has subagent activity. The turn must not be interrupted and must have a renderable agent body or auxiliary subagent activity. Collapse never hides the user message or dedicated final assistant answer.
- Every eligible turn, including the newest completed turn, defaults to collapsed. A persisted disclosure state overrides that default, while active subagent activity prevents automatic collapse.
- In-progress turns without a final-answer boundary, interrupted turns, and turns without renderable activity do not expose an agent-body collapse toggle. Auxiliary null-anchor subagent activity may establish turn semantics, but it never creates an empty wrapper or toggle when there are no visible agent-body units.
- Collapsed historical agent-work labels resolve in this order: explicit completed worked-for timing, completed turn `durationMs`, then `X previous messages`.
- The completed historical `Worked for ...` row uses an inline left-aligned toggle button with no hover highlight, nested muted label spans, `aria-expanded`, a rotating `icon-2xs` chevron, and a separate `border-token-border-light` divider row. The chevron transitions between zero and ninety degrees over the semantic 150ms basic duration with the standard transition easing.
- Expanding a completed historical agent body mounts its full-height layout immediately, then fades it from zero to full opacity while translating from -8px to zero over 220ms with `cubic-bezier(0.33, 1, 0.68, 1)`. Reduced motion keeps the 120ms fade but removes translation. Collapsing has no content exit animation: the expanded body unmounts on the next render while collapse-persistent messages take its place, and only the chevron continues its independent rotation.
- The completed historical toggle is intentionally different from the active running divider, which is non-interactive.
- Search is modeled as explicit content units, not generic DOM scraping.
- Only user-message and assistant-message content participates in `Find in thread` searchable units.
- `Find in thread` stays hidden until explicitly requested, normally through `⌘/Ctrl+F` while the Threads stage is focused.
- Searchable units use stable keys scoped to the turn, drive match highlighting on the owning user or assistant block, and let search results target collapsed or virtualized turns through `scrollToTurn(..., { expand: true })`.

## Viewport, History, and Navigation

- Long Chats virtualize complete turns while preserving each mounted turn's natural height. Estimated height is scroll math only; it never clips or constrains rendered transcript content.
- The viewport is bottom-distance-native. Following the latest turn stays at distance zero, older content extends away from that anchor, and all rail, Find, restore, catch-up, and measured-height compensation paths use the same scroll controller rather than maintaining independent scroll modes.
- Initial resume loads the five most recent complete turns plus older-page metadata. Older history comes from the app-server turns API, not local slicing. Descending server pages are reversed into Nodex's oldest-to-newest timeline; live/latest turns win identity conflicts, and older pages prepend only missing complete turns or upgrade their recorded placeholder.
- After the first resumed page is visible, remaining history may load in the background. Approaching the loaded-history boundary triggers the same guarded loader. Concurrent demand and background loads deduplicate, and prepending older turns preserves the user's measured visible anchor.
- Renderer-session memory restores one Chat's positive distance from bottom, measured virtual window, and latest-turn-follow state after a body remount. This is presentation memory, not SQLite or transcript authority.
- The user-message navigation rail is derived from visible canonical user-message occurrences. Stable occurrence keys include empty-text and attachment-only messages, while text search continues to index only non-empty content.
- The rail appears only when the thread shell has enough physical room. Activating a row reveals a collapsed or virtualized target before scrolling to its message surface; click navigation is smooth and pointer scrubbing is immediate.
- Find reveal is cancellable and two-phase: it first expands/mounts the target, then owns highlighting and final centering. Selecting another result aborts the earlier reveal so delayed long-history work cannot steal focus.
- Latest-turn follow, response spacing, submit placement, and the catch-up affordance share one footer/viewport contract. Reduced motion snaps the presentation without changing follow state.
- Embedded Side chats reuse the connected conversation stage but omit the root header and floating summary, retain their own composer, and cannot recursively create or fork another Side chat.

## Message Rendering

- Assistant, plan, and reasoning content render through Streamdown with official code, Mermaid, math, and CJK plugins.
- Streamdown fenced code blocks in thread markdown use the same resting visual surface as the BlockNote-backed NFM editor code block: one subdued `--code-block-bg` surface, no nested Streamdown header/body card, no line numbers, and a copy action that appears on code-block hover or when the copy button itself has keyboard focus.
- Thread fenced code copy preserves the original source line breaks and goes through Nodex's clipboard fallback path so Electron permission/API gaps do not make the Streamdown copy affordance inert.
- Transcript markdown rendering remains streaming-safe for in-progress turns.
- Every `imageView` item remains dedicated agent activity. Only raw-consecutive image-view items fold into one row; any intervening raw item, including a hidden review-mode marker, ends the run. Each row is collapsed by default, summarizes as `Viewed an image` / `Viewed N images`, and expands to a horizontally scrollable strip of 80px thumbnails. Thumbnails open one keyboard-accessible preview sequence with previous/next navigation. Review-mode markers (`enteredReviewMode`, `exitedReviewMode`) remain hidden.
- Image-generation output renders as one post-assistant gallery for the turn. Pending output reserves up to four square slots with the animated dot-field placeholder; completed images retain natural ratios when they fit and switch to a four-slot carousel when they overflow. Completed image output is omitted when the turn's end resources contain a presentation, while still-streaming pending output remains visible. Thumbnail and full-image descriptors resolve independently; the full descriptor owns display, download, and drag data. Gallery controls reveal on hover/focus, retry failed preview loads at most twice for each resolved preview URL, support copy-drag payloads, and open a keyboard-navigable image preview with download support. Edit and Canvas behavior is owned by [User Attachment Image Editor Behavior](./user-attachment-image-editor-behavior.md).
- A hook feedback user row is not editable and links to Hooks settings. Feedback matching trims both the displayed user message and each Stop-hook feedback entry, retains every exact source match, and scopes the destination only when all matches normalize to the same source. Managed/system sources normalize to Admin; project links include the turn cwd only when present; plugin links do not guess a plugin id; a blocked hook prompt has no sent timestamp. Ordinary clicks open the in-app settings route, while modified clicks retain normal link behavior.
- Active-thread streaming is revisioned and frame-batched. An established renderer
  owner receives sequenced app-server notifications, reduces the shared canonical
  document, applies the scoped view projection, and commits owner-visible state
  synchronously before its serialized publication outbox sends the next snapshot
  or patch. Prose, command output, patch updates, MCP structural repair, terminal
  interactions, item/turn lifecycle, thread metadata, requests, and errors all pass
  through that owner publication boundary; terminal prose drains before final
  authoritative lifecycle state. Main runs the same canonical reducers for
  no-owner recovery facts, but an active owner's accepted replica advances only
  through an accepted owner publication and main never publishes a competing
  source-null transcript.
- Every accepted replica has a content-addressed checkpoint
  `(protocolVersion, ownerEpoch, revision, canonicalHash)`. Owner publications are
  compare-and-swap transactions against the exact base checkpoint: main verifies
  source ownership, epoch, contiguous revision, patch applicability, and the
  resulting deterministic canonical hash before replacing its accepted document.
  Rejection returns the current accepted checkpoint/snapshot; the owner rebases by
  publishing one next-revision snapshot and acknowledges forwarded notification
  sequences only after publication succeeds.
- A follower first applies an owner snapshot behind a per-client barrier and sends
  an explicit snapshot-applied ACK. Main does not include that follower in delta
  fanout until the ACK matches both the sent and current checkpoint. Later patches
  require the same source owner, owner epoch, exact base revision/hash, next
  revision, and matching post-apply hash. A missing snapshot, owner mismatch, epoch
  mismatch, revision gap, base-hash mismatch, patch failure, checkpoint mismatch,
  or transport reset requests an explicit snapshot resync instead of best-effort
  merging. Replacing an owner increments the epoch, invalidates follower barriers,
  rejects stale publications/ACKs, and requires a fresh snapshot before deltas.
- Owner adoption/resume and follower `thread/resume` carry the same mandatory
  checkpoint and exact shared document as a relayed snapshot. Renderer state
  verifies the returned revision/hash and retains that exact document as the
  publication/patch CAS baseline before deriving the materialized UI snapshot.
  A follower can therefore apply the first post-resume delta, and an owner can
  publish its first optimistic mutation plus any normalization delta, without an
  intermediate baseline mismatch or synthetic epoch.
- Terminal item lifecycle is monotonic for one `(itemId, protocol type)` occurrence:
  delayed starts cannot reopen a completed/failed/interrupted occurrence, while a
  same-ID item of a different protocol type may replace that slot as a new
  occurrence. Owner, main recovery, snapshots, and followers carry the same
  lifecycle sidecar. Renderer turn models are cached by an immutable render
  revision that observes item identity plus lifecycle/content fields, so reasoning
  deltas, patch snapshots, command output, MCP results, and terminal states refresh
  without rebuilding a second tool topology.
- In no-owner fallback, main retains the frame-batched prose and raw command-output
  path and flushes terminal prose synchronously because no renderer animation frame
  owns ordering. Command output remains coalesced for 50 ms, targets the exact
  command item, preserves the latest 20,000 characters with an explicit truncation
  marker, and drops missing conversation/turn/item targets.
- Local file references in transcript markdown are semantic controls rather than ordinary filesystem anchors. A normal click opens the local file in the right-side Files surface as a preview, a double click makes that Files tab durable, and a modified click opens the configured desktop app. References carry line/column/range location into the Files viewer when present; unsupported or failed previews remain an explicit Files fallback with Open externally, while external opener failures fall back to Finder. The reference context menu exposes Open in Files, Open with, Copy path, Copy contents, and Reveal in Finder. In-app route anchors remain owned by their route handlers and are not intercepted globally.
- The Files surface consumes a one-shot reveal location after its text viewer mounts: a start-only reference centers that line, a line range uses Pierre's range scroll and line selection, and an editable viewer additionally applies the zero-based character selection when column bounds exist. Invalid or reversed ranges are discarded at the tab-state boundary. The Files header `Open`, unsupported/oversized fallback action, and explicit `Open with` choices all use the configured external opener router; a failed opener may fall back to Finder, but no React click event is ever passed as an opener id.
- Reasoning follows summary-first canonical projection: only the reasoning `summary` is retained in the transcript item, empty summaries produce no reasoning item, and raw `content` remains non-transcript state. The live activity renderer may keep that summary hidden from ordinary activity leaves while projecting its latest readable line into the turn-level fallback or activity-group header.
- Consecutive replay reasoning records in the same turn are coalesced into one visible reasoning row instead of materializing one `Thought` block per raw reasoning event line.
- Reasoning items remain available in canonical/source state throughout their lifecycle, but the normal live activity leaf policy hides them so they do not duplicate the turn-level live row. Their latest readable summary may feed the separate render-time live activity fallback; the fallback is a turn-body presentation state, not a second reasoning row.
- User transcript bubbles expose hover message actions under the bubble in this order: timestamp, `Copy message`, and optional `Edit message`. Selected-text `Ask in side chat` is not a user-bubble action; it belongs to the thread-level selected-text overlay.
- The selected-text `Ask in side chat` overlay appears only for an active non-empty selection inside selectable transcript text in a main thread. Activating it creates a temporary side conversation and preloads the selected text into that side chat's composer without submitting it.
- User message action timestamps use the turn-level `turnStartedAtMs` field and render as a localized relative calendar label: time only for today, weekday plus time for the previous six calendar days, and month/day plus time for older or future timestamps. Inline/non-primary user messages in a turn render no timestamp node.
- The transcript may render one centered timestamp separator before a turn. Each visible turn contributes a user marker from `turnStartedAtMs` when it has primary user input and an assistant marker from `finalAssistantStartedAtMs` when it has an assistant message. Invalid or missing marker timestamps are ignored.
- A separator appears for the first user turn only after it is more than one hour old. After an assistant marker, a later user marker receives a separator only when the gap is strictly more than one hour; a later assistant marker uses a strictly-more-than-ten-minute gap. At most one separator appears per turn. An unloaded older-history boundary or inherited-parent boundary breaks adjacency and suppresses the first-user rule for the first visible turn, so pagination never invents a conversation start.
- Separator labels use the viewer's locale and local calendar days. Today and Yesterday use relative labels; ages two through seven days use the full weekday; ages eight through 365 days use abbreviated weekday, month, and day; older labels include the year. In Nodex's current English product language, labels older than seven days include `at` before the time. The date portion is emphasized, the complete label is exposed as the separator's accessible name, and the underlying `time` element carries the ISO timestamp.
- `Edit message` only attaches to the last user message of the latest completed editable turn. Later steer or follow-up `userMessage` items in the same turn do not get user-bubble actions.
- Latest-turn editability is derived from the canonical conversation state, not stored as independent UI state: the latest turn must be completed, contain a user message, have no pending request for that turn, and belong to an actionable non-side conversation. Owner-side lifecycle updates recompute this capability so the edit button returns after a turn completes.
- User-sent images and context/file attachments render as a separate right-aligned strip immediately before the owning user bubble. They are derived from non-text `userMessage.content` inputs, not from markdown, so thumbnails are excluded from copy/edit text and from `Find in thread` searchable units. Inline images, trusted-host local images, and remote pointers preserve distinct resolution paths; successful images render as 64px thumbnails and failures expose a recoverable named action. Ingress, source selection, and trust rules are specified in [Composer Image Attachments Behavior](./composer-image-attachments-behavior.md).
- Assistant transcript actions are owned by the turn's bucketized final-assistant lane and render after assistant prose and assistant-after artifacts in this order: `Copy`, `Good response`, `Bad response`, `Fork from this point`, then timestamp. Earlier assistant commentary rows and running agent-body assistant rows do not get transcript message actions. If a stopped turn keeps the latest assistant inline because later tool activity arrived after it, Nodex uses a renderer-local action-only anchor after the settled agent body so the final tool group stays above the toolbar.
- Assistant message action timestamps use the same localized relative calendar label as user timestamps and are sourced from `finalAssistantStartedAtMs`, which is updated from live `agentMessage` event timing and is not treated as the turn completion time. Archived/read fallback data may derive this field from protocol `completedAt` only before live assistant timing exists. If either timestamp field is missing, the timestamp node is omitted.
- Assistant fork targets the owning completed turn. Latest-turn forks execute immediately, while older-turn forks open a confirmation dialog unless the user has opted out. Accepting a destination closes that confirmation synchronously and admits the fork exactly once; retaining the source task or loading the destination cannot keep the confirmation visible. For session-backed threads, forking opens a new project session backed by the forked conversation snapshot and focuses an empty composer in that new session.

## Tool and Activity Rendering

- Tool activity passes through one production classifier and one topology
  projector. Hidden items, including reasoning, do not break adjacency;
  standalone items flush the current run; and every maximal run of groupable
  exec, materialized patch, non-empty web search, ordinary MCP, registered
  groupable dynamic tool, and in-progress Auto-review items first becomes a raw
  group. A settled non-active singleton is then demoted to its standalone family
  row, except a file-change singleton remains grouped when it does not represent
  exactly one ordinary changed file or when it contains visualization activity.
- Group membership is finalized before React leaves render. Each raw group keeps
  immutable full entries for state, facts, identity, and icon selection, plus a
  separately filtered body-entry list for expansion. Running ordinary
  read/search/list rows, defensive empty patches, and summary-only dynamic rows
  may be absent from the body without changing the group's header facts or
  topology. React consumes this presentation and never runs a second grouping
  pass.
- Completed agent-body collapse partitions the projected activity units into
  canonical expanded order, collapsible units, and collapse-persistent units.
  Steering messages with a projected steering status and hook-feedback user
  messages remain visible below the `Worked for` divider while agent activity
  is collapsed. Collapse-persistent user messages use compact horizontal hover
  actions so action chrome does not reserve a second transcript row; consecutive
  bubbles retain the canonical 16px item gap. Expanding restores every unit to
  its original transcript order and ordinary action layout without duplicating
  the persistent messages.
- Tool and action surfaces use the shared local icon asset module:
  - semantic tool glyphs cover command execution, file edits, web/search, code search, list-files, approvals, denials, skills, hooks, plugins, connectors, and generic source fallbacks
  - decorative row glyphs are hidden from assistive technology; website favicons use decorative empty-alt images, while source logos expose meaningful alt text
  - icon rendering is surface-specific, not universal: collapsed activity headers and top-level command/web/MCP surfaces may show glyphs, while nested collapsed-activity body rows often stay text-only
  - visible activity glyphs use the documented `icon-xs` muted contract, chevrons use `icon-2xs`, and source/card glyphs use `icon-sm`
- Standalone top-level web rows prefer extracted site favicons through the Google favicon URL helper and fall back to the semantic web-search glyph when no stable domain is available. Grouped web-search headers use the semantic web-search glyph, while expanded/detail web rows render the favicon only when a `faviconUrl` exists; they do not add a globe fallback when no site favicon was resolved.
- A web-search row is groupable only when its visible query is non-empty after trimming; action-detail payloads such as fallback `queries` do not create a visible row by themselves. Web rows do not pre-group before the generic v2 pass. A live activity group whose open slice is web-search-owned renders `Searching the web` plus the latest active query/detail; a settled group renders `Searched the web`, and expanded bodies render direct detail rows without a nested web-search header.
- Web-search action detail text follows the same display normalization across standalone rows, grouped headers, and grouped detail rows: `search` uses the first query, multi-query searches append `...`, `openPage` uses the URL, `findInPage` uses `'{pattern}' in {url}`, and search queries with removable `site:` filters render as `query text | domain · domain`.
- Web-search detail rows use the shared bounded activity-list behavior owned by their v2 group: preview content caps at 7rem, expanded content caps at 20rem, and collapsed shells keep `0px` height without row content.
- MCP, plugin, connector, and elicitation rows resolve source logos from available metadata, Browser Use / computer-use source identifiers, connector/plugin logo URLs, then the generic source fallback.
- Completed MCP server elicitation is an agent-activity leaf, not a trailing raw-payload row. `mcpToolCall` completion summarizes as `Requested permission`; other supported kinds use `Completed request`. The default-collapsed body preserves one question/answer pair, with answers `Accepted`, `Cancelled`, `Declined`, or `Completed`; tool suggestions use their suggestion reason as the question. Incomplete and unsupported OpenAI-form elicitations do not render this completed leaf, while an OpenAI form containing an `openai/imagePicker` property remains eligible for ordinary v2 grouping.
- Connector logos choose light or dark logo URLs from the current theme and fall back to the generic source glyph after an image load error without changing row geometry.
- Ordinary MCP rows and registered groupable dynamic-tool rows enter the same mixed v2 run as commands, edits, and web searches; there is no production pending-MCP or dynamic-family disclosure pass. `computer-use`, renderable MCP app/resource rows, and registry-declared standalone dynamic tools are standalone barriers. MCP source identity and dynamic registry metadata still drive labels, icons, summary facts, completed-part dedupe, specialized leaf rendering, and summary-only body omission after group membership is fixed.
- Every visible dynamic-tool row stays compact by default and exposes a separate `Details` disclosure without wrapping or replacing the row's existing interaction. Expanded details show qualified namespace/tool identity, status and duration, formatted arguments, every text/image output item, and a `Raw` dialog backed by the exact canonical app-server item; synthetic fixtures fall back to a complete reconstructed protocol shape. Registered specialized renderers may replace the compact row, but a renderer that cannot display a known tool falls back to the same inspectable row instead of hiding it. The intentionally hidden workspace-dependency bootstrap remains outside the transcript.
- `nodex_app` rows use intent-aware compact labels rather than identifier-humanization. Revision 3 search shows target, phrase, and result count; fetch shows the resolved title/format; saved-View and advanced Database queries show the source and row count; Card creation shows titles/count/destination; updates show their semantic effects; moves show the destination; duplication shows the new Card identity. Nested Markdown inserts, exact patches, and replacements render bounded inline changes while details are collapsed; exact patches show real removed/added lines without inventing unavailable prior context. Expansion shows the larger preview plus exact Arguments and output, while Raw preserves the canonical app-server item. Historical revision 2 names and `nfm` payloads remain readable through a dual-read projector but are never emitted for v3.
- Successful `codex_app.create_thread` dynamic tool rows render a compact created-task card whose `Open task` action opens the created thread's project session through the workbench session navigation path; worktree-created tasks keep the pending setup fallback until the worktree setup route exists.
- Registered dynamic tool renderers own known-tool transcript rows. Nodex content tools, Codex app thread controls, settings read/write tools, Chrome tab-context reads, and handoff operations all enter through the same registry render gateway before fallback. `read_thread` and `send_message_to_thread` rows become thread-navigation buttons only in row mode with a valid `threadId`; completed successful `create_thread` rows become the created-chat card; `handoff_thread` rows use a status activity with compact operation steps when the result exposes them. Invalid known-tool arguments return to the compact fallback row rather than disappearing.
- MCP tool rows resolve app resources from tool metadata, result metadata, item-level `appContext.resourceUri`, and legacy item-level `mcpAppResourceUri`, then render supported `text/html`, `text/html;profile=mcp-app`, and `text/html+skybridge` resources in a Main-authorized isolated webview. DIL resources fall back to an accompanying HTML resource while DIL rendering is disabled; DIL-only or unsupported resources fall back to text, structured JSON, error, or no-content branches. Renderable app resources expose a transient right-panel tab using `mcp-app:${mcpAppId}` and a capability identity that includes thread, server, tool, call, and resource URI.
- One renderable MCP capability owns one live runtime across inline, right-panel, and fullscreen presentation. Moving between those surfaces reparents the same guest and preserves widget state; the runtime is disposed after a bounded no-surface grace. Loading, guest failure, and retry are explicit states, and retry creates a fresh sandbox claim/runtime generation.
- MCP App host calls remain scoped to the original thread and server. Declared tools/resources are available through the fixed proxy, unknown methods and subscriptions fail explicitly, external links require HTTPS, and widget follow-up messages re-enter the original thread action with bounded JSON context appended to the prompt. Display-mode and intrinsic-height requests affect presentation only and cannot broaden the sandbox.
- MCP fallback content blocks render normalized `text`, `image`, `audio`, `resource_link`, `embedded_resource`, and `unknown` blocks directly inside the expanded body. Visible annotation text is intentionally restricted to `audience`, `priority`, and `lastModified`; arbitrary annotation keys remain internal and are not displayed in the transcript.
- The app-server `read_thread` dynamic tool returns `schemaVersion: 1`, thread metadata, newest-first paged turns, and optional truncated outputs as a successful `inputText` JSON result.
- Transient tool labels use Nodex's `CodexShimmerText` wrapper. Inactive labels render plain text. Active labels default to the cadenced treatment: after a 600 ms delay, two clipped transform sweeps run once for 1,000 ms with `steps(48,end)`, then remain still until the next four-second cadence. Classic two-second `background-position` shimmer is an explicit variant reserved for the active Browser and background-Subagent working labels that require it. Both treatments become static for operating-system reduced motion, and an activity body can disable shimmer for its entire subtree.
- Group headers have exactly three presentation states. `summary` is static and
  transitions immediately; `active` uses the selected tool's family label and
  icon with shimmer; `thinking` has no tool icon and shimmers the assigned
  reasoning heading or generic `Thinking`. Expanded activity-group bodies
  disable shimmer for nested command, web, MCP, patch, and Subagent labels, so
  one active group has at most its header sweep. Running counts cannot make a
  completed group summary shimmer.
- Completed group headers retain ordered typed parts until rendering instead of
  flattening facts into a projection-owned sentence. Part order is named MCP
  sources, loaded tools, unnamed MCP calls, file changes, stopped file creation,
  exploration, visualization, commands, web search, then deduplicated dynamic
  calls. Node REPL contributes to commands; recognized web curl and visualization
  commands are removed from ordinary command counts. Reasoning contributes no
  completed part, and an empty part list renders `Worked`.
- Collapsed web-search summary facts count every renderable web-search row in `webSearchCount`, with `runningWebSearchCount` as a subset rather than a replacement for completed rows. The visible summary remains count-free: any running web-search renders `Searching the web` / `searching the web`; otherwise it renders `Searched the web` / `searched the web`. While the current still-open activity slice ends in web-search activity, the display stats treat that trailing activity as running so the header stays in the active `Searching the web` state until later turn content closes the slice.
- Collapsed command summary stats preserve Codex's special exec categories: running `mkdir` commands can summarize as `Creating folder`, and successful or still-running readonly remote `curl` commands can summarize as `Searched the web` / `Searching the web` instead of generic command counts. Mutating curl requests, local curl requests, failed completed curl requests, and mixed running command sets stay generic. Command-row-only labels such as `date` and background terminal state are not collapsed activity summary facts; Node REPL is an MCP source summary special.
- Collapsed approval failure summaries count only denied and timed-out automatic approval reviews, deduped by canonical review id across standalone and attached review paths before formatting `Denied request(s)` or `Request(s) timed out`. Attached review failures fold through the same fact path for file-change, command/exploration, and MCP tool rows.
- Collapsed MCP summary stats preserve a source-keyed map with source key/name/logo/native-app metadata plus total and running counts. Same-source calls fold into one source entry; built-in Browser Use and computer-use source kinds take precedence over incidental raw source keys, raw non-integration keys are preserved when no built-in source kind applies, and computer-use target app fields preserve native-app identity. Browser-use displays as `the browser`; `server:node_repl` formats as command activity; app/native/browser source metadata can drive both summary wording and collapsed-header icon fallback. The same source resolver determines ordinary group summary facts and standalone MCP app/computer-use presentation without creating a source-specific pre-group.
- Header icon ownership follows header state: a completed summary uses evidence
  from its first typed part, an active header uses the selected active item, and a
  thinking header renders no tool icon. Filtering expanded body rows cannot
  change that choice.
- Standalone automatic approval review items render as an activity disclosure whose header summarizes the reviewed action, such as `pnpm test`, `Editing src/app.ts`, `Network access to api.openai.com`, `MCP search on Docs`, or `Permission request: reason`. The header shows the muted shield accessory and shimmers only while the review item is in progress. Expanding that activity reveals the same compact review row used by attached tool-body reviews.
- Compact automatic approval review rows render only the review status title. High-risk denials fold into `Auto-review denied high risk`, and the row does not render separate status chips, risk labels, or an `Automatic approval review` noun label. Expandable rows reveal the trimmed rationale or Codex fallback reviewer-agent summary; non-expandable rows render title text only.
- Each multi-agent action item is one standalone v2 activity unit and therefore acts as a barrier between mixed groupable runs; consecutive source items are not coalesced by action before v2 grouping. A single source item may still expose multiple receiver rows. `wait`-only collab tool calls stay out of the mounted transcript. The leaf status priority is `inProgress`, then `failed`, then `completed`; other terminal transcript states collapse to `completed`. Headers show the compact subagent glyph and action-specific grammar such as `Creating`, `Created`, `Failed to create`, `Messaging`, `Messaged`, `Closing`, and `Closed`, followed by `an agent` or `# agents` from that item's visible target set. Visible row targets come only from receiver thread metadata, agent state keys, or parent child-membership metadata for the same thread id; sparse receiver id lists still feed background membership/reference state, but without receiver metadata, child membership metadata, or state they render a generic activity row and do not create a clickable child-thread row. Expanded rows expose per-agent activity, inline truncated prompt text for created-agent instructions and sent messages, and separate `Input:` metadata rows for other prompted actions while preserving multiline prompt text. Agent names are inline buttons when thread navigation is available, and open the corresponding child agent thread through the standard thread navigation action.
- Background child-agent rows resolve their display name from the explicit membership display name, latest receiver thread display metadata (`displayName`, `name`, or `nickname`/`agentNickname`, including `source.subAgent/subagent.thread_spawn.agent_nickname` fallback), membership thread display metadata, child agent nickname, then child thread id. Exactly one leading `@` is stripped from the resolved display name. Actor labels, thread previews, and internal `agentPath` values are not agent display-name fallbacks; inline subagent activity without a display name uses `Agent`. Agent roles resolve from latest receiver thread role, membership thread role, then child agent role; blank and `default` roles are hidden.
- Raw-consecutive subagent activity items form one compact inline group. Each group keeps the first-seen agent order and the latest event for each agent. Group wording prioritizes interrupted, then updated, then all-done, and a child is shown as done only when its background-agent state belongs to this turn and no later raw activity exists for that child; state from another parent turn cannot keep the row active. Anchored raw groups take precedence for turn state. If none exist, same-parent background rows with inline activity enabled may contribute null-anchor `hasActivity` / `hasActiveActivity` state for commentary ownership and collapse defaults, but that auxiliary state never creates a transcript node or DOM anchor.
- Background child-agent composer UI uses the section title `Subagents`. Collapsed counts render as `# background agent` / `# background agents`; expanded summaries append `(@ to tag agents)`. Composer child rows append `is working`, `is awaiting instruction`, or `is done` according to the row status. Thread Summary presentation is owned by [Thread Summary Panel Behavior](thread-summary-panel-behavior.md).
- A child agent with `needs_resume` counts as in progress only when its preserved runtime status is active. Catalog/sidebar status alone does not keep a resumed child row active.
- Opening a child agent creates a transient right-panel `background-agent:<threadId>` tab with the child display name, a static theme-aware avatar, and the normal tab close chrome. The avatar hashes the stable seed from zero with `(hash * 31 + charCode) % 2147483647`, selects one of ten image pairs, and changes only when the resolved light/dark theme changes; active, waiting, and completed status never animate or replace that identity. These tabs are not durable project-session tabs.
- Context compaction renders as a dedicated compact divider row instead of a generic system banner:
  - in progress: `Automatically compacting context` with Codex shimmer text
  - completed: `Context automatically compacted` with the compact completion icon
- Session-backed reopen/bootstrap preserves the same context-compaction rows, including compaction boundaries that split replayed history across pre-compaction and post-compaction turns.
  - the row stays in the post-assistant transcript lane rather than the grouped agent-body lane
- Poor-network retry errors render inside the mounted transcript as inline error rows instead of replacing the whole thread shell:
  - retryable error notifications materialize canonical `streamError` rows, for example `Reconnecting... 2/5`
  - non-retryable error notifications materialize canonical `systemError` rows
  - protocol `Turn.error` remains turn metadata and does not synthesize a second transcript row; a visible row exists only when the canonical raw error item was observed
  - both rows may carry expandable `additionalDetails`
  - this feature is distinct from explicit thread reopen/resume; `resumeState` does not own the poor-network reconnect row
- Transcript expanders use Motion and subtype-owned state, not a generic shared accordion:
  - measured transcript bodies (`commandExecution`, generic agent-activity groups, `patch`, MCP, reasoning, completed request-user-input answers, plan/todo disclosure, and other transcript expandable rows) animate through explicit `motion.div` height/opacity wrappers fed by a `ResizeObserver`-driven measured-height hook
  - agent-body collapse is a separate presence animation contract and does not reuse the measured-height transcript-body model
- `fileChange` and turn-level unified diff are separate surfaces:
  - raw `fileChange` lifecycle stays canonical, while semantic visibility is
    derived separately: ordinary patches enter tool activity only after at least
    one real change or visualization activity materializes
  - every active Nodex thread-start/fork path uses the shared required capability profile, including `features.apply_patch_streaming_events=true` and `features.thread_tools=true`; this covers ordinary start/resume, heartbeat resume, cron start, side-chat fork, persistent fork, and imported rollout fork. The title-only system start helper is intentionally read-only and does not own an active transcript turn
  - without `features.apply_patch_streaming_events=true`, app-server withholds the drafting-time `item/fileChange/patchUpdated` notifications and only the final completed file-change row can render; Nodex must surface that as a capability/diagnostic distinction rather than a silent static thread
  - live `item/fileChange/patchUpdated` notifications own the canonical
    in-progress patch snapshot, may arrive before `item/started`, may rebind the
    latest active turn to the notification `turnId`, and keep the same protocol
    item identity when materialized activity first appears
  - an ordinary in-progress `fileChange` with no changes and no visualization
    activity is semantically hidden: it creates neither an empty `Editing files`
    group nor a fabricated path. During that pre-materialization interval, the
    parent reasoning/`Thinking` fallback remains eligible. Once a real change
    arrives, the same item begins showing the active patch header, paths, stats,
    and inline diff
  - when a renderer owner exists, both main recovery state and the owner consume
    the shared canonical patch reducer, but only the owner publishes the accepted
    revisioned conversation change. Main's accepted replica advances only after
    that publication; followers receive the same materialized snapshot or patch
  - the live file-edit process row is source-backed as `response.custom_tool_call_input.delta` -> app-server patch parser -> `item/fileChange/patchUpdated`, not as a renderer-only animation layered over the completed row
  - `item/fileChange/outputDelta` burst bytes are deprecated diagnostic output for this surface and do not create or update visible transcript state
  - live `turn/diff/updated` notifications update `turn.diff` for turn-level diff surfaces only; they do not fabricate `fileChange` rows
  - completed turn-level `turn.diff` is canonical when it comes from app-server turn diff state; renderer code and `thread/read` rebuilds must not replace an existing non-empty turn diff by concatenating `fileChange` patches
  - when app-server/read-model turn diff is missing or empty, main synthesizes the visible completed `turn-diff` card from completed `fileChange` patch batches using path-aware hunk folding, so repeated updates to the same file render as one folded file section
  - binary, oversized, invalid-text, and unsupported `fileChange` payloads are classified at the shared boundary before patch-row or turn-diff synthesis; they keep path/action/safety metadata but do not keep decoded binary body text and do not contribute textual hunks to the aggregated turn diff
  - a completed `turn-diff` transcript item may retain empty textual `unifiedDiff` metadata for Review/recovery, but the transcript/fixed surface is created only when the resolved unified diff contains actual additions or deletions
  - raw `fileChange` items and their `patchBatches` remain process/provenance data for the underlying `Edited …` rows and undo/reapply; they can provide the fallback display diff only when no available completed turn-level diff exists
  - projectless sessions scope turn-level diff payloads to `projectlessOutputDirectory` using normalized root-boundary path matching; mixed diffs retain only output-directory files, patch-batch-only payloads are synthesized through the same canonical file-change builder, and a payload with no in-scope textual or safe file changes renders no diff card or fixed banner
  - projectless activity summaries remain independent of the Review capability: `Edited files, read files` continues to summarize the conversation's activity, while the turn-level diff card is adaptive and may open a session-owned Review surface only when an in-scope diff survives
  - Review is session-scoped rather than project-required: a projectless conversation with an attached thread and a valid turn/diff target may open Review, including non-Git sessions. The Review panel queries real repository metadata when available instead of assuming `isGitRepository=true`; Git-only actions remain disabled when metadata says the target is not a repository
  - every Review affordance resolves its target/callback before rendering. If there is no valid turn id, in-scope diff, session target, or opener route, the trailing component is omitted; live `fileChange` activity and `Edited files, read files` never depend on the Review callback
  - when completed turn-end resources already cover every in-scope turn-diff path, the dedicated turn-diff card is suppressed to avoid duplicating the linked output resource; partial coverage keeps the real turn diff visible
  - completed turn-level aggregated `turn.diff` renders as final-assistant after-content when a final assistant exists, so the edited-files card appears before the assistant action strip inside the final assistant DOM; commentary-only turns keep commentary in activity and render the diff once after it
  - only the latest visible in-progress turn may surface todo progress and an aggregate diff through the static above-composer portal (`data-above-composer-portal`); todo precedes diff in one pill, while live `fileChange` rows remain visible in the transcript/tool activity stream
  - when todo progress, changed-file summary text, or diff stats appear or grow after the pill mounts, the shared pill expands to its intrinsic content width up to the available thread width; narrow surfaces truncate the changed-file label without allowing it to overlap the non-shrinking todo progress
  - a blocking approval/input/MCP/permission request hides active todo/diff fixed content without moving either into the transcript; resolving the request restores eligible fixed content, completing the turn removes todo, and moves a real diff to its completed owner
  - empty todo, header-only/invalid diff, blocked state, and non-latest turns mount neither fixed chrome nor the `h-8` spacer; primary and queue portal hosts resolve by conversation identity and fail closed instead of routing into another thread's footer
  - renderer projection must not treat a live `fileChange` row as a replacement for active `turn.diff`; the turn-level aggregate diff pill and the per-item patch row are separate app-server surfaces and can coexist during the same streaming edit
  - the above-composer diff banner is active-turn-owned `in progress` fixed content, not an item-status heuristic: it renders as the summary-only `Review changes` banner with no embedded per-file rows
  - completed turn diffs render as a dedicated `Edited …` card with per-file collapsed embedded diff rows
  - the unified diff card is never allowed to replace or swallow the underlying `Edited file` tool row
  - patch rows expand inline to reveal their own unified diff frame instead of delegating expansion to the separate turn-level diff card
  - file-change collapsed activity summaries count unique display paths per kind; repeated edits to the same file render as `Edited a file`, while changed-line suffixes may still aggregate all repeated patch rows
  - active collapsed-activity patch summaries and in-progress turn-diff banners animate `+N` / `-N` through the CSS digit-wheel contract; per-file patch row headers use the static `+N` / `-N` diff chip
  - per-file patch rows own local click-to-expand state; pending rows omit the action verb in the short header, streaming rows shimmer only the action verb, and completed expanded rows replace the short verb/path header with `Created file`, `Deleted file`, or `Edited file` while moving path and stats into the diff frame
  - patch rows with attached Auto-review lifecycle show a compact shield indicator in the row header; when expanded, compact `Auto-review...` rows render before the diff frame and expand locally to show the review rationale or fallback detail
  - patch row stats, expanded diff-frame stats, copy text, changed-line aggregation, and file-open line derive from the same canonical unified diff built from the path-keyed file change; body parsing only decides inline diff rendering versus semantic fallback
  - non-renderable patch rows display a product placeholder such as `Binary file changed` or `File too large to display`; they are never sent into `@pierre/diffs`, copied as binary text, or indexed as body content
  - file approval request previews derive rows and stats from the same path-keyed file-change patch model as the in-thread patch rows; the request only attaches approval metadata to the existing `fileChange` item and does not own a second array/index-based diff model
  - collapsed non-streaming patch rows do not keep their diff/review subtree mounted; the body mounts only while the row is expanded
  - inline diff previews render the real `@pierre/diffs` `diffs-container` host directly, not a nested wrapper, and rely on the diff library's native line highlighting/indicators instead of adding a second left-side gutter overlay
  - patch headers split the status label and filename into separate elements; the filename is clickable and opens the local file target without toggling the row. The ordinary path click uses the shared Files preview router, modified clicks use the configured desktop opener, and the unified-diff-derived line is forwarded for reveal
  - embedded per-file patch previews suppress the diff library's built-in file header because the surrounding thread row already owns the filename and line-count summary
- Expanded agent-activity bodies are flat: exploration leaves render direct text-only `Read`, `Searched`, and `Listed files` rows through their body-only path, web-search leaves render direct detail rows with a favicon only when one was resolved, file-change rows render `Edited`/`Created`/`Deleted` with filename/stats/chevron but no pencil glyph, and nested command rows render muted without the leading command icon. They do not mount nested `Explored...` or `Searched web...` subgroup headers.
- Tool-call expansion is subtype-owned local UI state; the mounted thread persists collapsed turns, not collapsed tool rows.
- Tool-call header labels use a scan-friendly two-tone hierarchy where the leading action phrase is visually emphasized over trailing detail text.
- Command execution cards consume parsed `commandActions` metadata (`read`, `listFiles`, `search`) before falling back to generic shell rendering. A single parsed read/search/list action renders as a compact transcript row instead of an expandable shell card; when such a compact row has attached Auto-review lifecycle, it becomes a compact activity disclosure whose body contains the Auto-review rows. Exploration groups retain attached command Auto-review rows for collapsed-summary failure folding instead of treating those reviews as separate activity rows.
- In-progress parsed read/search/list rows stay hidden until completion, except skill-definition reads in `STEPS_PROSE`, which render as `Reading <skill> skill`.
- Completed skill-definition reads render as `Read <skill> skill` instead of ordinary file reads.
- Parsed read/search/list actions remain facts and direct detail rows within their source command call. They do not create an exploration pre-group; the generic v2 group preserves each source-call wrapper even when one command exposes multiple actions.
- In mounted threads, generic command cards use a local `collapsed | expanded` state machine owned by the command card itself.
- The global thread-detail setting controls command-card visibility and the settled default state:
  - `STEPS_PROSE` suppresses command execution cards except skill-definition read rows
  - `STEPS_COMMANDS` shows command cards and keeps generic shell rows collapsed by default
  - `STEPS_EXECUTION` shows command cards without auto-opening generic shell rows
- Running generic command rows start collapsed and stay under manual disclosure control while running and after settlement.
- Command shell rows keep a stable `exec-shell-body` wrapper with collapsed search skipping, but mount shell/review content only while expanded.
- Command rows with attached Auto-review lifecycle show a compact shield indicator in the header. Expanded command shell rows render attached Auto-review rows before the `Shell` chrome. The shell chrome includes the command line, copy-command/output controls, and a reversed scroll output area capped at 140px. Blank running output stays empty; blank settled output reads `No output`. The footer is blank while running, then reads `Stopped`, `Success`, `Exit code {code}`, or `Exit code unknown` from canonical command status and exit-code fields.
- MCP rows with attached Auto-review lifecycle show the same compact shield indicator in the header and render attached Auto-review rows before MCP app/resource/content/error/raw-output body content. Normal expanded MCP bodies keep attached review rows expandable so their rationale can be inspected; MCP app/resource card bodies render those attached review rows as title-only, non-expandable compact rows with card-body horizontal padding before the app/loading/error surface.
- Generic command headers use command-row-specific semantic labels. Active foreground commands render `Running command` with only the status phrase shimmering and may append an elapsed timer. Collapsed settled commands render `Ran <command>` or `Stopped <command>`, while expanded settled commands fall back to `Ran command` or `Stopped command` and expose the exact command through the shell body. Current-date commands render `Checking` / `Checked` / `Stopped checking the current date and time`. Background terminal rows render `Started background terminal...`, `Background terminal finished...`, or `Background terminal stopped...`; skill scripts under a skill `scripts/` folder render as `script <file> from <skill> skill` in the command-specific forms.
- While the current turn is still active, a trailing activity slice owned by exploration remains visually `in progress` (`Exploring` shimmer) until a non-exploration item appears in that same turn or the turn stops.
- Generic agent-activity groups use one local four-phase disclosure
  (`collapsed`, `opening`, `expanded`, `closing`) and one measured body. The same
  header node is rendered collapsed and expanded; expansion only adds filtered
  tool rows. The body remains mounted through transition phases, receives pointer
  events only when fully expanded, and never gains a separate preview topology.
- Completed proposed-plan cards render as a 200px in-thread preview with `Plan` header actions for download, copy, rating feedback, and opening the right-panel `Plan` tab. The in-thread card does not own a local accordion.
- While the right-panel `Plan` tab is active for the same plan key, the card body remains mounted but collapses to `max-height: 0`, `opacity: 0`, `aria-hidden`, and `inert`; clicking the full-card close overlay removes that renderer-local tab. The right-panel tab renders the full markdown in its own scroll container.
- In-progress proposed-plan cards keep the `Writing plan` header and preview body, suppress the fallback `Thinking` activity row, and do not expose the side-panel open action until the plan item completes.
- Generic activity groups are steady-state collapsed. The latest open group may
  receive an initial-collapse entrance signal, but streaming state does not
  auto-expand it and reduced motion suppresses the nonessential transition.
- Running group headers are selected from full tool facts: exploration may own
  `Exploring`, otherwise the newest strict-active ordinary tool owns its concrete
  label, and an open group with no strict-active tool enters `thinking`.
  Completed groups render the typed static aggregate. Standalone family leaves
  keep their own tool-only labels.
- Command execution headers show `in <cwd>` only when the command ran outside the active project workspace path.
- Patch rows own their expand/collapse state per file row. MCP tool calls own a local toggle once the call is completed or has a result. Neither surface uses a conversation-level collapsed-tool map.
- MCP tool-call rows follow the normalized-result and MCP-app state machine instead of renderer-local raw fallbacks:
  - collapsed rows keep the expanded body unmounted; completed and result-bearing rows mount the body only after the disclosure opens
  - an active MCP app/resource branch replaces normal content/error/no-content rendering, shows a fixed-height loading placeholder while the resource read is pending, and hides structured JSON when the app came from tool/result metadata scope
  - non-app fallback branch order is `success.content.length > 0` -> protocol error -> structured JSON only -> `Tool returned no content`
  - a single JSON text block without annotations is deduplicated against matching `structuredContent` and displayed as one JSON panel
  - malformed MCP content blocks render as visible JSON fallback blocks instead of disappearing
  - the raw-output dialog remains a separate expanded-only debug view and uses the protocol call payload, not renderer-only app/source fields
  - in-progress rows stay collapsed until a result exists, and same-server incomplete MCP elicitation suppresses only the matching in-progress MCP row from `agentItems`
- Patch-row expansion uses a per-file Motion-based measured-height animation model. Expanded rows keep their body height on continuously measured pixel values instead of switching back to `height: auto`, so inline diff expansion does not hand layout authority back to the scroll container mid-transition.

## Composer Shell

- The composer shell is owned outside the transcript scroll container and sits above the input editor.
- It owns queued follow-ups, background terminal rows, background child-agent rows, and unresolved live request cards. Pending steering messages belong to the transcript as `steeringUserMessage` items, not to the composer shell.
- Background terminal rows and queued follow-up rows remain visible as stacked shell sections above the request/editor branch.
- The queued-follow-up section is a compact ordered tray. Interruption-paused state adds the exact pause header and queue-only `Resume`; failed rows add a warning and `Retry`; in-flight rows remain visible and disable edit, delete, and reorder. Rows summarize rich or attachment-only payloads, expose `Steer`, delete, `Edit message`, optional `Open in side chat`, and the queueing preference action, and keep accessible action names independent from icon-only presentation.
- Stopping background terminals is owner-local under multi-window streaming: followers reject the action with the owner-window message, while the owner calls app-server `thread/backgroundTerminals/clean`, clears the local running-terminal rows, and does not publish an ordinary transcript/request stream patch.
- Background child-agent rows are shown only when the shell is not in approval mode.
- When a background child approval exists, its request card renders before the active-thread request card.
- Background child approvals do not add a separate worker-name header above the card; when the approval prompt needs an actor, that child identity is injected inline into the approval prompt itself.
- While request cards are present, the normal freeform composer editor is hidden.
- The active parent `implementPlan` request is the sole exception for composer controls: it renders the shared intelligence selector as a sibling footer below the request stack, without attachment, permission, context-window, dictation, or send controls. Auto-review replacement and non-plan parent requests suppress that footer.
- Request cards use one dispatcher family:
  - `approval` uses the ask-for-permission shell with inline command/network/patch preview, option rows, freeform decline guidance, `Skip`, and `Submit`
  - command approval previews derive command text from the same command approval projection order used by command rows: command-action commands first, then the request command, then shell-escaped execpolicy amendment fallback; managed network approval previews render the network allowlist reason as their body and do not require or show a shell command preview
  - `userInput` and `implementPlan` use the same shared questionnaire shell with `Dismiss` and keyboard-first multi-question navigation
  - `permissionRequest` uses the shared request shell with normalized permission details instead of raw JSON: network access renders as `Network / Internet access`, filesystem entries render as `Read`, `Write`, or `Read and write` path groups, `Skip` denies for the turn, `Yes, allow for this turn` grants turn-scoped access, and non-prose detail levels also offer `Yes, allow for this session`
  - `mcpServerElicitation` uses the dedicated MCP card family instead of a generic JSON approval card; URL elicitations open the provided URL on accept, while `form` and `openai/form` elicitations render supported schema fields as inputs, send `decline` on `Skip`, send `cancel` on close/Escape, and send `accept` with structured form content on `Continue`
- Live `approval`, unanswered `userInput`, synthesized `implementPlan`, and live MCP elicitation requests do not render inline in the transcript scroll area.

## Persistence and Recovery

- Snapshot requests never invoke `thread/read` or `thread/resume`. They serialize and rebroadcast the current manager-owned canonical conversation; when no loaded record exists, that serialization boundary may first bootstrap the manager from a persisted Codex session artifact.
- Every explicit renderer bootstrap boundary—snapshot request, resume, older/complete history, side-chat start, follower snapshot, and rollback—materializes the canonical whole turn before applying the conversation snapshot. This keeps params-first user rows, raw-echo suppression, request/review overlays, hook feedback, generated images, and hidden item identity identical to live projection. Generic snapshot application does not perform an implicit second projection.
- Reopened threads first use the manager's canonical record or its bootstrap-only persisted-session recovery input. Explicit history reads and paged resume responses then materialize generated whole turns exactly once; the renderer does not replay or re-normalize those projected rows.
- Explicit active-thread resume uses paged `thread/resume`, falling back to a full `thread/read` only when the resume response omits its initial turns page. When a renderer initiates resume, it materializes the returned canonical snapshot, establishes its owner cursor, releases buffered same-thread notifications, and then publishes the latest hydrated owner snapshot. If resume fails, the buffer is released and the initiating renderer returns its local conversation to `needs_resume` without registering a stale owner or applying a source-null recovery snapshot.
- Restart recovery depends on the host manager's canonical conversation state, bootstrap-only persisted-session input, and explicit resume/history paths—not on a second renderer-side transcript authority.
- Live and restarted threads must show the same visible conversation history for the same underlying session state.

## Non-Goals

- Nodex does not expose internal bootstrap/session context as a developer-visible transcript row in this release.
- Nodex does not treat raw rollout storage as a direct UI contract.
- Browser/HTTP transport does not support `codex:*` methods in this release.
