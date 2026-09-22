# Codex Subagent Behavior

Status: Active
Last Updated: 2026-09-22

## Intent and ownership

Subagents are child agent Threads attached to a root Chat. They do not become
independent sidebar Chats. The app-server owns execution, the spawn graph,
mailboxes and persisted transcripts. Core Workspace stores observed identity
and status facts; Main's root-scoped Subagent Directory reconciles discovery
and supplies metadata, selection and control interfaces. Every operation uses
the root's durable execution host and Project coordinates.

One pure shared row projection derives identity, parent-Turn association,
visibility, status, objective, timing and messaging permission for the overview,
transcript, summary and composer mentions. Core's observation index does not
independently decide visible row state. This document owns those rules and root
lifecycle behavior. [Thread Transcript Behavior](codex-thread-transcript-behavior.md)
owns the activity leaves, and [Owner/Follower Streaming](codex-thread-owner-follower-streaming.md)
owns canonical transcript attachment.

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
limits. Initially it shows four Active and ten Done rows. Show more expands the
local collection; Show less restores those limits. Counts reflect the shared
visible rows and remain lower bounds until discovery completes. Expansion never
loads child transcripts. Root-scoped invalidations refresh the metadata view;
old host generations cannot replace a newer view.

The shared source order places parent-history members first, followed by resident descendants, active metadata-only descendants and discovered source rows. Pending requests use this order; overview sections sort their own rows by recency.

Only named rows appear in the overview and summary. Display names use explicit
membership names, receiver metadata, membership metadata and child nicknames;
blank values, conversation titles and raw Thread IDs are not agent labels. Source paths can establish a
modern activity name. Blank/default roles are omitted. Objective text is cleaned
and shortened to 60 characters for the overview, then a current reasoning summary
is used, then Working for non-Done rows. Done clocks use the last assistant start
time (per-message observation, final-answer start, then Turn start), falling back to row recency; active clocks use the latest Turn start or
child creation time. Inherited parent history is removed before computing child
progress, reasoning, answer timing or diffs.

## Status and interaction rules

A close reference hides the child. A system-error runtime also hides it. Hidden
agent state or a latest failed/interrupted Turn hides the child unless its runtime
is currently active. A needs-resume or not-loaded resident uses newer summary runtime when available. Otherwise an available runtime determines status: active is
Active, including waiting-on-approval/input flags, and every other runtime is
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

Only a collaborative spawn in immediate-parent history grants messaging. Later
collaboration preserves the grant. An activity preserves it within the same
parent Turn and resets it in a later Turn. A message alone creates no membership,
but messages for an existing child participate in that same grant transition.
Source-only nested children consult their immediate parent's resident history.
Missing parent history grants nothing. Status, residency and metadata cannot
grant messaging. The grant is further constrained by archive state and normal
execution-writer ownership when presenting a composer.

## Opening and inherited history

Main verifies root membership before opening a child. Interactive collaborative
children open separate background-agent task tabs; read-only children open the
root's Subagents panel with that child selected. Independent interactive children
retain independent tabs. Child detail uses its observed model and reasoning
effort, omitting unknown values.

Read-only history loading does not resume execution or acquire the native writer.
A cold detail reads the child and necessary parent history through the existing
history owner, then attaches the normal canonical stream. It never attaches its
siblings. Existing resident history is reused. Route readiness is fenced to the
selected child and required restore/history work; late responses cannot select an
older child. Failure is retryable and cannot masquerade as an empty transcript.

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
cannot be reported as successful local archive. The inactive-rollout fallback
remains an explicit native recovery path.

Permanent deletion checks the native archived state-database listing before
issuing thread/delete. A missing target is a no-op. Missing-rollout recovery is
passed explicitly when the native error requires it. Delete-all processes the
selected archived IDs sequentially. Native deletion and its notifications own
descendant removal; no separate client closure or polling loop gates success.

## Validation boundaries

Behavioral tests cover runtime and history precedence, close/reopen transitions,
nested interaction grants, message-only non-membership, shared overview regrouping,
metadata-only pending requests, cold read-only loading, writer conflict, and
independent interactive tabs. Protocol tests cover discovery fallback, repair,
absence reconciliation and lifecycle failure handling. Seeded Electron tests
exercise the mounted transcript and selected child boundaries with disposable
Profiles; production Profiles and bulk sibling hydration are excluded.
