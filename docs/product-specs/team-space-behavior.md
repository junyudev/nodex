# Team Spaces

A Space is one Core authority and one Library. A personal Space has exactly one
active Member, an Owner bound to the local Profile. Enabling Remote access leaves
it personal. It becomes team when a second active Member joins, and remains team
after removal so implicit personal Agent attribution cannot resume. Members initially share the whole Library; Projects do
not create separate access boundaries.

A Space has one host-owned name in Core. An Owner sets it with
`nodex serve init --name` and renames it with `nodex serve rename NAME`
(or `nodex space rename NAME`). Until an Owner names it, a Space reads as what it
is: “Personal” while its one Owner keeps it on their own desktop, and “Team
Space” once it is shared or hosted. The switcher, Settings, Device-link offers
and phones all show Core's name. Enrollment and each
successful connection return that name, and a rename reaches every connected
desktop at once through its live event stream. Desktops persist the name with the
encrypted credential and refresh the switcher, menu and Home title.
An endpoint is a transport address and never supplies a display name.

## Listening and trust

`nodex space listen --address <host:port>` enables HTTPS for the current Core
process. `nodex-core --home <absolute-home> --listen <host:port>` enables it at
startup. The private local listener remains available. A listening Core stays
running until explicitly stopped; this command does not install a service.

Core generates a private server key and certificate on first enable and reuses
them across starts. Operators can instead supply `--cert <pem> --key <pem>`.
The listener returns its URL and SHA-256 leaf-certificate fingerprint. Use a
routable listen address; replace a wildcard bind address in the invite URL with
the host's reachable address before sharing it. Certificate changes require
explicitly trusting the new fingerprint through an authenticated Owner channel.

`nodex space remote-access on [--address 0.0.0.0:PORT]` starts the private-peer
listener and saves enabled intent with the actual chosen port in the Profile's
private listener configuration; `off` closes its listener and live connections
and saves disabled intent. `status` reads live state and saved intent. Core
restores enabled access at startup with the same port and certificate. If the
port is occupied, it chooses another and reports new routes for a fresh Device link. Its explicit peer policy admits private,
loopback, CGNAT/tailnet and link-local addresses. Operator-managed `nodex-core --listen` and `serve` retain their operator peer policy. Neither listening nor preparing a
headless host changes membership or Space kind.

`nodex space link-device` returns the Space name and ID, the requesting Member,
full leaf-certificate fingerprint, reachable HTTPS routes, one-time code and
five-minute expiry. It reserves a slot under the 16 active Devices per Member
cap and permits six offers per Member per hour, including consumed offers.
Routes reflect the actual bind, omit production loopback and virtual bridge
interfaces, and include LAN, CGNAT/tailnet and usable link-local addresses.
IPv6 link-local addresses require a client interface scope and are not portable
QR routes. An offer may have no reachable route; enable a reachable listener
before linking. Device form factor is metadata, supplied at redemption.

## Enrollment

An authenticated Owner can invite, list Members and all Devices, rename the
Space, revoke any Device and remove another Member, locally or over HTTPS.
Every Member can list and revoke their own Devices and link another Device of
their own. These use the same Core administration commands. Role and revocation
are checked again in the writer transaction; administrative writes retain Member
Actor evidence.

- `nodex space invite --role member` returns a URL, certificate fingerprint and
  random one-time code. An invite expires after 24 hours. The code is returned
  only when created, and Core keeps only its hash.
- An Owner can add `--member <id>` to enroll another device for an existing active Member with the same role.
- The recipient checks the fingerprint supplied by the Owner before sending
  `POST /enroll { code, device_label, display_name }` over HTTPS.
- Redeeming a code atomically creates the Member and Device and consumes the
  code, unless the code targets an existing Member. A Device-link offer always
  targets its requesting Member and never creates another Member. The response
  returns the device credential once. Replaying an invite
  fails. A lost enrollment response needs a new invite.
- `POST /session { device_credential }` exchanges the device credential for an
  hour-long session. A device can renew before expiry. Its credential remains
  valid until revoked. Session tokens and credentials are independent secrets.

