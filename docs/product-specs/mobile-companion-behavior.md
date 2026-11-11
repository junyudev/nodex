# Nodex Mobile Behavior

## Intent and authority

Nodex Mobile is the iOS and Android companion for personal and team Spaces:
capture to the Inbox, follow chats and answer the Turns that belong to you.

A phone is a Device of a Member in each enrolled Space. Rust Core owns content,
Actors, attention and answer entitlement; the execution host owns Runs and
history. The host phone façade projects bounded views under that Member's
Core-issued invocation proof. Main embeds it for a personal Space and
`nodex serve` embeds it for a hosted Space. The phone holds device credentials,
unsent captures, drafts and cached views; it owns no canonical Nodex data.

## Getting the app

- Every desktop release ships Nodex Mobile with the same version, and the download page offers
  it. On iPhone it is a public TestFlight beta, which keeps it up to date. On Android it is an APK:
  installing a newer one over the last keeps the phone's linked Spaces, drafts and unsent captures.
- Every Android release is signed with the same key, which a future store listing keeps, so an
  installed copy can always update.

## Remote access and linking a Device

- A personal Space's Remote access uses its Core-owned pinned-TLS listener.
  Core remembers whether it is enabled and its chosen bind address and port
  across restarts; Desktop settings and the native CLI share that configuration.
  Core restores enabled access at startup with the same port and certificate. If the port is occupied,
  it chooses an available port and reports that the routes changed; show a fresh
  Device link to restore reachability. Disabling remains disabled after restart.
- In the Space's Devices settings, `Link a device` creates a QR code and copyable
  link. The phone scans or pastes it. A link opened from outside the app names
  the Space and asks before connecting.
- Settings links to the app's listings on the download page, for a phone that doesn't have it yet:
  beside the empty device list and beside the code while it shows.
- The versioned link carries Space identity and name, reachable routes, the full
  leaf-certificate fingerprint, one-time code and five-minute expiry. It enrolls
  another Device of the same Member and never creates a different Member.
  A lost enrollment response needs a fresh link.
- The native transport verifies the pin before sending the code or credentials.
  The pin alone admits the host, so its own self-signed certificate works at
  every address a link carries, on iPhone and Android alike: a LAN or tailnet
  (100.64.0.0/10) IP address, a `.local` or unqualified name, or a DNS name. A
  phone tries local addresses first, then tailnet addresses, then the rest. A
  pin mismatch is shown rather than bypassed.
- Each enrollment stores a separate device-only SecureStore credential. Sessions
  renew at the same Core frontier as desktop sessions. Existing phone credentials
  must be enrolled again; there is no compatibility decoder or credential migration.
- Each connection’s hello supplies Core’s personal or team Space kind. The phone
  saves it with the linked Space and refreshes it on every connection; enabling
  personal Remote access does not make a Space a team.
- The menu and Settings both list the linked Spaces. Switching selects that Space
  and Member's cached views, drafts, outbox and chosen Inbox, and its lists open
  whole: a search or filter does not follow from the last Space. Removing a Space
  locally stops its connection and removes its local state. Remote Device
  revocation remains a separate action. A capture is never sent through another
  Member's enrollment.

## Reaching a Space

- The phone connects directly to each Space host over LAN, a tailnet or an
  operator-provided reachable route. It uses one authenticated WebSocket on the
  same Core listener as desktops. There is no personal-desktop relay.
- A personal Space is available while its desktop runs. A team Space served by
  `nodex serve` remains available while that host runs, even with a joined laptop
  closed. Stopping or sleeping the authority makes it unavailable.
- Connection recovery renews sessions and replaces bounded list and chat
  snapshots. Turn, Work, Automation, Problem and Member attention changes invalidate
  the same lists. Chat activity and open transcript updates follow the execution
  owner. A chat opened while its Run works shows what the Run has done so far and
  then follows it live; if the execution owner stops delivering to a watch, the
  host reads the chat again and attaches a new one.
