# Codex Thread Turn Ordering And Assistant Promotion

## Intent

This document is the detailed source of truth for one narrow but high-risk part of local-thread rendering:

- how one turn's ordered item stream is classified into semantic render lanes
- when the latest assistant message gets a dedicated final-assistant slot
- when that same latest assistant must stay inline inside the agent body
- how `worked-for`, search ownership, placeholder state, and collapse behavior depend on that classifier

This doc exists because the most common regression here is subtle but visible: Nodex starts from the right transcript items, then over-promotes the assistant or ties search/placeholder logic to the wrong lane.

## Authoritative Model

The authoritative rendering model is:

- the real turn classifier is imported, not a local "latest assistant wins" helper
- `assistantItem` is conditional, not guaranteed
- visible order is semantic-slot order after classification, not strict raw-array order
- "latest assistant message" and "dedicated final assistant slot" are related but different concepts

The corresponding Nodex implementation lives in:

- `src/renderer/features/local-conversation/projection/build-renderer-item-stream.ts`
- `src/renderer/features/local-conversation/projection/build-turn-render-model.ts`
- `src/renderer/features/local-conversation/projection/bucketize-turn-items.ts`
- `src/renderer/features/local-conversation/projection/build-turn-view-model.ts`
- `src/renderer/features/local-conversation/projection/agent-activity-v2.ts`
- `src/renderer/features/local-conversation/projection/agent-activity-group.ts`
- `src/renderer/features/local-conversation/view/local-conversation-thread-turn.tsx`

## Canonical Turn Pipeline In Nodex

### 1. Build one ordered renderer item stream

`buildRendererItemStream(...)` starts from the canonical ordered `turn.items` array and converts it into renderer-facing transcript/request items.

Important rules:

- it preserves the canonical per-turn item order from the conversation snapshot
- it maps raw semantic kinds into renderer block families
- it projects visible transcript blocks and auxiliary subagent activity state from the same canonical turn input
- pending request cards still stay as dedicated request items instead of becoming ordinary transcript rows

`buildTurnRenderModel(...)` then derives and inserts the internal `workedFor` block before bucketization so the downstream classifier sees the required blocking signal. Stream projection itself does not own that synthetic.

The renderer must not sort transcript blocks by timestamp, id, or local heuristics after this point.

### 2. Classify ordered items into semantic buckets

`bucketizeTurnItems(...)` owns the shared classifier shape.

It produces:

- `preUserItems`
- `userItems`
- `latestAssistantMessage`
- `assistantItem`
- `systemEventItem`
- `agentItems`
- `postAssistantItems`
- dedicated side buckets for todo/diff/plan/plan implementation/MCP elicitation/model changed/model rerouted/provenance/request surfaces

The critical invariant is:

- `latestAssistantMessage` means "the latest assistant message in raw normalized item order"
- `assistantItem` means "the conditionally promoted assistant that gets the dedicated final lane"

They are not interchangeable.

### 3. Build turn view state from the classified buckets

`buildTurnViewModel(...)` consumes the buckets and derives:

- v2 hidden/standalone/groupable activity units and generic group summaries
- visible turn lanes
- search units
- worked-for adornment usage
- thinking placeholder state
- collapse eligibility

This stage may filter visible rows, but it must not rewrite ownership incorrectly. In particular:

- `workedFor` may disappear from visible `agentBodyEntries`
- the latest assistant's search unit must survive even when `assistantItem` is `null`
- `assistant -> exec` must stay inline in the agent body instead of being re-pinned into trailing blocks

## Classification Rules

### Leading prefix

- leading `userMessage` rows stay in `userItems`
- leading `hook` rows before the first non-user/non-hook row stay in `preUserItems`

### Dedicated side slots

These families are peeled out before fallback agent classification:

- `turnDiff`
- `todoList`
- `proposedPlan`
- `planImplementation`
- `remoteTaskCreated`
- `personalityChanged`
- `forkedFromConversation`
- `modelChanged`
- `modelRerouted`
- pending `approval`
- pending `userInput`
- incomplete `mcpServerElicitation`

### Fallback agent-like family

The fallback ordered candidate list includes:

