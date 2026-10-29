# Codex Subagent Behavior

Status: Active
Last Updated: 2026-10-24

## Intent and ownership

This document describes provider-native Codex subagents. Application-owned
delegated Threads follow [Agent Runtime behavior](agent-runtime-behavior.md).

Subagents are child agent Threads attached to a root Chat. They do not become
independent sidebar Chats. The app-server owns execution, the spawn graph,
mailboxes and persisted transcripts. Core Workspace stores observed identity
and status facts; Main's root-scoped Subagent Directory reconciles discovery
and supplies metadata, selection and control interfaces. Every operation uses
the root's durable execution host and Project coordinates.

One pure shared row projection derives identity, parent-Turn association,
visibility, status, objective, timing and execution availability for the overview,
transcript, summary and composer mentions. Core's observation index does not
independently decide visible row state. This document owns those rules and root
lifecycle behavior. [Thread Transcript Behavior](codex-thread-transcript-behavior.md)
owns the activity leaves, and [Owner/Follower Streaming](codex-thread-owner-follower-streaming.md)
owns canonical transcript attachment.

## Visual identity

Every identified child uses one of 32 ordered identities, each with separate light
and dark SVG artwork. The renderer derives its index from the child Thread ID:
start at zero, then for each JavaScript UTF-16 code unit compute
`hash = (hash * 31 + codeUnit) % 2147483647`; the index is `hash % 32`.
The array order is stable. Names, roles, models, parent order and execution state
never enter this calculation. Different Threads may receive the same identity;
there is no collision avoidance or per-parent allocation pool.

For application-owned execution, the seed is Nodex's durable child Thread ID,
not its provider's native reference; changing providers does not change visual
identity. Native remote conversations use their canonical child Thread ID.
The execution owner persists Thread identity. The renderer reconstructs the
avatar from that identity after navigation, hydration and restart; no icon ID,
random choice or allocation table is persisted. An activity without a known
child Thread uses the generic subagent glyph until identity is available,
rather than assigning an avatar from a task ID or display name. Changing the
bank's order or capacity changes the mapping and must be treated as an identity
change, not a transparent resource addition.

Inline activity, summary, overview, selected detail, child tabs and titles,
composer candidates and inserted agent mentions share this identity. Avatars
are decorative, non-draggable images; adjacent names and accessible controls
provide the label. Running, waiting, completion and errors use separate status
indicators and never recolor or animate the identity artwork.

The resolved document `data-theme` selects the artwork: `dark` uses dark assets;
every other value uses light assets. Switching appearance preserves the index.
Inline groups show at most four 16px avatars; summaries and composer candidates
use 14px, child tabs use 18px, and overview rows and detail headers use 24px.
These display budgets do not constrain the identity bank or hide the remaining
children from the overview.

## Discovery and overview

Concurrent callers share one discovery pass for a root and host generation.
Discovery follows metadata pages to completion, guarding repeated cursors.
Ancestor listing is used when supported; otherwise direct-parent listing walks
the descendant tree. A terminal first state-database page missing an observed
spawn may trigger a non-state listing. Repair reads history only for an observed
missing child whose metadata is not resident, retaining the latest Turn skeleton
rather than its items. The root creation time bounds legacy discovery.

An incomplete pass preserves uncertainty and cannot finish children by absence.
A complete pass may reconcile absent known children to idle while preserving
newer active or system-error observations. Active resident descendants remain
visible even when metadata listing misses them. Identity admission and discovery
are different: all non-message lifecycle activities establish membership, while
observed spawn/started events are the triggers for targeted discovery repair.

The overview classifies the complete row collection before applying presentation
limits. A settled read projects one complete, revision-fenced Core collection with
the discovery snapshot captured across that read. Discovery publication during the
read retries the pair; waiting for discovery refreshes it.
Initially it shows four Active and ten Done rows. Show more expands the
local collection; Show less restores those limits. Counts reflect the shared
visible rows and remain lower bounds until discovery completes. Expansion never
loads child transcripts. Resident canonical state supplies row evidence without
materializing child transcript presentations. Root-scoped invalidations refresh the metadata view;
old host generations cannot replace a newer view.

The shared source order places parent-history members first, followed by resident descendants, active metadata-only descendants and discovered source rows. Pending requests use this order; overview sections sort their own rows by recency.

Only named rows appear in the overview and summary. Display names use explicit
membership names, receiver metadata, membership metadata and child nicknames;
blank values, conversation titles and raw Thread IDs are not agent labels. Source paths can establish a
modern activity name. Blank/default roles are omitted. Objective text is cleaned
and shortened to 60 characters for the overview, then the current Thought's heading
is used, then Working for non-Done rows. Done clocks use the last assistant start
time (per-message observation, final-answer start, then Turn start), falling back to row recency; active clocks use the latest Turn start or
child creation time. Inherited parent history is removed before computing child
progress, reasoning, answer timing or diffs.

## Status and interaction rules