- A connection notice floats above the Composer and keeps cached content readable.
  `Reconnecting` offers Retry; withdrawn access offers Link again. When the phone and
  host versions cannot talk, it offers `Update`, which opens TestFlight on iPhone or the
  download page on Android. A host without the required capability returns typed
  unavailable state with the reason.
  Unsupported execution never falls back to personal accounts or files.
- Removing the Device or Member closes the live stream and shows `Access revoked`.
  When the host closes the stream for renewal, the phone renews at once, and the
  first address whose host refuses the Device decides; it does not wait out other
  addresses or show `Reconnecting` first. That enrollment stops reconnecting; a fresh
  Device link is required. An open chat stays readable as it was last seen, with
  nothing shown as running and no Composer, Stop or answers. Withdrawal from one
  Space does not affect another Space's enrollment or unsent captures.
- Downloaded content is not remotely erased. Direct reachability, host uptime and
  certificate trust remain prerequisites; no Internet relay carries content. Only
  sealed notifications travel through the push relay described below.

## One screen, one Composer

The app stays in portrait. Home is a stream or a list and one Composer. `Inbox` and `Chats` switch by a tap or a
swipe, and the Composer follows: it drops into the Inbox, or starts a chat. Drafts stay with their
Composer until sent.

Content fills the screen and passes beneath floating bars, so no bar keeps space to itself. On a system
with Liquid Glass the bars and the Composer are glass and content blurs away under the top bar. Elsewhere
they are the platform's nearest material, and Android keeps a solid top bar. At rest the Composer is one
line whose placeholder names where a message goes. In use it opens to show its pickers.

A control in a top bar does only what it says. Where the system sends a list to its top when the
bar is tapped, the status bar still does and the bar's controls do not.

### The menu

Home rests on a menu of where the phone is looking: the current Space with its connection, each
Inbox that Space has, the other linked Spaces, and Settings.

- The Space's avatar at the top left opens it from either pane. So does a swipe to the right across
  the Inbox; from Chats the same swipe returns to the Inbox first. Opening puts the keyboard away and
  keeps the draft.
- The whole app slides aside as a card that follows the finger. Releasing past halfway, or a flick,
  decides where it rests. Tapping the card, dragging it back, or Android's back closes the menu.
- `Inbox` lists the Library's and every Project's, each with how many messages wait, and marks the
  one being shown. Choosing one shows it and returns to the app.
- `Other Spaces` appears when more than one is linked. Choosing one switches to it.
- The menu belongs to Home. Opening Settings, a chat or a message closes it.

### Inbox

- The stream shows the chosen Inbox, the Library's or a Project's, newest at the bottom, rendered as
  the desktop renders it. Library Home reads across all Projects; capture there has no Project. A
  phone chooses explicitly, as a desktop window does: from the menu, or from the Composer's chip
  without leaving the words being written. Each Space keeps its own choice while the app runs and
  starts at its Library. The resting Composer names a Project it would capture to.
- Capture never waits for the network. A sent message is durable on the phone first, shows as waiting,
  and is delivered in order once the desktop is reachable, across app restarts. Retrying can never
  create a second message. A message the desktop refuses stays visible with the reason, `Retry` and
  `Discard`. A delivered message is timed by its arrival on the desktop. A send whose answer never came is
  checked on the desktop first, so one that landed is simply done.
- Messages may carry photos from the camera or library. They are resized for delivery and become
  ordinary Library Files in the message, as on the desktop. One capture or chat message
  accepts at most 16 MiB of photos in total; an oversized batch is refused before upload.
  Retrying an upload keeps the same File reference. An upload never changes an existing File: if that File has since been edited or removed
  on the desktop, the photo becomes a new one.
- An intake row with routing advice offers one decision labeled by what it does, such as `Start chat`.
  Accepting authorizes the suggestion the phone is showing; a suggestion that changed since then is
  refused rather than applied. A suggestion to set a message aside shows its return time or
  `Someday`. If that time has passed, the phone offers a new choice. A message edited after its
  suggestion was written is reviewed on the desktop. See [Inbox Behavior](./inbox-behavior.md).
