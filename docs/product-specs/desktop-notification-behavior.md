# Desktop Notification Behavior

## Status

Active

## Purpose

This document is the source of truth for Nodex OS-level notifications produced
by Codex task lifecycle events and by Agent Runtime Sessions. Browser delivery, in-app toasts, reminder
notifications, and remote cloud-task watchers are separate features.

## Notification Families

Native execution permission requests are approved automatically and produce no task notification. Nodex has two task notification families:

- `turn-complete`: a local-host top-level task turn reached `completed`,
  `failed`, or `interrupted`.
- `question`: an asynchronous question arrived or a user-input request became pending, including ordinary
  questions and supported option/onboarding/setup inputs with no question
  rows.

MCP elicitation, plan-implementation confirmation, setup context selection,
and unsupported private requests do not produce desktop notifications.

## Ownership and Ordering

The feature has four owners:

1. `CodexProtocolNotificationEffects` publishes a typed application occurrence
   only after the canonical conversation transition or pending-request state
   change has committed. Hydration and renderer snapshot projection are not
   producers. Agent Runtime Sessions publish the same occurrences from Main's
   Session activity transitions (see [Agent Runtime Sessions](#agent-runtime-sessions)).
2. The pure Codex notification handler decides policy, settings, focus,
   presentation, host, and target renderer; its Main-scoped runtime owns event
   subscription and action admission.
3. `DesktopNotificationRuntime` owns Electron `Notification` instances, exact
   occurrence records, and their native callback lifecycle.
4. `WorkbenchCommandIngress` owns renderer action ingress. Workbench session
   and panel commands perform navigation before any reply or question action.

One raw lifecycle occurrence emits at most one domain event. Owner/follower
renderer state, cold snapshots, and repeated projections cannot create another
OS notification. Re-showing the same native ID replaces the existing native
record; replacement is lifecycle behavior, not producer deduplication.

## Child Classification

A conversation is a child when either source of provenance is present:

- its direct `parentThreadId` is non-empty; or
- app-server `source.subAgent.thread_spawn.parent_thread_id` is non-empty.

Every notification family is suppressed for real child conversations. A child
question is not relabeled as a parent-task notification.

No blanket exclusion applies merely because a top-level conversation is
ephemeral, system-sourced, or a side conversation. `realtime_voice` suppresses
turn completion only. Internal helpers that are real children remain excluded
by provenance.

## Settings

The two app preferences are independent:

- `turnMode: "off" | "unfocused" | "always"`
- `questionsEnabled: boolean`

Defaults are `unfocused` and `true`. They persist under:

- `thread_notifications_turn_mode`
- `thread_notifications_questions_enabled`

System notification permission is separate from these preferences. A denied
OS permission does not rewrite app preferences, and disabling task
notifications does not change OS permission.

## Turn Policy

Turn policy is evaluated in this order:

1. non-default hosts do not emit turn notifications;
2. an automation-level `DONT_NOTIFY` suppresses;
3. when there is no automation decision, a heartbeat `DONT_NOTIFY`
   suppresses;
4. real children suppress;
5. `threadSource === "realtime_voice"` suppresses;
6. a terminal-specific pending continuation suppresses;
7. `turnMode === "off"` suppresses;
8. `turnMode === "unfocused"` suppresses while any Workbench window is
   foregrounded;
9. otherwise show.

Pending continuation is exact to the terminal state:

- a loading queued resource or unpaused queue head suppresses `completed` and
  `failed`, but does not suppress `interrupted`;
- an active thread goal suppresses `completed` only;
- a latest merged turn that is still `inProgress`, any running collaboration
  agent, or any active descendant suppresses every terminal state;
- a pending steer does not suppress on its own.

The automation decision is an optional upstream fact. Nodex does not currently
persist a per-automation notification mode, so local automation turns provide
no automation decision and use the heartbeat fallback. Adding mute or
failed-runs-only controls requires an Automation-owned persisted contract; it
must not be inferred from cron or heartbeat identity.

Completed, failed, and interrupted terminal states all enter this policy.
User interruption is not an unconditional exclusion.

The title is the normalized task title, falling back to `Turn complete`. The
body prefers the heartbeat notification message, then heartbeat-visible text,
then the final assistant message, and finally `Nodex finished a turn.`. Turn
notifications may expose native inline reply.

## Request Policy

An input request is shown only when:

- the corresponding app preference is enabled;
- the conversation is not a real child; and
- no foreground renderer is actually presenting that conversation.

Request policy does not consult `turnMode`. A foreground app showing another
task does not suppress the request.

Presentation is surface-aware. Main tracks
`(rendererClientId, conversationId, surfaceId)`, so unmounting one duplicate
surface does not clear another surface that remains visible. Stream ownership
is not presentation.

Request presentation is:

| Raw request   | Title                           | Body                           | Native actions  |
| ------------- | ------------------------------- | ------------------------------ | --------------- |
| input request | task title or `Need your input` | singular/plural question count | none; open only |

The current production app-server source is the singleton local host. Request
events and actions retain a host-qualified contract so a future real host
source can register without changing request semantics. No synthetic remote
producer is created by the notification subsystem. Only the local host emits
turn completion.

## Request Resolution

Every raw `serverRequest/resolved` withdraws native request UI, including when
the canonical request reducer has no matching live request. Main attempts exact
dismissal of the question family:

- `question-${hostId}-${requestId}`

Presenting a conversation in a foreground renderer dismisses all notifications
for that conversation. Window disposal dismisses records targeted to that
renderer. The native runtime also supports exact notification-ID and exact
navigation-path dismissal.

## Native IDs and Presentation

Stable public IDs are:

- `turn-${turnId}`
- `question-${hostId}-${requestId}`

Public IDs intentionally preserve the native contract. Main separately indexes
each occurrence by family, host, conversation, and strict scalar request ID, so
numeric `73`, textual `"73"`, and equal public IDs in different conversations
cannot replace or resolve one another.

Main converts title and body to single-line plain text at native delivery.
Markdown structure is preserved until parsing, so fenced code, readable link
labels, and text after code blocks survive. Citation payloads, directive
attributes, script/style blocks, HTML tags, and excess whitespace are removed.
The reply's plain text is submitted to the operating system, which controls its
visible preview; notification presentation adds no fixed character limit.
It caps native buttons at four, uses `timeoutType: "never"` for
question notifications, enables reply for turn notifications only, and uses
the Nodex notification sound on macOS when the packaged resource can be
staged.

Click, button, reply, native failure, close, replacement, route dismissal,
renderer disposal, and shutdown cleanup are idempotent. Constructor/show/close
and callback-cleanup failures are isolated to their occurrence. The first
native action consumes its callback record; later callbacks from the same
native instance do nothing.

## Target Renderer and Focus

Main selects one live renderer for each notification:

1. the latest renderer whose presentation surface actually contains that
   conversation;
2. the last-focused live Workbench window;
3. the first remaining live Workbench window.

If no live renderer exists, the occurrence is dropped and logged. Only an
`open` click restores, shows, and focuses the target window. Inline buttons and
reply navigate and act without forcing focus.

## Navigation and Actions

Every native callback carries `hostId`, actual `conversationId`,
`navigationPath`, optional `activateTabId`, and strict `requestId`.

- A root notification navigates to its attached task session.
- A side-conversation notification navigates to the saved parent path and
  activates `sidechat:${conversationId}`. If the ready side tab is not mounted,
  Workbench materializes it without starting a new side conversation.
- Navigation must complete before reply or question execution.
- Reply trims only surrounding whitespace, preserves the user's Markdown and
  type-like text, and starts a turn through the manager for the payload's exact
  host.

Native ingress enters through `WorkbenchCommandIngress`; it is not converted
into request-tick props or handled by a global conversation controller.

## System Permission

Main reads the running application's native authorization before delivery. On
macOS, the native bridge queries `UNUserNotificationCenter` inside Electron's
process so permission belongs to the same bundle that sends notifications.
Only an undetermined permission triggers an authorization request, and delivery
waits for its result. Concurrent requests share the authorization gate. Every
later delivery reads the current system decision again, including changes made
outside Nodex. Authorized and provisional permissions permit delivery; denied
permission releases the notification occurrence without attempting native delivery.

Notification settings show the macOS authorization separately from the two app
preferences. An undetermined permission can be requested there; a denied
permission offers an action to open System Settings. Returning to Nodex refreshes
the status. Browser notification permission is unrelated and is never requested
by the task notification flow. `Notification.isSupported()` is only a platform
capability check.

macOS authorization belongs to the running application bundle, independently of
the Nodex Profile. A development Electron instance and an installed Nodex app
can have different authorization and signing identities. A rejected delivery
leaves the task's completion and pending question intact; it removes only that
notification's callback record. Resolving a question, disposing its window,
replacing an occurrence, or shutting down while authorization is pending prevents
that obsolete occurrence from appearing after permission is granted.

## Observability

Main logs structured suppression reasons, dropped occurrences with no live
target, denied/unavailable authorization, and native authorization, construction,
delivery, close, and callback-cleanup failures.
These logs must not contain prompt bodies, approval commands, or user replies.

On macOS, `UNErrorDomain error 1` means UserNotifications did not allow the
delivery. This identifies a native notification failure, not a failed Agent Run.
Check authorization and signing for the actual running bundle; the error alone
does not establish why authorization is unavailable. Do not infer native
permission from the renderer's browser permission or platform support check.

## Asynchronous Question Actions

A live asynchronous Agent message produces one question notification for its first question,
scoped by host, Thread, Turn, and question identity. Its body is `Nodex has a question`.
It uses the ordinary question preference and foreground-presentation suppression rules.
History loading and repeated item completion do not produce another notification.

Opening the notification first navigates to its Thread, then opens the question panel only
if its Turn is still running. It has no inline reply or blocking-request identity. A stale
notification cannot send text or start another Turn. Accepted answers and Turn completion
dismiss the corresponding question notifications; foreground presentation also dismisses
notifications through the ordinary visibility boundary.

## Agent Runtime Sessions

A Runtime-bound Session uses the same families, settings, policy, copy and
target selection. Its conversation identity is the Session's root Thread, its
title is the Session title, and its host is the local host.

- `turn-complete`: the root's foreground Run ends completed, failed or
  interrupted, including an automatic wake Run after delegated results. A
  cancelled Run counts as interrupted; a Run rolled back by conversation rewind
  does not notify. Live delegated or background work, or a delegated result
  that will wake the root, is a pending continuation for every terminal state;
  a queued follow-up that starts next suppresses completed and failed but not
  interrupted. The body is the ended Run's last root assistant reply, read from its durable
  outcome by exact Run identity only when turn policy could show the notification.
  This remains available after native execution authority is released, including
  failed or interrupted Runs. A newer Run or child reply cannot supply its body;
  an absent reply uses the ordinary completion fallback. Missed terminal status
  is also read from that outcome. Delegated children never notify on their own.
- `question`: the root starts waiting for an information answer or gains
  another pending question. One notification represents the waiting episode
  and is withdrawn when the root stops waiting.

Either event marks the Session unread in Core unless a focused window presents
its conversation or the Session is archived. A Runtime conversation reports its
presentation through the same registry as native chats, so a visible root is not
marked unread; showing a delegated child does not present its root. Process
restarts and missed observations reread activity without producing notifications.

Its navigation path names the Session (`session:<id>/thread:<root>`), so opening
the notification selects that Session directly rather than resolving a native
Thread, and a reply is an ordinary follow-up through the Session's execution
owner.
