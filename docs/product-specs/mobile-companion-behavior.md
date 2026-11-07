# Nodex Mobile Behavior

## Intent and authority

Nodex Mobile is the iOS and Android companion to a desktop Profile. It exists for the moments away
from the computer: drop a thought into the Inbox, start a chat, see what a running chat is doing,
and answer it when it asks something.

A phone owns no Nodex data. Rust Core owns the Inbox, Sessions and Library; the Agent Runtime owns
Runs and history; the Desktop Host's Mobile Gateway is the phone's only way in. Agents run on the
desktop, on the desktop's accounts and files, so the desktop must be on with Nodex open. A phone
holds its keys, its unsent captures, its drafts, and a cache of what it last saw.

## Turning it on and pairing

- Mobile access is off by default, per Profile, in Settings > Mobile. While it is off, nothing
  listens on the network.
- `Pair a phone` shows a QR code. A phone scans it from the app or the system camera; the app also
  accepts the same code as a pasted link, for a phone or simulator without a camera. A code that
  opens the app from outside, such as from the system camera or a web page, names the desktop and
  asks before connecting.
- A code works once and expires after five minutes. Only one is open at a time. Failed attempts by
  others cannot use it up. A code that only failed to reach the desktop offers `Try again`, so fixing
  the network does not need a new code. If the app closes before pairing finishes, it keeps the
  phone's identity and retries on later launches and foreground returns. Retrying a code for that
  desktop first recovers that identity, even if it already used the code or the code expired. A
  refusal from the desktop clears the unfinished pairing; starting one with another desktop replaces
  it.
- Settings lists each paired phone with its platform, version, and whether it is connected or when
  it was last seen. `Remove` ends that phone's access at once, including a live connection. Removing
  a phone does not touch its chats or messages, which belong to the Profile.
- A phone can know several desktops and uses one at a time. `Forget` on the phone stops it
  connecting and discards captures it had not delivered; it does not remove the phone from the
  desktop, which is what `Remove` is for.
- Every paired phone has the Profile's full content and chat access, as a desktop window does. There
  are no per-phone permissions.

## Reaching the desktop

- A phone connects directly over the local network or a tailnet. There is no Nodex service in
  between, so a phone away from both cannot connect. Pairing records every address the desktop
  offers, and the desktop updates that list on each connection.
- The phone tries its addresses at once and uses the first that proves it is the paired desktop. An
  address now used by another machine simply fails.
- A desktop too busy to answer delays a chat rather than failing it: the phone keeps asking, and
  everything that does not need Agent execution, such as the Inbox, keeps working meanwhile.