- `assistantMessage`
- `exec`
- `fileChange`
- `mcpToolCall`
- `dynamicToolCall`
- non-empty `webSearch`
- `automaticApprovalReview`
- `multiAgentAction`
- `subagentActivityInlineGroup`
- `streamError`
- `systemError`
- `contextCompaction`
- `worktreeInit`
- `autoReviewInterruptionWarning`
- `steered`
- `reasoning`
- `userInputResponse`
- completed `mcpServerElicitation`
- `workedFor`
- later `hook` rows when a later user/agent-like row still exists

### Conditional assistant promotion

After side-slot extraction and trailing automatic-approval-review peel:

- if the last surviving agent candidate is an `assistantMessage`, that item becomes `assistantItem`
- otherwise `assistantItem` stays `null` and every assistant remains inline in `agentItems`

This is the central classifier rule. The renderer must not "helpfully" promote the latest assistant just because one exists.

After this extraction, same-turn subagent activity has one narrow override: a renderable trailing assistant in `commentary` phase moves back into `agentItems` when anchored or null-anchor subagent activity owns the turn. Final-answer assistants are not moved by this rule.

### Trailing automatic approval review

Trailing `automaticApprovalReview` rows are peeled off the end of the agent candidate list first.

Then:

- if `assistantItem` is promoted, those reviews become `postAssistantItems`
- if no assistant is promoted, those reviews go back inline in the agent lane

### Conditional system event promotion

`systemEventItem` is promoted only after assistant promotion is resolved, and only when:

- the turn is not `inProgress`
- there is no visible final assistant content in the dedicated slot
- the last remaining agent candidate is `systemError`

## Render Order

Once the turn is classified, the visible order is semantic-slot order:

1. `modelChangedItems`
2. `preUserItems`
3. `userItems`
4. `modelReroutedItems`
5. grouped/collapsible `agentItems`
6. `systemEventItem`
7. final-assistant divider plus `assistantItem`
8. `postAssistantItems`
9. incomplete MCP elicitation
10. proposed plan / todo / thinking placeholder / completed diff
11. remote-task / personality / fork provenance markers

This means two things are true at once:

- the renderer is not strictly raw-array chronological
- the renderer also must not re-sort the canonical per-turn stream arbitrarily

The correct behavior is "canonical item order, then semantic lane order."

## Scenario Matrix

### `user -> final assistant`

- `latestAssistantMessage = assistant`
- `assistantItem = assistant`
- visible result: `user, assistant`

### `user -> commentary assistant -> final assistant`

- earlier commentary assistant stays in `agentItems`
- latest assistant is promoted
- visible result: `user, commentary assistant, assistant`

### `user -> final assistant -> exec`

- `latestAssistantMessage = assistant`
- `assistantItem = null`
- `agentItems = [assistant, exec]`
- visible result: `user, inline assistant + exec`

This is the regression-prone case. If Nodex renders `user, assistant, exec` with the assistant pinned in a dedicated final lane, assistant ownership is wrong.

### `user -> final assistant -> exploration exec -> reasoning`

- latest assistant stays inline
- exploration rows group inside the agent body
- visible result: `user, assistant, exploration cluster`

### `user -> final assistant -> mcp tool call`

- latest assistant stays inline
- visible result: `user, assistant, MCP call`

### `user -> final assistant -> web search`

- latest assistant stays inline
- visible result: `user, assistant, web search`

### `user -> final assistant -> hook`

- hook is not agent-like if no later user/agent-like row survives
- assistant is promoted
- visible result: `user, assistant, hook`

### `user -> final assistant -> context compaction`

- assistant stays inline
- visible result: `user, assistant, context compaction`

### `user -> final assistant -> automatic approval review`

- trailing review is peeled
- assistant is promoted
- visible result: `user, assistant, review`

### `user -> final assistant -> worked-for`

- `workedFor` participates in classification
- assistant is not promoted because `workedFor` is the last surviving agent candidate
- completed `workedFor` is later removed from visible agent rows and reused as historical collapse-label input
- active `workedFor` remains visible as the plain running divider before the first non-user work row
- visible result: `user, inline assistant`, plus worked/working-for label behavior

### `tool/exploration before final assistant`

- earlier tool rows stay in `agentItems`
- final assistant is promoted
- visible result: `user, tool/exploration, assistant`

## `worked-for` Contract

`worked-for` is not a normal visible transcript row, but it is also not "just a divider."

The correct contract is:

- it enters the internal classifier path as an agent-like item
- it can block assistant promotion
- active running turns keep it visible in `agentBodyEntries`
- completed collapsible turns extract it before either collapsed or expanded agent-body rendering
- completed turns reuse it through `ThreadWorkedForBlockModel` as label input for the historical `Worked for ...` toggle