- Tapping a suggestion opens all of it in a sheet, with the same decision: what accepting will do, the
  prompt a chat would receive, what the suggestion adds of its own, why it was made, who wrote it, and
  the Agent it chose. Plans include every Page, its Project and prerequisites.
  Opening the message lays out the same content in place.
- Opening intake shows its whole message, with `Start chat`, `Mark done`, `Keep`, `Later`,
  `Important`, `Ask for a suggestion` and `Delete`. `Later` offers one hour, three hours, the next
  9:00 AM at least three hours away, and Monday at 9:00 AM of the following week.
  Duplicate times appear once. Decisions that can be undone offer `Undo` for a few seconds.
  On a team Space, its host starts the chat with your authority, even while your laptop is closed.
- A chat started from a message opens once its host has started it. Until then the message shows
  it starting. If it cannot start, the message keeps its reason in the Inbox, on every Device:
  `Retry` appears only when its Space would accept it, such as a host that could not run it; a
  refused decision needs a new one, and a delivery that may have arrived is opened to check, never
  sent again from the phone. A chat opened before its host starts it says so and follows the Run
  once it starts.
- The history control switches between the Inbox, `Later` and handled messages. It shows how many
  of the Member's message and Turn rows are set aside in the chosen Inbox. Handled
  shows intake Pages whose messages no longer wait for routing or recovery. `Later` shows each return time,
  soonest first. Open a message there to return it, change the time, keep it, mark it done
  or dispatch it. A message that returns shows when it was set aside. A Later suggestion
  includes a time. When that time has passed, the Member can confirm with a new one.

The stream contains four distinct row kinds: intake, Turn, answer and Problem.
Only intake offers Keep, Later, Done, Delete, Important, advice and reviewed routing.
Turns say whose move it is in the desktop's words, such as `Needs your answer` or
`Ready for your review`. Questions
have option buttons and Reply to the active chat; review offers Accept and
ready-to-start offers Start. A Turn linked to a connected native chat shows reply
as unavailable and directs you to that chat’s desktop; Accept remains available
when Core offers it. Every action carries the exact episode and its retry
identity. Approvals open the chat's existing approval card. Answers link their
subject chat. Problems use the Problem id and its one fix; Reconnect and Open
Page visibly require the desktop on this channel. Work, Automations, Sources and
Member attention changes invalidate the same Core-projected stream.

### Chats

- The list covers every Project. Chats asking for something come first under `Needs you` with the
  question itself, then `Working`, then `Recent`. An empty section has no heading, and a list with
  only recent chats has none at all. A new chat open on a desktop joins the list once its first
  message starts it.
- Live status updates in place without reordering; order changes on the next read.
- A row previews its chat by the opening message of the chat's current history: after an edit
  rewinds past that message, the row shows the message written in its place.
- Pressing and holding a chat you may manage offers `Archive`: in a team Space, a chat you started or
  any chat when you own the Space, as Core tells the phone. See
  [Team Space Behavior](./team-space-behavior.md).
- `Archived`, above the list, switches it to the Space's archived chats, newest first and without
  sections; search then looks among them, and `Chats` returns. Each opens to read, and `Restore`
  appears beside those you may manage, as Data controls on a desktop lists them.
- Starting a chat chooses a Project, a location (the checkout or a new worktree, offered as soon as
  a Project that can use one is chosen) and an Agent, and remembers them per Space and Member. An Agent that cannot run says why rather than disappearing. A chat
  needs a live connection to start; it is not queued offline. Permission mode comes from the
  host Profile's setting for new chats. On a team Space its host starts the chat with your
  authority, as a team desktop's New chat does, and it is yours: in the host's tasks directory
  without a Project, or where the host runs the Project.

### A chat

- A chat opens at its newest message and loads older history on the way up. It follows new content
  only while the reader is at the end; reading further up holds still while the end grows. Once away
  from the end, a control returns to the newest, and sending always does. The Inbox stream behaves the
  same way.
- A message reads as its desktop shows it: formatted the same way, with a Page or chat it mentions
  shown by name rather than as a link's address.
- If the desktop restarts during a Run, the phone reconnects on its own and the chat shows that the
  turn resumed, followed by what the Agent writes from there.
