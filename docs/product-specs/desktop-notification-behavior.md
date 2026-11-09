# Desktop Notification Behavior

## Status

Active

## Purpose

This document is the source of truth for Nodex OS-level notifications produced
by Codex task lifecycle events, Agent Runtime Sessions, and chat reminders, and for the
presence that decides whether anyone needs telling. Phone notifications consume the same
occurrences and presence; their delivery rules are in
[Nodex Mobile Behavior](mobile-companion-behavior.md#notifications). Browser delivery, in-app
toasts, Page reminders, and remote cloud-task watchers are separate features.

## Notification Families

Nodex has these task notification families:

- `turn-complete`: a local-host top-level task turn reached `completed`,
  `failed`, or `interrupted`.
- `question`: an asynchronous question arrived or a user-input request became pending, including ordinary
  questions and supported option/onboarding/setup inputs with no question
  rows.
- `approval`: an Agent Runtime Session started waiting for a native execution approval. The title
  says the Session needs approval and the body names the requested action. It has its own public
  identity but shares the question preference, open-only action and persistent lifecycle; it
  never answers the approval itself.

For native conversations, MCP elicitation, plan-implementation confirmation, setup context selection,
and unsupported private requests do not produce desktop notifications.

## Ownership and Ordering

Core owns durable Page Turn notification intents. Main drains and atomically
claims them while their episodes are current, then applies preferences, focus
and OS permission through the shared native notification owner. A restart or
repeated note never creates a second interruption. Migrated waiting episodes
start quietly. Question and approval use the question preference and suppress
while their chat is presented; note-requested notifications use the turn preference.


1. `CodexProtocolNotificationEffects` publishes a typed application occurrence
   only after the canonical conversation transition or pending-request state
   change has committed. Hydration and renderer snapshot projection are not
   producers. Agent Runtime Sessions publish the same occurrences from Main's
   Session activity transitions (see [Agent Runtime Sessions](#agent-runtime-sessions)).
   Every channel, desktop and phone, consumes these occurrences; none derives its own.
2. `UserPresence` answers where the person is (see [Presence](#presence)).
3. The pure Codex notification handler decides policy, settings, focus,
   presentation, host, and target renderer; its Main-scoped runtime owns event
   subscription and action admission.
4. `DesktopNotificationRuntime` owns Electron `Notification` instances, exact
   occurrence records, and their native callback lifecycle.
5. `WorkbenchCommandIngress` owns renderer action ingress. Workbench session
   and panel commands perform navigation before any reply or question action.

One raw lifecycle occurrence emits at most one domain event. Owner/follower
renderer state, cold snapshots, and repeated projections cannot create another
OS notification. Re-showing the same native ID replaces the existing native
record; replacement is lifecycle behavior, not producer deduplication.

## Presence

A conversation is **seen** while it is in front of the person:

- a focused Workbench window presents it while the screen is unlocked; or
- Nodex Mobile shows it on a phone with a live connection.

A locked screen puts no window in the foreground. Locking withdraws foreground
presentation from every window, and unlocking restores it to the focused window,
which counts as presenting its conversations again. Main tracks window
presentation per `(rendererClientId, conversationId, surfaceId)` and phone views
per open chat, so closing one duplicate surface or one phone view does not clear
another that remains visible. Stream ownership is not presentation.

A conversation becoming seen, in a window or on a phone, dismisses all desktop
notifications for it and withdraws a phone notification still waiting for it.
Seen conversations are not marked unread and produce no request notifications.

Presence also answers whether the person stayed at this computer after an
occurrence: input after it means they were here, and a locked screen or five
minutes without input means they left. Phone delivery uses this answer; desktop
notifications do not.

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

Turn policy is evaluated in this order. Steps 1–6 decide whether the occurrence
is worth telling anyone and are shared by every channel; steps 7–9 belong to the
desktop.


1. non-default hosts do not emit turn notifications;
2. an automation-level `DONT_NOTIFY` suppresses;
3. when there is no automation decision, a heartbeat `DONT_NOTIFY`
   suppresses;
4. real children suppress;
5. `threadSource === "realtime_voice"` suppresses;
6. a terminal-specific pending continuation suppresses;
7. `turnMode === "off"` suppresses;
8. `turnMode === "unfocused"` suppresses while any Workbench window is
   foregrounded, or while the conversation is seen;
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
- the conversation is not seen.

Request policy does not consult `turnMode`. A foreground app showing another
task does not suppress the request.

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

A conversation becoming seen dismisses all notifications for that conversation.
Window disposal dismisses records targeted to that renderer. The native runtime also supports exact notification-ID and exact
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
- A side chat never opens as a Scene of its own. Its notification navigates to
  the conversation it was opened from and selects its side-chat tab there:
  `sidechat:${conversationId}` for a native side Thread, and
  `sidechat-session:${sessionId}` for a Runtime side chat's temporary Session.
  If the tab is not mounted, Workbench rebuilds it without starting a new side
  conversation; a side chat that no longer exists leaves the source selected.
  A reply goes to the side chat, not to its source.
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
It uses the ordinary question preference and seen-conversation suppression rules.
History loading and repeated item completion do not produce another notification.

Opening the notification first navigates to its Thread, then opens the question panel only
if its Turn is still running. It has no inline reply or blocking-request identity. A stale
notification cannot send text or start another Turn. Accepted answers and Turn completion
dismiss the corresponding question notifications; seeing the conversation also dismisses
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
  outcome by exact Run identity whenever the Run has no pending continuation.
  This remains available after native execution authority is released, including
  failed or interrupted Runs. A newer Run or child reply cannot supply its body;
  an absent reply uses the ordinary completion fallback. Missed terminal status
  is also read from that outcome. Delegated children never notify on their own.
- `question` and `approval`: the Session starts waiting for user attention or gains another
  pending request; an execution approval uses the approval family. Root approvals and live
  questions notify immediately. A waiting episode that changes between a question and an
  approval replaces its notification. An asynchronous root question notifies
  once its Run stops working, including when the provider turn ends. Only live delegated
  approvals roll up; delegated questions and provider-native child requests never notify the
  user. Temporary side-chat attention notifies through the source Session. Attention replaces
  turn completion while the Session waits, so a question revealed at turn end produces one
  question notification. One identity follows the waiting episode across Run changes and is
  withdrawn when the Session stops waiting.

Either event marks the Session unread in Core unless its conversation is seen or
the Session is archived. A Runtime conversation reports its presentation through
the same registry as native chats, so a visible root is not marked unread;
showing a delegated child does not present its root. Process
restarts and missed observations reread activity without producing notifications.

Its navigation path names the Session (`session:<id>/thread:<root>`), so opening
the notification selects that Session directly rather than resolving a native
Thread, and a reply is an ordinary follow-up through the Session's execution
owner.

A temporary side chat's completion uses its own conversation, title and reply,
but its navigation path names the source Session it was opened from and it
selects the side chat's tab there, so the reply is read beside the source
conversation. Whether a Session is a side chat and which Session it came from
are read from Core's execution binding, not from live activity. A side chat
whose source cannot be resolved does not notify.

## App badge

The app icon shows how many chats the chat list shows as unread to you, across
every Project of every Space this desktop has open: its personal Space and each
team Space it has joined. Each Space's Core counts its own chats with the chat
list's membership rules and your own unread state there: root chats that are not
side chats, the Coordinator or archived, in no Project or an unarchived one.
Delegated children and side chats never add to it, and another Member's unread
chats never do. One read per Space keeps its part current.

The badge follows every chat organization change, Project change and Core
restart or reconnection in each Space, whichever window, phone, Agent tool or CLI
made it, and does not depend on window focus. A team Space that cannot be read
keeps its last count until it can; leaving it takes its chats out. On macOS it is set through the notification center, so it
appears only while Nodex may notify and the system's Badges switch for Nodex is
on. Linux launchers that support counts show it; Windows has no app badge. The
first count after launch replaces a badge an earlier run left behind, and
closing the Profile clears it.

## Chat reminders

A chat reminder is one nullable instant on its Session. At the chosen time, Desktop
compares and clears the exact stored instant before delivery. A concurrent reschedule
survives, and another timer, window, or restarted host cannot deliver the consumed
reminder again. Core retains unfinished unread delivery across a host restart or
unavailable native identity. Failed unread delivery is deferred without blocking
other reminders; notification settlement consumes that delivery once. Rescheduling,
clearing, a user message, or archive cancels unfinished delivery too.
Archived chats have no reminder. A user-authored message cancels the
reminder; Agent messages and merely reading the chat leave it in place.

One Profile-scoped Desktop owner arms a single timer for the earliest reminder. Core
organization changes from any window, Agent tool, or CLI re-arm it. Startup, restored
Core connectivity, and system resume catch up overdue reminders without periodic
polling. A seen conversation consumes the reminder without an unread write or
notification, using the same [presence](#presence) as Session task notifications.

Otherwise delivery uses the same unread owner as `set_session_unread`: Core for
Runtime Sessions and threadless drafts, authenticated Codex identity read state for
native Threads. Its notification title is the chat title and its body is
`You asked to come back to this chat.` It is open-only and navigates directly through
`session:<id>/thread:<root>` to the Session. Drafts retain their Session identity.
Native notification attempts settle before presentation and are not replayed after
restart. System permission or process termination can prevent visible delivery.
The existing turn notification preference and native authorization gate apply;
suppressed or denied presentation does not undo the unread transition. Seeing the chat

Handback updates intake and its badge without creating a desktop notification of
its own. Turn notifications continue to depend on current Member episodes.