- Everything between phone and desktop is encrypted end to end, including on plain Wi-Fi. See
  [Security](../SECURITY.md#mobile-gateway).
- The app reconnects on its own and at once when it returns to the foreground. Its header shows the
  state only when it is not connected. A standing notice floats above the Composer, on Home and in an
  open chat. It says what the state means and offers the fix: `Retry` while the desktop is unreachable, `Pair again` when the desktop
  no longer knows this phone, and an update prompt when the two versions cannot talk. What is already
  on screen stays readable, and the notice holds steady while the app keeps retrying.

## One screen, one Composer

The app stays in portrait. Home is a stream or a list and one Composer. `Inbox` and `Chats` switch by a tap or a
swipe, and the Composer follows: it drops into the Inbox, or starts a chat. Drafts stay with their
Composer until sent.

Content fills the screen and passes beneath floating bars, so no bar keeps space to itself. On a system
with Liquid Glass the bars and the Composer are glass and content blurs away under the top bar. Elsewhere
they are the platform's nearest material, and Android keeps a solid top bar. At rest the Composer is one
line whose placeholder names where a message goes. In use it opens to show its pickers.

### Inbox

- The stream shows the chosen Inbox, the Library's or a Project's, newest at the bottom, rendered as
  the desktop renders it. The Composer's chip, shown while it is in use, chooses the Inbox it shows and
  sends to. A phone chooses explicitly, as a desktop window does.
- Capture never waits for the network. A sent message is durable on the phone first, shows as waiting,
  and is delivered in order once the desktop is reachable, across app restarts. Retrying can never
  create a second message. A message the desktop refuses stays visible with the reason, `Retry` and
  `Discard`. A delivered message is timed by its arrival on the desktop. A send whose answer never came is
  checked on the desktop first, so one that landed is simply done.
- Messages may carry photos from the camera or library. They are resized for delivery and become
  ordinary Library Files in the message, as on the desktop. Retrying an upload keeps the same File
  reference. An upload never changes an existing File: if that File has since been edited or removed
  on the desktop, the photo becomes a new one.
- A message with a suggestion offers one decision labeled by what it does, such as `Start chat`.
  Accepting authorizes the suggestion the phone is showing; a suggestion that changed since then is
  refused rather than applied. A message edited after its suggestion was written is reviewed on the
  desktop. See [Inbox Behavior](./inbox-behavior.md).
- Tapping a suggestion opens all of it in a sheet, with the same decision: what accepting will do, the
  prompt a chat would receive, what the suggestion adds of its own, why it was made, who wrote it, and
  the Agent it chose. Opening the message lays out the same content in place.
- Opening a message shows it whole, with `Start chat`, `Mark done`, `Keep`, `Important`,
  `Ask for a suggestion` and `Delete`. Decisions that can be undone offer `Undo` for a few seconds.
- The history control switches between waiting and handled messages.

### Chats

- The list covers every Project. Chats asking for something come first under `Needs you` with the
  question itself, then `Working`, then `Recent`. An empty section has no heading, and a list with
  only recent chats has none at all.
- Live status updates in place without reordering; order changes on the next read.
- Starting a chat chooses a Project, a location (the checkout or a new worktree, offered as soon as
  a Project that can use one is chosen) and an Agent, and remembers them per desktop. An Agent that cannot run says why rather than disappearing. A chat
  needs a live connection to start; it is not queued offline. Permission mode comes from the
  Profile's setting for new chats.

### A chat

- A chat opens at its newest message and loads older history on the way up. It follows new content
  only while the reader is at the end; reading further up holds still while the end grows. Once away
  from the end, a control returns to the newest, and sending always does. The Inbox stream behaves the
  same way.
- If the desktop restarts during a Run, the phone reconnects on its own and the chat shows that the
  turn resumed, followed by what the Agent writes from there.
- The transcript follows the Run live. Tool steps and reasoning collapse to one line per stretch of
  work, which names the step in progress or counts the steps done. Opening a step shows its full
  output.
- Approvals and questions are pinned above the Composer, so they cannot scroll out of reach. An
  approval shows exactly what is being approved and the choices that Run offers; a long one scrolls
  and can be opened further. Answering from a
  phone is the same as answering from the desktop, and whichever answers first wins.
- While a Run is active, sending queues the message behind it, and pressing and holding send redirects
  the Run now instead. An empty Composer's button stops the Run.
- A connected conversation only its desktop owner can continue is readable, and says so in place of
  the Composer. A question that asks for a secret is answered on the desktop, and the chat says so.

## Notifications

- On iOS, a paired phone can receive notifications while Nodex Mobile is away or closed. The desktop
  must be on with Nodex open and Mobile access enabled. Notifications do not require a direct network
  connection from the phone to the desktop.
- A new approval or question sends an attention notification with the chat title and what is being
  asked. These notifications are time-sensitive. A request for a secret says to answer on the desktop
  and never includes the question.
- A completed Run sends the start of its last assistant reply, or “Finished” when there is none.
  A failed Run says “Run failed”. Stopping a Run does not send a notification. Child and background
  work that is absent from the chat list does not notify independently.
- Notifications are sent only while the phone has no live foreground connection. Settings on the
  phone has separate switches for when a chat needs you and when it finishes, and a running chat offers
  them once. Settings > Mobile on the desktop shows whether they are on beside that phone's details.
- A phone that cannot register says why in Settings and offers a retry. It tries again by itself on
  each connection.
- Tapping a notification opens its chat, on the desktop that sent it. Opening a chat clears its
  notifications, and one chat's notifications group together.
- A request or Run notifies each phone at most once. Existing state when the gateway starts is quiet;
  restarting the desktop does not replay notifications. Delivery is best effort, with a short bounded
  retry for temporary relay failures.
- Notification text is encrypted for the phone before it leaves the desktop. The push relay routes
  it to Apple's notification service; it cannot read the chat title, message or chat identity. Removing
  a phone also removes its notification registration. If the phone cannot open one, it shows a generic
  alert instead of losing it. Android notifications are not supported yet.

## Limits

- The desktop must be running with Nodex open. A sleeping or closed computer reads as unreachable.
- Notifications currently require iOS. A sleeping desktop cannot send them.
- The app does not browse the Library or edit Pages.