- The transcript follows the Run live. Tool steps and reasoning collapse to one line per stretch of
  work, which names the step in progress or counts the steps done. A thought reads there as on its
  desktop: by its latest heading, or else the start of its words, as plain text without Markdown
  marks. Opening a step shows its full output. A command still running shows the end of what it has written so far, as its desktop
  does, and keeps following it while open until it ends.
- Approvals and questions are pinned above the Composer, so they cannot scroll out of reach. An
  approval shows exactly what is being approved and the choices that Run offers; a long one scrolls
  and can be opened further. Answering from a
  phone is the same as answering from the desktop, and whichever answers first wins.
- While a Run is active, sending queues the message behind it, and pressing and holding send redirects
  the Run now instead. An empty Composer's button stops the Run, when you may stop it: in a team
  Space, Core lets the Member who asked for the Run, the chat's owner and the Space Owners. Anyone
  else sees Stop unavailable, and tapping it says why.
- A chat you may manage offers `Archive` in its header and `Undo` afterwards. An archived chat says
  “Restore this chat to continue it.” in place of the Composer, with `Restore` for those who may.
- A connected conversation only its desktop owner can continue is readable, and says so in place of
  the Composer. A question that asks for a secret is answered on the desktop, and the chat says so.
- Every picture the desktop shows in a chat shows on the phone too: photos in a message, pictures in
  a reply, the picture an Agent viewed or generated and the pictures a tool returned. A step shows
  the copy of a picture the Agent viewed or generated, or else the pictures its tool returned: up to
  four beneath the step in an opened stretch of work, and all of them in the opened step. A step
  whose picture's file was already gone, and an imported reply's picture whose file was gone at
  import, name that picture with the reason. An imported conversation's replies show their pictures
  from the copies kept at import. A reply's pictures sit in its text, whole and at their own shape:
  one on a line of its own spans the reply's width, no taller than keeps the reply around it in view,
  and holds its place until it loads so the reply moves only once. A message's photos and a step's
  pictures are thumbnails that download only once shown. Tapping any of them opens the chat's
  pictures full screen at that one, oldest first, where a swipe moves through the rest of the chat's
  pictures. There a pinch zooms about the fingers and a double tap zooms in where it lands or back
  out, the same on iPhone and Android; a zoomed picture pans to its edges instead of moving to the
  next. A picture never travels inside a step's output.
- A chat's photos, files and pictures download from its host the way a team desktop reads them, as
  the reader's own Member. A Device or Member withdrawn partway through a download reads no more of
  it.
- A connected conversation's pictures show too: those in its messages, the pictures it viewed or
  generated and those its tools returned. Its desktop reads each from the conversation or from the
  file it names on the machine that ran it, and only a picture ever leaves the desktop. A picture
  on the web loads from there. One the desktop cannot read, such as a picture Codex keeps with its
  provider or a file that is gone, appears in its place with the reason.

## Notifications

- On iOS, a linked phone can be told while Nodex Mobile is away or closed. Each Space sends its own
  notifications while its host runs: the personal desktop with Nodex open, or `nodex serve`. The
  phone needs no direct network path to the host for them.
- The phone hears about exactly what the desktop considers worth telling, decided once for both: a
  chat finishing, failing or stopping, asking for an approval or an answer, a chat reminder coming
  due, and a Page Turn becoming yours: a question or approval a chat Nodex manages waits on, or a
  review, block, failure or stall Nodex asks you to look at. Work that continues by itself, such as
  a queued follow-up or delegated work that will wake the chat, is not a finish. Child and
  background work that is absent from the chat list does not notify independently, a side chat's
  reply stays beside the chat it came from, and a chat Nodex manages speaks through its Inbox posts
  and Page Turns instead of as a chat. One moment is told once: a Turn waits beside the chat it came
  from, so a newer notification for you there replaces it, and a Turn's question from a chat Nodex
  does not manage is told only as that chat's own request.