A close reference hides the child. A system-error runtime also hides it. Hidden
agent state or a latest failed/interrupted Turn hides the child unless its runtime
is currently active. A needs-resume or not-loaded resident uses newer summary runtime when available. Otherwise an available runtime determines status: active is
Active, including waiting-for-input flags, and every other runtime is
Done. With no runtime, completed discovery implies Done. During incomplete
discovery, child Turn progress wins, then pending-init maps to Waiting, completed
to Done, and the remaining fallback is Active. Visible rows never expose an
independent Unknown status.

A lifecycle activity resets the latest tool to spawn, clears the spawn model,
and updates its running/completed state. Interrupted activity records completion;
a subsequent message preserves an already completed state. Wait and sendInput
preserve the preceding tool. Resume preserves it unless the preceding tool was
close. Thus close followed by send remains hidden, while fresh lifecycle activity
or explicit resume can reopen the row.

Messaging follows the child's actual execution owner and native capability.
Parent history, spawn visibility and transcript residency do not grant or limit
access. A message alone creates no discovery membership. Imported history stays
passive when it has no execution owner; an archived, deleted or retired child
cannot accept execution commands. Controls preserve the child's exact host,
Session and native generation rather than borrowing a foreground parent Run.

## Opening and inherited history

Main verifies root membership before opening a child. Interactive collaborative
children open separate background-agent task tabs; read-only children open the
root's Subagents panel with that child selected. Independent interactive children
retain independent tabs. Child detail uses its observed model, reasoning effort and Fast
state, omitting unknown values. The detail header uses the same inline Fast indicator as
the Composer. Its settings belong to the child, independently of the parent's settings
and the new-chat defaults.

Read-only history loading does not resume execution or acquire the native writer.
A cold detail reads the child and necessary parent history through the existing
history owner, then attaches the normal canonical stream. It never attaches its
siblings. Existing resident history is reused. Route readiness is fenced to the
selected child and required restore/history work; late responses cannot select an
older child. Failure is retryable and cannot masquerade as an empty transcript.
Deleting the selected child returns its owning host's panels to the overview,
including hidden panels and pending history loads. A deletion from another host
or for another child does not cancel that selection's loading; an old response
cannot restore a selection after its child is deleted.

Inherited Turns are removed before execution resumes as well as afterward.
Stable parent Turn identity or a canonical content-prefix match establishes
inheritance; item IDs and transport timestamps do not change content identity.
Read-only details have no composer, edit-message or Turn-fork action. Interactive
details acquire the writer only at the ordinary execution boundary. A writer
conflict replaces the composer with This is open in another app and Retry.

## Parent composition and requests

The composer portal does not repeat the subagent list or expose Stop all.
Transcript activity and the Thread Summary provide access to the same rows.
The dedicated @ provider lists named interactive direct children from any parent
Turn and inserts agent:// references. General thread:// references remain a
separate context source.

Parent pending-request selection spans all descendants in stable row order,
preserving each immediate-parent identity. Main projects resident canonical
pending requests and the minimal Turn/file-change context needed for eligibility;
request visibility does not depend on opening a child transcript. Approval,
permission, authorization and eligible per-Turn or turnless MCP elicitation use
their ordinary visibility rules. Empty file changes are not actionable approvals.

## Root interruption, archive and deletion

Stopping the root first invokes its normal interrupt. Descendant cleanup then
interrupts known resident active children, followed by fresh discovery. A
metadata-active child without resident active history receives a one-Turn
items-not-loaded read and is interrupted only if that Turn remains in progress.
A canonical state created by notifications is not proof of a live execution owner;
confirmed owner absence uses the native Turn fallback. Children run concurrently;
individual failures produce warnings and do not turn root-stop success into a
subtree-convergence requirement. There is no grace delay
or post-interrupt polling. Resident cleanup also attempts to pause that child's
active Goal; nonresident fallback interrupts only the Turn.

Archive sends the native root archive operation without requiring a complete
descendant graph or persisting an expected closure. Native archive notifications
and normal local cleanup update affected identities. A failed physical operation
cannot be reported as successful local archive. Archive recovery uses the
native API; Nodex does not rewrite Codex's private SQLite archive index. A stale
local identity is retired only after native absence is confirmed.

Permanent deletion checks the native archived state-database listing before
issuing thread/delete. A missing target is a no-op. Missing-rollout recovery is
passed explicitly when the native error requires it. Delete-all processes the
selected archived IDs sequentially. Native deletion and its notifications own
descendant removal; no separate client closure or polling loop gates success.

## Validation boundaries

Behavioral tests cover runtime and history precedence, close/reopen transitions,
execution availability, message-only non-membership, shared overview regrouping,
metadata-only pending requests, cold read-only loading, writer conflict, and
independent interactive tabs. Protocol tests cover discovery fallback, repair,
absence reconciliation and lifecycle failure handling. Seeded Electron tests
exercise the mounted transcript and selected child boundaries with disposable
Profiles; production Profiles and bulk sibling hydration are excluded.