In practice this means:

- do not exclude it from `bucketizeTurnItems(...)`
- do not leave completed worked-for blocks visible inside collapsed or expanded historical `agentBodyEntries`; one extracted item is the sole toggle-label source
- do keep active running worked-for blocks visible so the transcript renders `Working` / `Working for ...` before tool/commentary rows
- do not let its visual treatment rewrite assistant ownership

## Latest Assistant Search Ownership

Thread-find/search follows the latest assistant by raw normalized item order, not by dedicated final-slot ownership.

So:

- `assistant -> exec` still has a latest assistant search unit
- the search unit key stays `turnId:assistant`
- earlier commentary assistants cannot steal that slot if a later assistant exists
- `assistantItem === null` must not remove assistant search ownership

This is why Nodex keeps `latestAssistantMessage` separate from `assistantItem`.

## Placeholder And Collapse Rules

### Thinking placeholder

Thinking/streaming placeholder logic must not use `assistantItem` as shorthand for "the latest assistant exists."

It should consider:

- raw latest-assistant state
- grouped exploration state
- proposed-plan streaming state
- `worked-for`
- blocking request surfaces

This keeps `assistant -> exec` ownership correct in both `inProgress` and `completed` turns.

### Agent-body collapse

The agent body is driven by grouped `agentItems`, not by "all items before the final assistant."

Consequences:

- `assistant -> exec` may collapse together as one agent-work section
- a renderable final-answer boundary, or settled subagent activity, establishes collapse eligibility
- eligible latest and historical turns both default collapsed unless persisted disclosure state overrides that default
- interrupted turns never collapse, and active subagent activity prevents automatic collapse
- null-anchor subagent state may affect eligibility without creating a visible item, wrapper, or DOM anchor
- completion must not silently promote the assistant into a dedicated final slot

### Worked-for divider

The collapsed agent-body summary uses the Codex worked-for precedence:

- explicit live worked-for timing, with `Working` / `Working for …` while the turn is active
- completed turn `durationMs`, rendered as `Worked for …`
- `X previous messages` only when no timing exists

If `assistantItem` is `null`, assistant actions stay on the deferred action-only anchor after the settled agent body so later tool rows remain above the toolbar.

## Common Regression Traps

### Wrong: "latest assistant always wins"

This causes:

- assistant pinned below later tool rows
- wrong visible order for `assistant -> exec`
- incorrect lane ownership in completed turns

### Wrong: search ownership derived from `assistantItem`

This causes:

- missing assistant thread-find unit in `assistant -> exec`
- search highlighting disappearing when later tool rows arrive

### Wrong: filtering `workedFor` before classification

This causes:

- assistant promoted in `assistant -> worked-for` when the classifier should keep it inline
- wrong collapse label/divider behavior

### Wrong: re-sorting transcript rows in the renderer

This causes:

- reopened long-running threads diverging from canonical turn order
- commentary/final assistant chunks moving between lanes incorrectly

## Files To Recheck Before Touching This Feature Again

- `src/renderer/features/local-conversation/projection/build-renderer-item-stream.ts`
- `src/renderer/features/local-conversation/projection/build-turn-render-model.ts`
- `src/renderer/features/local-conversation/projection/bucketize-turn-items.ts`
- `src/renderer/features/local-conversation/projection/build-turn-view-model.ts`
- `src/renderer/features/local-conversation/projection/agent-activity-v2.ts`
- `src/renderer/features/local-conversation/projection/agent-activity-group.ts`
- `src/renderer/features/local-conversation/view/local-conversation-thread-turn.tsx`
- `src/renderer/features/local-conversation/projection/bucketize-turn-items.node.test.ts`
- `src/renderer/features/local-conversation/projection/agent-activity-v2.test.ts`
- `src/renderer/features/local-conversation/view/local-conversation-turn-entry.test.tsx`

## Acceptance Criteria

Any future refactor is valid only if all are true:

- later surviving tool-like rows keep the latest assistant inline
- `assistantItem` is conditional
- `worked-for` blocks assistant promotion before becoming label/divider input
- latest assistant search ownership survives when `assistantItem` is `null`
- subagent commentary ownership and null-anchor collapse state never manufacture visible activity
- visible order matches semantic slot order across the scenario matrix above