An Owner role authorizes Space administration; a Page or Automation Owner is the Member
responsible for that record. They are distinct concepts. A remote Owner still cannot
claim local Host authority or administer the local Profile through HTTPS.

## Devices and access withdrawal

`nodex space devices` lists Space, device identity, Member, form factor, label, creation time,
last credential use and revocation time. `nodex space revoke <device>` refuses
new sessions and authenticated requests and closes that device's live responses
within seconds. `nodex space remove-member <member>` removes the Member and
revokes all their devices while retaining content references. An Owner cannot
remove themselves through this command.

Device withdrawal also retires that Member's outstanding Device-link offers,
preventing re-entry through a previously minted self-link code. Owner-issued
invitations retain their existing grant policy. Codes issued by other
Members and other enrolled Devices remain valid.

Remote Members can read and edit Library content, Database values and Views,
synchronize Documents, read Sources, recorded observations, Problems and Activity,
retry failing deliveries or replies, and use the
admitted collaboration commands, including the mixed Inbox read and its person
Turn actions (answer an option, Reply, Accept and Start). Coordinator notes,
Inbox answers and managed-chat handback require Agent authority; notification claiming is scoped to the requesting Member. Source configuration requires the local Owner
and Host; origin replies require the Coordinator. Source ingestion, sender
leases, send settlement and health recording remain Host producer
capabilities. Execution authority, native paths, backup, restore, maintenance and
host producer commands remain local capabilities. Members can read Automations and edit those set to Ask first or Dry run within scope. Only the
exact Automation Owner may change its mode or edit one set to Run, independent of their
Space role. Agents submit suggested edits for the Owner to apply. Automation producers,
scheduler and lease operations remain Host-only. New semantic commands are denied remotely until explicitly admitted.

## Administration surfaces

`nodex space invite`, `members`, `devices`, `link-device`, `revoke-device`,
`remove-member` and `rename` share administration with `serve`. To select a
remote Space, pass `--remote-connection /absolute/private.json`. This owned,
mode-0600 file contains `url`, `fingerprint`, `space_id`, and
`device_credential`; no secret belongs in shell arguments. The CLI verifies the
pin before sending the credential, obtains a session and validates Space and
Core compatibility. An invalid connection fails without local fallback.
Certificate and listener control, backups and shutdown remain local-only.

Desktop Settings has typed `space-admin:*` queries and commands through the
bound `SpaceRequest` envelope. The renderer's Space administration Module works
under either the local or a remote authority; it cannot select a different
Space in command JSON.

## Phone connections

Phones enroll as independent Devices of their existing Member using the
Space's Device-link offer. Each Space has its own credential, session and
certificate trust; personal phone enrollment grants no team membership. One
Core-authenticated WebSocket serves the bounded mobile RPC and streams through
the host façade. The façade preserves the Member's Actors, mixed Inbox, unread
and answer entitlement. Unsupported capabilities are typed and visible.

A phone reaches `nodex serve` directly and remains usable when a joined laptop
is closed. A personal Space requires its desktop host to remain running. Device
withdrawal closes that Device's stream and queued writes recheck authority.
Phone caches, drafts and outbox are keyed by `(spaceId, memberId)`; captures never
move between Members. See [Nodex Mobile](mobile-companion-behavior.md).