- A notification reaches only the Member it concerns, by the same rule that decides who may answer:
  a question goes to whoever asked for that Run, an approval to the Page Owner, each falling back to
  the other, a finished, failed or stopped Run to whoever asked for it, a reminder to whoever set
  it, and a Page Turn to the Member whose move it is. In a team Space one Member's phone never hears
  about another's question or Turn. A personal
  Space's only Member hears about all of its chats.
- The phone is for when you are away from the computer. Something that happens while you are at it
  is left to the desktop, which shows it in the window or as its own notification. The phone is told
  at once when the screen of every computer you use with that Space is locked or nobody has used it
  for five minutes. Otherwise it is told only if you leave without touching one again: once its
  screen locks or five minutes pass with no input. For a personal Space that computer is its
  desktop; for a team Space it is each desktop you have joined it from, which tells the Space while
  you use it. A Member with no such desktop in use is told at once. Answering the request, opening
  the chat in a focused window or on one of your phones, the Page Turn moving on, or a newer
  notification for you in the same chat withdraws one that is still waiting.
- Nothing is sent about a chat open on one of the Member's phones with a live connection, and
  nothing is sent to a Device with a live connection to that Space; the app shows it live instead.
  Another of the Member's phones still is told. Opening a chat on the phone also withdraws its
  desktop notifications and keeps it read on the desktop of a personal Space.
- An approval or question says what is being asked, and a reminder says you asked to come back. A
  Page Turn shows its Inbox title and the opening of its message, or what it waits for when it has
  none.
  These are attention notifications and are time-sensitive. A request for a secret says to answer on
  the desktop and never includes the question. A finished Run sends the start of its last assistant
  reply, or “Finished” (“Stopped” for a stopped Run) when there is none. A failed Run says “Run
  failed”.
- Settings on the phone has separate switches for when a chat needs you and when it finishes, and a
  running chat offers them once. Reminders follow the first. The Space's Devices settings mark a
  phone with notifications on, and never show where they are sent.
- The phone registers again on every connection to a Space, which also tells a Space about switches
  changed while connected elsewhere; turning both off withdraws from each Space as the phone next
  connects to it. A phone that cannot register says why in Settings and offers a retry.
- Tapping a notification switches to the Space and Member that sent it and opens its chat; a Page
  Turn opens the chat it waits on, or its Inbox message when it waits on none. Opening a chat clears
  its notifications, and one chat's or Page's notifications group together. A notification from a
  Space removed from the phone opens nothing.
- When the app connects to a Space, and whenever that Space's chats or Inbox change while it is
  connected, it clears the notifications that Space sent you and no longer stands behind: a chat
  that is no longer unread for you there, including one read on a desktop, archived or gone from the
  chat list, and a Page Turn that has moved on or is no longer yours. A Turn's notification follows
  its Turn, even when the Turn waits on a chat. Each Space judges only its own notifications, by
  your own state there; one that cannot answer leaves them in place. A closed app cannot withdraw
  anything, so a notification for a chat read on a desktop stays until the app next opens.
- Restarting a host does not replay notifications: Page Turns already current when it starts stay
  quiet, and each Turn is told once whether or not a desktop already showed it. Delivery is best
  effort, with a short bounded
  retry for temporary relay failures. A phone address the relay reports gone is forgotten.
- Notification text is encrypted for each phone before it leaves the host. The push relay routes it
  to Apple's notification service; it cannot read the chat title, message, chat identity or the
  enrollment it is for. A host holds only an opaque handle, never the phone's push address. Revoking
  the Device or removing the Member drops its registration. Removing a
  Space on the phone while connected to it stops that Space's notifications; one removed while
  disconnected stops when its Device is revoked. If the phone cannot open a notification, it shows a
  generic alert instead of losing it. Android notifications are not supported yet.

## Limits

- The selected Space host must be running and reachable. A personal desktop that
  sleeps is unreachable; a team host can remain available independently.
- Notifications currently require iOS. A Space host that is asleep or stopped cannot send them.
- The app does not browse the Library or edit Pages.

Intake offers Save to Notes and Add to Todo. A note leads with Save to Notes
and other messages lead with Add to Todo. Saved notes appear in the Inbox’s
Handled view. Return to Inbox restores the note to its original Database in Triage.