A team desktop tells the Space whether its Member is at it, so the host holds that
Member's phone notifications while they work at a computer and sends them once they
step away. See [Presence](desktop-notification-behavior.md#presence).

## Desktop connections

One Desktop stays connected to its local personal Space and one or more remote
Spaces. A remote connection may reach another personal Space or a team Space.
The personal Space owns its supervised local Core. A team connection owns an
authenticated HTTPS client, live content streams and Documents; it never starts,
stops or polls a process on the team host. The Core-authored Library ID is the
stable `spaceId`, independent of endpoint, process generation and Store epoch.

Settings → Spaces is one page for reaching the Space that is open:

- **This Space** shows its avatar, name and kind, and the person's role. Owners
  rename it there. In the personal Space, the Owner turns Remote access on or off
  and sees the addresses linked devices reach it at.
- **Devices** lists the reader's own Devices first and, for an Owner, everyone's,
  each with whose it is, what it is and when it was last seen. A Device with a
  live connection, such as a phone's open stream, is seen within the last
  minute. This computer is
  marked and leaves through Your Spaces instead of revoking itself. Link a device
  shows a one-time link that pins the certificate and its code, with the time
  left; in the personal Space it needs Remote access on.
- **People** lists the reader first. The reader renames themselves from their own
  row, beside the Owner's Space rename; a name Core would refuse, such as “You”,
  is explained before saving. An Owner invites someone, which shows the
  invite link and one-time code to send, and removes a Member after confirming.
  The personal Space shows People once its Owner turns Remote access on.
- **Your Spaces** lists every connected Space with its availability, opens one,
  leaves a team Space and joins another.

Join a Space accepts the HTTPS invite URL, its certificate fingerprint, the one-time code,
your display name and a device label. An invite's `fingerprint` query or fragment
pins the certificate and displays its fingerprint. The dialog asks for a fingerprint
only when the invite carries none. Check it against the Owner's value before joining.
Device credentials are encrypted with the operating system's secret storage in a
private file per Space. There is no plaintext fallback; session renewal stays in
memory. Leave removes the local credential and closes that connection without
removing shared content or revoking another device.

The rail's Space switcher selects the current Space. Every Space keeps its own
sidebar, Home, Library, Boards and Inbox. Each window restores that Space's last
route, Scenes, surfaces and navigation history in the existing Window Session
catalog. New windows cloned from a team window retain that Space. Switching
flushes local owners before opening a renderer document bound to the selected
Space. Delayed commands retain their original Space. A missing, unknown or
mismatched Space is rejected in Main; it never falls back to personal content.
Copied Page, View and Session links include their Space. External unqualified links
are refused; relative mentions stay within their Document’s Space. Main resolves a qualified
link against that connection before navigating, switching the renderer when needed.

Remote transport loss shows Reconnecting… while the connection retries. A window
opened while its host is down, or one that lost its host, reads everything it shows
again once the connection is ready. Certificate
or authority changes show Unavailable. A revoked credential shows Access revoked
and cannot issue further content commands. A locked or unreadable credential
leaves its connection unavailable without blocking the personal Space. These
states never request an application relaunch. The personal Core retains its
existing recovery and fatal-authority policies.

## Remote Desktop capabilities

Team Spaces support Library Pages, live collaborative Documents, Databases with
Boards and Lists, authenticated attachment/image uploads and reads, Inbox reads,
person message edits and replies, Keep/Delete/state/kind/importance actions,
Accept, Problem retry and Activity reads. Attachment bytes pass through the
remote client's authenticated blob boundary; the Desktop does not interpret a
server path as a local file. HTML File previews use the same Space's authenticated
content resolver and isolated preview grants.

Agent execution, Nodex, Source producers, Automations and schedulers belong to the team
host. Start requires an available execution host; remote conversation surfaces
cannot acquire the personal peer socket. Filesystem surfaces, Terminal,
Git review, Workspaces and Project source editing are hidden or explain that
they need a filesystem on the Space host. Automations and Plugins destinations are
hidden for a team connection. Transport admission alone does not enable a
Desktop producer or execution Runtime.

Core owns each Member's View preferences, collapsed occurrences, Session unread, chat
pins and their order, chat reminders,
“Let Nodex start chats for me” consent, notification reads and claims, and retained recovery
drafts. The same Member sees this state on every enrolled device. Core derives
the Member from the authenticated principal; clients cannot select another person.
Viewport positions, window and Workbench layouts, and local journals of unsent
edits remain on the device, qualified by Space and Member. Recovery journals send
retained edits to that Member's Core recovery queue when connected. Desktop
settings and operating-system integrations remain device-wide: keyboard shortcuts,
dictation, window state and product analytics work the same in a team window.
A team window never reads the desktop's own Agents, accounts or native chats, such
as composer skills, MCP servers, usage or the Computer Use picture-in-picture. So it
leaves out what only they offer: the rail's Codex account, Plugins and Insights, Run
setup again, the `/mcp` command, and Agent sign-in or setup in a chat's notices, which
instead say Agents for this Space run on its host. Settings for Agents, Models, Hooks,
Sources and the other host-owned features say why they are unavailable, as a restored
Plugins or Insights route does. What a team window shows of a setting or default is the
host's: the Inbox reads what its suggestions and new chats run on from the host, with only
the Member's own consent to start their requests from Core, and leaves a choice out until
the host has answered. General settings leave out chat titles and predictions, which only
this desktop's own Agents use. Reloading a hosted chat's skills reloads its host's
catalog. An interactive response in a hosted chat shows as unavailable rather than
starting this computer's sandbox, and its sends never check this computer's Windows
sandbox. Nothing a team window offers fails after a click or loads forever.

The shared host kernel owns the Coordinator, Work and Inbox dispatch, Sources,
Automations, execution holds and notification intents. Main embeds it for the personal
Space; `nodex serve` embeds it for a headless team Space. A team desktop never
acquires those producers. See [Hosting a team Space](../team-space-hosting.md).

When the execution host is available, Start sends the Page to that host. Accept
and Pause/Resume remain person commands to the team Core; the host reacts to
committed work and hold state. Missing host availability keeps Start disabled.
Inbox decisions also travel to the host from a desktop or phone: Start chat,
accepting a suggestion, choosing an existing chat to send to, asking for or
stopping a suggestion, and retrying a delivery. The host resolves the Agent from
its own catalog and confirms with the requesting Member's authority, so the chat
answers to them.
Open Nodex opens the host's Coordinator conversation. The provider picker reads
the host's catalog and configured instances, using the host's own credentials;
desktop provider settings cannot select a host executable.

Hosted conversation reads and text replies travel through the selected Space's
authenticated Core connection to its execution owner. They never use the
desktop's local Codex peer. Core checks the Member again before returning the
response and supplies a short-lived invocation proof for person-authored
mutations. Device revocation retires the call's authority. The execution owner
continues to prove the Session's Runtime binding.

A team desktop and a phone send to a hosted chat through the same host owner,
which delivers the Member's message as a local chat would: it starts a Run,
waits behind the active one (Queue) or redirects it (Steer). Queued replies can
be edited, sent now, reordered or removed. A hosted Run presents nothing in the
desktop window, so a reply carries no presentation. A desktop reply carries what a
local chat's does: text, the Agent, model and mode choices, referenced Pages and
other context, and attached images and files. Images are fitted as for a local
chat, then every image and file, including a file dragged in or mentioned from this
computer, is saved to the Library as the Member and sent as that Library File; the
host reads it with the Member's authority. A folder, or more than 12 files in one
message, is refused before anything uploads, as is a file beyond the chat's size
limits. A hosted chat's permissions
are the host's execution authority, so its Composer shows no permissions control.
Plan mode is a choice for the next message: the Composer shows it selected until
the chat runs in it, and the message carries it to the host. Archived chats ask
to be restored first.
Inbox and unread reads retain the requesting Member through the host. Chat
questions may be answered by their captured requesting Member, and execution
approvals by the Page Owner; an enrolled device alone does not grant that right.

Hosted transcripts refresh bounded snapshots from targeted Session invalidations,
with a fifteen-second repair while visible and at most eight observed chats per renderer. Live event
streaming and native filesystem panels are not available through this route. Text viewing, replying and answering pending
questions use the existing conversation interface. What the host does not take
from a Member's Device stays out of the desktop: a hosted chat offers no retry of a
failed worktree preparation, which says why instead. Whoever may stop a hosted
chat's work (see below) stops its Run, its background work and its subagents one at a
time or all at once; every Member reads a background task's output. For anyone else
the lists offer no Stop, and the Composer's Stop stays in place, unavailable, saying
"Only the person who started this, or a Space Owner, can stop it." in its tooltip and
to assistive technology. Typing `@` completes Pages, subagents and chats. A team
window's chat pickers and command palette search through the host, as a local window
searches its own chats: the host reads the chats the Member may read, with their
authority and their own pins and unread state, ranks them by title and details and
then by message history, and returns a bounded result drawn from their 1,000 most
recent chats. The host's workspace is not on this computer, so `@` completes no file
there. Typing `$` completes the skills the host's Agents report, read
through the host, never this computer's.
Images in a hosted transcript show as they do in a local chat: a photo a phone sent,
a picture an Agent viewed, generated or attached, a tool's image and an image a Markdown
reply names. The desktop reads each from the host as the Member, in bounded ranges, and
draws only bytes that are a PNG, JPEG, GIF or WebP picture. A reply's picture is read
from the host's file only while that reply names it, and a path a hosted transcript
names is never read from this computer. A subagent's
conversation opens beside its parent from the same Session reads as the chat itself.
A message another conversation sent reads “Sent by” that conversation's current title,
as do “Answered by” and “Forked from”: the host names it with the Member's authority,
and the credit opens it.

A Member does in a hosted chat what they can do in a local chat, through the host
and with their own authority. Core decides from its own records, by one rule, who may
change what the chat shares, when the call is admitted, delivered and used:

- **Starting.** A Member starts a new chat, with or without a Project, as on their own
  desktop: New chat opens a draft of their own, which no other Member lists or starts,
  and its first message starts it on the host with their authority. A phone starts one
  the same way. A chat without a Project runs in the host's tasks directory; one in a
  Project runs where the host runs that Project, in its checkout or in a new worktree
  the host prepares from the branch its checkout is on. Its location names the Space.
- **Chat owner.** A hosted chat belongs to the Member who started it, a fork or side
  chat to the Member who opened it. A chat Core has no such record for belongs to
  whoever asked for its first Run, otherwise to the Owner of the Page whose work it
  is. Replying never makes anyone else its owner: when Bob replies in Alice's chat, it
  stays Alice's.
- **Managing.** The chat owner and every Space Owner rename it, archive and restore it,
  move it to another Project, compact it with `/compact`, clear its context with
  `/clear`, continue a reply that outgrew its context with Compact and retry, and
  bring a fork or side chat back with `/merge`, from a desktop or a phone.
- **Stopping.** The Member who asked for a Run stops it, its subagents and its
  delegated and background tasks, as do the chat owner and every Space Owner. Each
  subagent and task answers for the Run that started it, whichever Run is current: a
  subagent of Bob's earlier Run stays Bob's to stop after Alice asks the chat for more,
  and Bob can no longer interrupt Alice's Run. Work whose Run is unknown stops only for
  the chat owner and Space Owners. Each row offers Stop by its own answer.

Session reads tell each reader whether they may manage the chat and stop its current
work, so a desktop and a phone offer only what Core allows. The rest is each Member's:

- **Fork.** Any Member who can read a hosted chat forks it, from its menu, a turn or
  `/fork`. The host creates the fork as a new hosted chat the forking Member owns, in
  the same directory or in a new worktree the host prepares; a worktree environment
  chosen on the desktop does not apply.
- **Side chat.** Any Member who may reply to a hosted chat opens a side chat of it,
  which they own. It persists across closing its tab and restarting, as any Agent Runtime
  side chat does. A Member deletes only their own side chat, through the Space host,
  which retires its execution. An archived chat takes no new side chat.
- **Edit message.** A Member edits a message they sent, while no other Member has
  posted after it; a message waiting in the queue counts. Otherwise their message
  shows Edit unavailable with "Someone else has replied since", and another
  Member's message offers no Edit. Which messages offer Edit follows the chat as it
  changes, so a chat the Member just started offers it once its first Run ends, without
  reopening. The edit rewinds the chat to that message as a local edit does, so a reply
  arriving before the host carries it out ends the edit.

A hosted chat's title, archive state and Project are shared by every Member. The host
carries each change with that Member's authority; for anyone who may not manage the
chat, its header, sidebar rows, sidebar menu, command palette, shortcuts, `/compact`,
`/clear`, `/merge` and Compact and retry leave these controls out, and Data controls
lists only the archived chats the reader may restore, with no permanent deletion.
Every Member pins, orders and sets reminders for any hosted chat, as their own
attention: other Members' sidebars and reminders stay as they are. Archiving a chat ends
every Member's attention to it, as it does for a chat on a personal desktop: its pins,
reminders and unread state go, and restoring it brings none of them back. Managed by Nodex
and Section placement are not available for hosted chats on a team desktop. Mark as
read or unread remains.

Canceled requests retain their remote session. Concurrent losses of the same
connection share a replacement. A pinned Device renewal that proves withdrawal
fences that Space immediately; later failures cannot downgrade Access revoked.

The Automations manager remains hidden in team Spaces. Its desktop manager
combines configuration, execution, run navigation and local Workspace choices;
it does not expose a separate read-only list. Core still admits Member Automation
reads and applies its exact Owner authorization for mode changes. Automation facts
remain visible in Activity, with host-only Automation navigation unavailable. Automation-only
and Run-only commits refresh that Space's Inbox and Activity. Starting a held Automation decision requires an available execution host; person
actions such as skipping remain available. Personal Automation event broadcasts
never enter a team renderer.

Event Automation filters and their Source picker are host-only, including when an
editor is restored from a saved route. They do not fetch Source options in a
team Space. Recent Automation decisions keep the same Space as the editor; Coordinator
assessment tools and assessment delivery run only on the Space's host.

## Actors and personal attention

Every committed mutation names its Actor. Desktop and local CLI actions name the
local Member; HTTPS actions name the authenticated Member. Verified Agent work
names its Session and optional Run on behalf of the Page Owner or requesting
Member. A personal Space supplies its local Member when work has no separate
requester. Host producers name the Service performing the work, such as Sources or
Automations; Nodex's own services, starting work a person set to Start automatically and
routing the Inbox, read as Nodex, as their chat messages do (`Sent by Nodex`). A
standing grant identifies its authorizing Member separately.
History and Activity display attribution relative to the requesting Member:
“by You”, “by Alice”, “by Codex on behalf of Alice”, or “by GitHub”. A chat
started automatically reads “on your request” to the Member who asked for it and
“on Alice’s request” to everyone else. Stored reasons never say “you”: a card a
person moved by hand reads “A person moved it” to every reader.
“You” is only ever how a reader sees their own Member; no stored Member name
may be “You”. A Space's local Owner starts with the name its OS account gives
its person, or the one chosen with `nodex serve init --owner-name`. Each
Member renames themselves in Settings → Spaces → People or with `nodex space
display-name NAME`; a host's local Owner uses `nodex serve display-name NAME`.
Join a Space explains a refused name beside the field instead of failing to join.
A handoff records its dispatching Member, Agent or Service separately from the
receiving Agent's assignment and the Agent shown in Turn while the work runs.

A Member sees their own person Turns and answers in Inbox. Intake is shared with
Members of its capture scope; Automation decisions remain addressed to their Owner.
Questions address the Member whose accepted message started that Run, falling
back to the Page Owner. Notification intents and claims belong to that recipient.
Accepting or replying to another Member's Turn is refused.

“Let Nodex start chats for me” is a Member's consent. Automatic routing requires the author
of every request in the proposal to have granted it; one person's setting cannot
authorize another person's request. Automatic proposals carry one Member's grant;
a proposal combining authors requires confirmation. Source and Agent origins do not gain consent
merely by arriving through the same channel as a person's message.

View preferences, collapsed occurrences, Session unread state, chat pins and
reminders, and recovery drafts belong to a Member. The Space host delivers each
Member's due reminders by turning the chat unread for that Member only. These routes are available over HTTPS with the Member key
derived from the principal. Shared View definitions and Session lifecycle remain
shared. Existing personal state belongs to the local Member after migration.

### Operation refusal and temporary capacity

A Member's refused action stays local to that action. A denied answer, revision
conflict, stale fence or capacity refusal leaves the Space connected. Only Core's
pinned Device-renewal response can prove that a Device is unknown or revoked, or
its Member removed, and show Access revoked. Temporary capacity retains pending
edits and operation identity while honoring Core's retry delay. Background hosted
chat refreshes retain the loaded transcript, Composer and unsent draft.
