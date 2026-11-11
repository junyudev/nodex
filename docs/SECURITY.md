# Security

## Profile and execution identity

Nodex has one local user per current Profile. An authenticated connection can
read and mutate every resource in that Profile's Library. Project is execution
and presentation routing; it does not restrict content access. Plan mode changes
how an Agent plans work and adds no content permission boundary.

Core verifies Profile, Library, Store epoch, connection and exact captured
execution identity before an Agent operation. A later foreground Run cannot
supply an earlier caller's identity. Background and child work keep their own
captured identity when a foreground parent completes. Cancellation, native
Scope exit, generation retirement and Session lifecycle invalidate the affected
lease. Parent relationships do not confer or limit content access.
When a native transport provides no causal Run evidence, Core admits its exact
Session connection lifetime separately from Run admission. Run remains absent;
there is no synthetic Run or latest-foreground lookup. A retired incarnation
cannot be rebound or reactivated, including by replaying an earlier admission.

Agent shell routing belongs to the launching Desktop's Profile. Its environment
composer replaces inherited Nodex routing and exported CLI functions, unwraps
outer Nodex startup wrappers to the recorded user files, and restores its own
routing after user startup. Launching Nodex inside another Agent shell must not
route the inner Agent's CLI to the outer Profile. See [Agent shell routing](CLI.md#agent-shell-routing).

## Team transport threat model

HTTPS adds untrusted network peers and potentially hostile Members to the local
Profile boundary. Core itself verifies membership even behind a reverse proxy.
The network listener cannot authenticate with `core.auth`, impersonate Electron
Host/Test, issue Agent attribution, or select maintenance execution priority.
Private local IPC keeps its existing bearer plus OS-user checks. Owner-only
operations require the active local Owner; own-Device operations honor the local
Member.

Remote access is independent of team membership. A personal Space can expose its
Owner's Device sessions without adding another Member. The personal Remote access
listener explicitly admits private, loopback, CGNAT and link-local peers before
TLS admission. Operator-managed `serve` and `nodex-core --listen` retain their own policy;
choosing an operator listener is an explicit local action.

| Remote administration command                             | Admitted person                       | Enforcement                                                                             |
| --------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| Invite, Members, rename, remove Member                    | Owner                                 | Core membership read; writes recheck current session and role inside writer transaction |
| Devices                                                   | Every Member, own Devices; Owner, all | Core query scoped by Space and current Member/role                                      |
| Link Device                                               | Every Member, own identity only       | Writer binds Member, checks session, cap and offer rate                                 |
| Revoke Device                                             | Member, own Device; Owner, any        | Writer rechecks session, role and target ownership; withdraws live connections          |
| Remote access state                                       | Authenticated Member                  | Explicit remote route admission; contains no private key                                |
| Listener start/stop, certificates/keys, backups, shutdown | Local Host only                       | Default-deny remote frontier and local Owner checks                                     |

Administrative writes seal T1 Member Actors in LocalCommit evidence. A stale role
or revoked session fails again after writer queueing. Form factor is metadata,
never a distinct authority. Devices are scoped to `(Space, Member)`; revocation
never withdraws that person's enrollments in another Space.

A Device-link offer is an authenticated Member's five-minute, one-time enrollment
of their own Member. It contains Space display identity, pin, reachable routes,
code and expiry; only a hash of the code is stored. It reserves capacity under
the 16-Device cap and has a durable six-per-hour Member rate limit, including
consumed offers. Redemption rechecks expiry, active membership, role and Device
capacity atomically, creates only a Device, and consumes the code. New-Member
invites remain Owner-only. Codes and credentials are never URL parameters.

Device withdrawal also retires that Member's outstanding Device-link offers,
preventing re-entry through a previously minted self-link code. Owner-issued
invitations retain their existing grant policy. A Device's self-revocation
command may finish a fixed acknowledgement on a closing socket; this grants no
further content access. Codes issued by other Members and other enrolled Devices
remain valid.

A remote handshake requires a device session and the existing generation,
transport, event, Store and Module compatibility negotiation. Every admitted
request binds Space, Member, Device, Session and role into trusted Module context.
Semantic admission uses an explicit remote command allowlist. Source commands,
native execution bindings, Runner administration, backups, restore and maintenance stay
host-only. Receipt admission checks the initiating Member, including exact retries and
explicit resolution. Physical connection and session identities do not change
the operation identity.
Revocation is checked on new requests, at the durable writer boundary, and every
second while responses remain open. Library blobs and all SSE routes share this
boundary. A reverse proxy must forward HTTPS without substituting a local Host
capability or buffering SSE.

The Owner supplies the HTTPS URL, certificate fingerprint and one-time enrollment
code through an authenticated channel. The client pins SHA-256 of the complete
leaf DER certificate before HTTP receives the TLS socket, including enrollment
and session requests. It never accepts a replacement certificate automatically.
Self-signed certificates need no public CA. Generated keys live privately under
`<Profile>/team-transport/`; operator PEM keys must also be private, owned regular
files. Remote responses never publish the local socket or administration bearer.

Invites, device credentials and session tokens contain 256 random bits. Core
stores SHA-256 hashes in separate invite, device and session tables, never the
bearer secrets; high-entropy credentials do not use human-password hashing.
Authentication verifies stored hashes with constant-time comparison. Codes are
one-time and expire after 24 hours. Sessions expire after an hour; devices can
renew, and revocation invalidates every session for the Device. Do not place
credentials, enrollment codes or tokens in URLs, logs or diagnostics. A Desktop
integration must store device credentials through its native private credential
storage; the transport adapter holds secrets only in memory and supplies no
plaintext persistence fallback.

Network work has a 240-per-minute pre-authentication IP admission window, and
per-Member and per-Device request/byte budgets. TLS acceptance and credential
attempts spend pre-authentication admission; already authenticated requests and
handshakes do not spend or consult that IP window. Desktops behind one NAT retain
their independent authenticated budgets. Only pinned device-credential renewal
may return typed access-withdrawal evidence; per-operation authorization refusals
use HTTP 403 with no withdrawal recovery and cannot revoke a Desktop connection.
Administration preserves writer-time renewal evidence when a queued session or
role becomes stale. Revoking a Device withdraws only that Device's sessions;
other Devices of the same Member retain their authority. Device-link rate
refusals carry `member_device_links` retry evidence and a `Retry-After` header.
The authenticated minute windows admit up to 1,200 requests and 32 MiB per Device,
and 2,400 requests and 64 MiB per Member, including refused semantic commands. A
Desktop opening a Space measured 530–600 requests in its first minute and under 100
per minute while editing; the Device window admits two openings, and the Member
window a Desktop and a phone together.
Local Owner transport diagnostics expose each request/byte window's peaks and
refusals, route totals and the exact admission dimension of each refusal, without
credentials. HTTP 429 includes that typed dimension and `Retry-After`. Admission still has
bounded queues, connection and stream caps, bounded body reads, TLS/header
handshake deadlines and slow-reader write timeouts. These controls protect local
administration and interactive execution capacity. They do not constitute a
filesystem sandbox or a disk-storage quota.

Hosted conversation access uses an explicit semantic relay through Core. Its
generation-local queue holds at most 32 calls, each with a 25-second lifetime,
at most 1 MiB of input and 16 MiB of output. Only the local execution owner may
poll and complete calls. Registration replaces the previous relay generation
and retires its outstanding invocation proofs. Core rechecks membership before
delivery and response publication. A remote Member cannot register a Host,
forge its invocation header or select an administration operation. A hosted
reply names its images and files only as Library Files the Member saved over their
own authenticated connection, at most 12 per message; no Device path, image bytes
or local Agent configuration path crosses the relay. The host reads each File
through Core with the Member's invocation before the Runtime receives a private
copy, so the Library's read rules and the Member's revocation apply to it. A
desktop uploads only the files its person attached or mentioned, opening regular
files without following links and refusing folders.

A hosted chat's attachments are read through one host owner, shared by the relay and
the phone façade. A read names a Session, item and attachment identity from the
transcript, never a host path; the Runtime resolves it within that Session's visible
history and its own attachment store, opening only regular files without following
links. Before every range the owner reads the chat through Core with the Member's
invocation, so Core's Session read rules, Device revocation and Member removal apply
mid-download, and it refuses outright without a Member invocation. Each range is at
most 1 MiB, pinned to the version of the first, and counts against the Device and
Member byte budgets. The owner names a picture's type from its leading bytes and
reports any other bytes claiming an image type as opaque. A desktop draws only a
whole PNG, JPEG, GIF or WebP picture, never one larger than a chat can hold, reads
at most two at a time and keeps them only in that Space's renderer cache.

A desktop's connected Codex conversation can name any file as a picture, so the same
owner serves such a picture to the phone only as a picture. It reads the item again
from the conversation the chat is bound to, identified by its Run, takes the bytes
from the conversation itself or from that file through the execution host that ran
it, and refuses anything over 10 MiB or whose leading bytes are not a PNG, JPEG, GIF
or WebP picture. A hosted Space has no connected conversations, so the owner reads
none there.

Person-authored hosted commands retain the Core-admitted Member. An accepted
chat-message mutation additionally requires the exact live Session and message
identity from its delivery request. Core decides each hosted chat action from its own
Store when the call is admitted, when it is delivered and whenever its invocation
reaches Core; the call's JSON only names the chats. A fork requires a chat of the
Member's Space, and the new chat's Agent Runtime binding is admitted only with the
live fork call's exact Session and launch identity, so the forking Member owns it. A
side chat requires a chat the Member may reply to, and its binding the live call's
exact source chat as well. A side chat persists when its tab closes. A Member deletes
only their own side chat, through the Space host, which retires its execution. Core
requires the live side-chat delete invocation for that exact Session, refuses direct
Member deletion without it, and rechecks ownership in its writer transaction.
An edit rewrites only the requesting Member's own message: Core knows each Run's opening
message from the Runtime's attribution, and refuses the edit, and the rewritten
message's acceptance, once any other Member's message was accepted after it. A Member's Inbox decision, including one that
starts a chat, is admitted only with a live invocation proof from the Space host,
which resolves its Agent from the host's catalog; Core refuses it on the Member's
own HTTPS connection. Delivering the confirmed chat remains Host-only work. The proof expires when the call settles;
it never grants general Host or Agent attribution authority.
Core derives the Actor from that verified Member rather than the relay's local
connection. Agent credential issuance binds the Run to its Runtime-verified input message
and Core's accepted Member evidence, including queued work; later messages
cannot change that delegation. Shared
producer writes retain their Service Actor. Automatic Nodex bootstrap records
the local operator's authorization separately from Service authorship.
Hosted Inbox, Turn attention and
unread reads use the requesting Member. Answers require the captured question
recipient, while execution approvals require the Page Owner. Core checks this
entitlement before queueing, at delivery and when the invocation accesses Core;
the Runtime separately verifies the original pending request before dispatch.

A chat's shared state changes only for its owner or a Space Owner: its title, archive
state and Project, its compacted or cleared context, including Compact and retry, and
merging it back. Stopping a Run's work, its background tasks and subagents included,
also belongs to that Run's requester. A relayed stop names the Run whose work it is, and the
host's Runtime stops only a subagent, delegated or background task that Run started, so a
Member cannot reach another Run's work by naming their own; work whose Run is unknown stops
only for the chat owner and Space Owners. Ownership comes from Core's own record of who
started the chat, never from who replied last, so a reply grants no management. One
Core rule answers every check: Core's writer for every Member command, whether it
arrives over the Member's HTTPS connection or carried by the Space host with their
invocation proof, and the host relay for each relayed call's exact Session and Run,
from a desktop or a phone, before delivering it and whenever that invocation reaches
Core, each after rechecking the Member's current session and the Owner's role. The local
Profile and verified Agent work keep their own authority. Session reads tell each reader
whether they may manage the chat and stop its work, so clients never derive the rule.

Host administration secrets are owner-only: the Core bearer, server private key,
and Store containing credential hashes must retain private native ownership and
permissions. Core protects SQLite’s write-ahead log and shared-memory file when
it opens the Store. Host admission verifies those files and refuses broader permissions
or aliases without silently repairing them. Agent processes receive a scrubbed
environment; host capability variables, shell injection variables and Core home
paths are excluded. The headless CLI shell bootstrap skips host-account startup
files and replaces the native shell environment table after filtering configured
entries. Explicit provider credentials remain provider capabilities.

The headless host encrypts sensitive settings with authenticated AES-256-GCM.
Its private `settings.key` remains in the Core home and is checked with the other
administration material. Nodex sets native owner-only permissions before writing
a new key and before publishing Host status. The key never travels into the
execution home or Agent environment. This protects persisted settings from
accidental disclosure. An account that can read both key and ciphertext can
decrypt them. Desktop settings continue to use the operating system's credential
encryption.

A configured `agentRunner` wraps execution using a trusted executable and argv;
the host never parses its launcher as shell code. Separate OS identity is optional.
Beyond numeric loopback, host admission requires `agentRunner` or explicit
`--allow-same-user-agents` acknowledgement. Same-user execution must carry a warning
in logs and host status. Mode bits and environment scrubbing do not isolate native
code running as Core's OS user: it can discover and read that user's private files.
Use a dedicated host account and a separate Runner identity for OS isolation.

The loopback Agent content audience is shared by Desktop and the headless Host.
It bounds requests and forwards an allowlist of content routes with a Native CLI
connection, Core-issued attribution and a caller-selected Project in the same
Profile. Caller-supplied connection, execution-priority and attribution headers
are discarded. Administration, enrollment, Host handshake, maintenance and
credential issuance are refused. The shell receives no private Core socket,
bearer or launch authority. Treat Pages, repository content, attachments
and provider output as untrusted instructions, never membership authority.
See [Team Space behavior](product-specs/team-space-behavior.md).

## Mutation audit identity

Core derives Actors from authenticated Member bindings, verified Agent execution,
or an admitted Host producer. Command JSON cannot choose an actor. An invalid
Agent credential refuses the request; it cannot fall back to a local person's
identity. Agent launches require the Core-issued credential before exposing CLI
access. An Agent records its Session, optional Run and the Member it represents.
Its authority is exactly that Member's: Core refuses an Agent what only another Member
may do, such as changing another Owner's Automation set to Run, and admits what the
represented Member may. How an Agent should use that authority belongs to its
instructions, not to refusals.
Schedulers and Automation admission retain the authorizing Member separately from the
Service that executes the grant.

LocalCommit integrity binds the actor and grant identity. Durable mutation audit
records survive delivery-window collection. File versions, Page attachments,
Document history and Activity use this same identity. Intake origin and channel
remain separate evidence. Personal View preferences, recovery drafts, unread
state, routing consent and notifications are admitted and projected for the
requesting Member. A remote caller cannot supply another Member's personal key.

## History and resource lifecycle

History replay validates current owner identity, resource lifecycle, schema,
Document heads and revision preconditions before comparing retained witnesses.
References and Relations never transfer ownership. Missing, deleted and
cross-Library targets remain unavailable; malformed storage fails closed.
Opaque Relation edge handles are bound to their source membership and Property.
Clear-all retains its explicit value-revision fence. Relation previews report
physically unavailable targets without returning nonexistent metadata.

## LocalCommit delivery integrity

Core seals semantic effects, typed atoms, Document resources and projection
coordinates into one transaction-owned LocalCommit. Packet integrity covers the
exact delivery address, Manifest, complete atom/resource coverage and projection
effects. Project addresses route presentation updates; they are not resource
permission scopes. Main and renderer validate packets mechanically and never
rewrite canonical payloads.

Owned renderer frames acquire bounded address leases. Disconnect, recipient
release, Store replacement and transport gaps fence stale delivery and require
canonical repair. Cache freshness follows resource generations, semantic
revisions and exact projection coordinates. Global replay sequence is progress,
not a substitute for a resource revision.

## Page-key lookup

Page keys are locators rather than secrets. Core resolves current and historical
aliases within the current Library and validates physical Page lifecycle before
returning metadata. Prefix creation and rename enforce Library-wide uniqueness
in the transaction. Mutations use canonical Page UUIDs and ETag/CAS guards;
an alias never replaces a receipt or execution identity.

## Threat Model

Nodex is local-first. Main risks are malformed local inputs, accidental data loss, renderer capability abuse, and stale or incorrectly attributed Agent execution. Native execution follows each chat's permission mode: narrower modes keep the Agent inside its workspace boundary and route native permission requests to the person, while Full access requires explicit confirmation. Agents can never answer execution approvals, and delegated work cannot exceed its caller's mode. Content access through Nodex tools is Profile-wide in every mode; connection and execution identity remain enforced.

Personal listener intent has one Core-owned private Profile configuration owner.
Desktop settings and native CLI commands share it. Listener status exposes only
public intent and live routes; selected certificate/key paths stay private.
Operator listener configuration remains separate. Core restores saved personal
intent during startup; Desktop adds no listener or restoration owner.

## Phone access

Phones are independent Devices of a Member in one Space, with the same authority
as that Member's desktop. Core's pinned-TLS listener is their only ingress. The
host façade accepts Core-issued invocation proof and never derives identity from
phone JSON or substitutes a local Host bearer. See
[ADR 0084](adr/0084-phones-as-member-devices.md).

- **Enrollment.** A Device-link offer is bound to the requesting Member, expires
  after five minutes and is consumed once in Core's writer transaction. The
  versioned QR/link carries Space identity, routes, certificate fingerprint,
  code and expiry. Whoever holds a live offer can enroll that Member's Device;
  offers and credentials must not enter logs or broadcasts.
- **TLS.** Native HTTPS/WSS checks SHA-256 of the complete leaf certificate DER,
  in constant time, before sending application bytes. TLS 1.2 is the minimum;
  each operation has its own TLS session, without resumption. System trust or
  SPKI does not substitute for the matching leaf pin. Redirects, cookies and
  ambient credentials are disabled; cancellation belongs to the owning Effect
  Scope.
- **Platform policy.** The pin alone admits a host, so a self-signed host is
  reachable at LAN, tailnet or DNS addresses on iOS and Android. The pinned
  transport bypasses each platform's URL loading stack by design: on iOS it is
  Network.framework, which App Transport Security does not evaluate, and ATS stays
  at `NSAllowsLocalNetworking` for every other connection the app makes, with no
  arbitrary-loads or per-domain exception. Android's custom trust manager and
  hostname policy belong only to its pinned clients.
- **Credentials.** Each `(Space, Member)` enrollment has its own Device credential,
  kept in SecureStore with device-only accessibility. Sessions renew at Core's
  existing Device frontier. No phone credential migration or plaintext fallback
  exists. Android backup remains disabled.
- **Admission and withdrawal.** Core authenticates the WebSocket upgrade and
  meters bounded frames, requests, concurrent streams and bytes under Device and
  Member budgets. Device revocation or Member removal closes live streams.
  Semantic writes recheck current membership and Device authority; a queued
  request cannot outlive withdrawal by borrowing Host authority.
- **Member scope.** The façade uses the requesting Member's Actors, Inbox,
  attention, unread state and answer entitlement. Unsupported operations return
  typed unavailable capabilities. There is no fallback to a personal Runtime or
  another Space's filesystem or credentials.
- **Files.** File references are opaque, never caller-selected host paths. Reads
  and uploads stay within the admitted Space and bounded channel lifetime. A chat's
  attachments use the same Member-invoked host owner as a team desktop.
- **Local state.** Caches, drafts and capture delivery are keyed by `(Space,
  Member)`. An old Member's queued capture cannot be delivered through a new
  Member's enrollment. Local removal and remote revocation are distinct; neither
  promises remote erasure of downloaded content.
- **Notifications.** Core stores each phone Device's push registration: an opaque
  relay handle, a 32-byte key and two preferences. Only that Device's own live
  `push.register` or `push.unregister` request can set or clear it; the host
  relays the request but cannot choose the Device, handle or key. Device listings
  expose only whether notifications are on, and revocation or Member removal
  drops the registration. Core resolves each event's recipient with its
  answer-entitlement rule, so a Member's phone is told only about requests that
  Member may answer, Runs that Member requested and Page Turns that are that Member's
  move. Only the local host may list every Member's current Turns, and Core names a
  Turn's Member only while its episode is current. The host seals each payload
  with ChaCha20-Poly1305 under that Device's key and a fresh nonce; the relay can
  read neither the chat content nor the enrollment, and the host never learns the
  phone's push address. Secret prompts are omitted even from the sealed payload.
- **Presence.** A desktop's presence report is its own Device session's statement
  about its own person: only how long ago the computer was used, or that it is
  locked. It can only hold back that Member's own phone notifications, never
  another's. Core keeps one report per Device in memory with a 90-second lifetime,
  rechecks the Device, session and Member whenever the host reads it, and serves it
  only under the local host lease.

Configuration, native limits and proof workflow live in the
[Mobile transport documentation](../packages/mobile/README.md#pinned-tls-capability).

## Mobile Push Relay

The hosted relay accepts only Nodex's two iOS bundle IDs. Its AES-256-GCM handles hide device tokens
from Space hosts and authenticate the token, environment and bundle ID together. A handle is a bearer
capability to send to that phone; it must stay private. The relay sees the device token while routing
to APNs, but never receives the key that decrypts notification content. APNs receives a placeholder
alert and opaque ciphertext. There is no relay database or retained device registration.

Request and APNs payload byte limits apply before delivery. Relay logs contain only status and
recognized APNs reason codes; tokens, handles, ciphertext and raw upstream errors are excluded.
The relay has no account authentication or per-device rate limit. Rotating its seal key invalidates
every existing handle. See the [relay contract and secret setup](../packages/push-relay/README.md).

## Library File boundaries

The Library owns File metadata, lifecycle and immutable versions. A Page owns
only its optional path entries and canonical body uses. Current presentation,
Canvas slots, history and recovery resolve their exact File identities and
captured versions. Core rejects missing, deleted and cross-Library references.
A URI or Blob hash exposes no host path and is not an authenticated connection.

Prepared upload receipts bind Store, operation, size and expiry and are consumed
atomically with File and relationship writes. Logical paths reject absolute
paths, traversal, reserved names, controls and normalization collisions. Desktop
import accepts regular files, rejects symlinks and special nodes and preserves
its bounded per-File and batch limits. Save destinations never reinterpret a
Page logical path as a host filesystem path.

Managed content remains inert except for HTML, CSS and JavaScript in the isolated,
offline Page File preview guest. Native execution requires explicit materialization
in a workspace. Backup restore hashes managed bytes before publication; collection
is serialized with snapshots. Queued and submitted conversation inputs retain exact
bytes independently of a source File and are read through the authenticated
Profile and exact execution identity boundary.

## Offline Page File HTML previews

Main admits a preview only for a current File related to its Page and identified
as HTML by recorded MIME or its logical path. Each admission has a random
`nodex-page-file://<grant>/<logical-path>` origin, a fresh non-persistent Session,
and one owning window/renderer generation. The application renderer receives only
an ephemeral URL and partition claim. Main validates that claim at attachment;
DOM attributes never grant authority. Reports have no preload, Node, application
bridge, native tools, nested webviews, permissions, popups or downloads.

The guest loads the original document. Relative URLs resolve within that Page's
explicit File entries through Core, including ordinary parent-directory URL
resolution within the Page namespace. A body-only document uses its default name
and has no siblings. There is no Library-wide lookup, arbitrary File-id lookup,
default-name fallback, descendant Page access or directory listing. Core
revalidates current Page membership and exact File version on each request, and
Main rejects entries replaced during byte reads. Recorded MIME and `nosniff`
prevent a filename from upgrading bytes into executable HTML.

Offline access is enforced twice: every response carries an immutable header CSP
restricting scripts, styles and connections to the exact guest origin (with local
image/font/media data or blob exceptions), and the Session request gate cancels
all other origins and schemes, including localhost, HTTP(S), WebSockets, host
files, application resources and other grants. Non-proxied WebRTC UDP is disabled;
a fixed unreachable proxy without direct or loopback bypass blocks TURN TCP and
speculative connections, which bypass the request gate. Main verifies proxy
resolution before admitting a guest. DNS prefetch is disabled. Frames, workers,
objects, base URLs and form submissions are denied. The application renderer can
embed the guest scheme but cannot fetch it. A credential-free HTTP(S) link can open in the
system browser only after single-use native input in that exact guest.

Only GET/HEAD reads are served. Paths decode once and reject encoded separators,
backslashes, empty/dot segments and portable-path limit violations before Core
resolution. HTML is limited to 5,000,000 bytes; each other resource to 64 MiB;
each admission to 256 MiB, 2,000 requests and eight concurrent reads. Responses
are never cached. Release, owner navigation or renderer loss, Store replacement
and application shutdown revoke admission and interrupt pending reads. Closing a
preview discards its origin storage; a later preview always gets a fresh Session.
JavaScript can still consume CPU/memory or display deceptive report content.

## GitHub Source credentials

Source configuration requires the active local Owner, or an Agent acting for them
through the trusted Desktop Host's tools. Core accepts polling commands only from the
trusted Desktop Host without Agent identity. Polling leases, ingestion and
failure/success recording are Host producer commands.
Remote Members and Owners can read Sources, positions, threads, Triggers, problems
and known pull requests, but cannot issue any Source command. CLI and Agent reads
expose public configuration and observations, never credentials.
Remote authors and remote text cannot change Source policy or authorize work.

Main obtains a token only through `gh auth token --hostname <host> --user <login>`
for the selected account, with GitHub token environment overrides and debug output
disabled. A missing selected login never falls back to another account. The
initial connection may use the active CLI account, which is verified through
GitHub before its login and stable id are saved. Every poll re-verifies that
identity under a host-pinned redacted credential. Core stores the CLI reference,
verified account and observation data; tokens, process stdout/stderr and token
fingerprints are never persisted or sent to the renderer. Credential failures
retain only a categorical reason. Only same-host HTTPS API pagination is accepted.
GitHub Source ingestion performs read-only network operations.

## Agent CLI attribution

A provider shell resolves the Host-managed `nodex` command at invocation time.
The dispatcher reads a private, atomically replaced binding for its Session or
native task. Each CLI process presents that Turn's gateway grant for its whole
invocation. The gateway rechecks the exact execution before forwarding and
retires the previous grant when a Turn replaces it. Calls between Turns fail.
Claude and locally launched OpenCode pin the shell to the originating Run
before it can spawn a background job. Codex's shell environment identifies
the task only. Its dispatcher's lifetime check applies to the CLI process, so a
new CLI invocation from an earlier Turn's detached shell can acquire the
current grant while a later Turn of the same task is active. Core still
attributes the operation to that Session and its eligible Member. Native Codex
CLI grants are Session-scoped and carry no Run ID. With no active Turn, the
gateway refuses the call. Process ancestry cannot establish a Turn after the
operating system reparents a detached shell.
The Host can reconnect and obtain new Core credentials for the same live Run
after a Core restart if the Profile, Library and Store epoch still match. An
invocation already connected to the old generation must reconnect explicitly
so that a changed generation cannot silently replay a write.

Only the authenticated Host can request Core attribution. Core verifies the
current Session and derives the Agent Actor and its requesting Member. The
Runtime records its proven Run and, when available, the exact accepted input
during Turn preparation. This binds the requesting Member and preserves message
editing and Run ownership even when the Agent makes no CLI calls.
The gateway keeps Core’s signed credential private and refreshes it during
long Turns. An invalid managed binding fails closed for the Host's Profile.
An explicit `--home` or `NODEX_HOME` selecting another Profile uses that Profile's
ordinary local Member connection, which `nodex context` reports. A new development
Host and its Core start independently of the launching Agent’s shell binding.
A local shell shares its operating-system account’s access. Managed routing
provides attribution, and removing it drops Agent authorship.

## Security Controls in Place

### Dependency maintenance

- Dependabot maintains npm, Cargo, and pinned GitHub Actions dependencies weekly.
  npm security fixes are grouped into one reviewed pull request. Security updates
  remain independent of the version-update schedule.
- The `dependency-security` CI group runs `vp pm audit --level low` against the
  complete JavaScript lockfile, including development and optional dependencies.
  Manifest, lockfile, package-manager configuration, and override changes select
  this required gate even when combined with application source edits. Nightly
  CI and release certification also audit the complete graph against current
  registry advisories. Registry failures fail the check; audits never rewrite
  manifests or lockfiles.
- Upgrade the owning direct dependency first. Use a scoped, compatible override
  when its transitive dependency has a fix that upstream has not adopted yet;
  retain the upstream contract and verify affected runtime behavior. Do not
  force an unrelated major version solely to make an advisory disappear.
- Any accepted advisory must be individually identified in the audit ignore
  configuration and documented here with its dependency path, exposure rationale,
  and reassessment trigger. Development-only status or lack of a published fix
  alone is not sufficient grounds for an exception.
- [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) is accepted
  for `sprintf-js@1.1.3` through Electron Builder's optional
  `@electron/get@3.1.0 → global-agent@3.0.0 → roarr@2.15.4` build dependency.
  The advisory requires an attacker-controlled numeric precision format;
  this proxy logger uses static message formats and serializes remote URLs,
  response headers, and errors as context. Nodex does not ship this chain in
  application runtime dependencies. No patched release is available. Reassess
  and remove the exception when upstream supplies a compatible fix or removes
  this chain; review it before changing the logger's message construction or
  adding `sprintf-js` to runtime dependencies.

### Release supply chain

- Pull-request CI has only `contents: read`, does not bind a GitHub environment,
  and never maps Apple, Sentry, Homebrew, Skills, or landing credentials. Fork
  pull requests do not receive repository secrets; changes to same-repository
  workflow files therefore require the same security review as application
  code with a release capability.
- Derived build resources are generated in the checked-out runner workspace and
  are not committed back to Dependabot or other pull-request branches. No
  privileged `pull_request_target` materializer is needed to make dependency
  checks pass.
- Every scheduled, dispatched, or reusable exact-source release job is dominated
  by the secret-free `release-source` environment and one shared provenance
  guard before it checks out or executes that source. The environment admits
  only protected-branch workflow definitions; the guard accepts only an
  immutable full SHA reachable from protected `main` with a successful `Main
  CI` push run. Stable promotion admits an immutable Nightly from a successful
  protected-main run. The Release Module checks retained build bytes against
  the published Nightly digests before entering the signing environments.
- Release credentials use dedicated repository Action secrets and explicit,
  named `workflow_call.secrets` mappings. Lowercase reusable-workflow aliases
  prevent environment-secret precedence from changing the transport contract;
  broad `secrets: inherit` is not used. Secret-consuming jobs remain separated
  by protected environments for deployment policy and audit. Credentials are
  mapped only onto the steps that need them, and the temporary Apple API key is
  removed in an always-run cleanup step.
- Scheduled Nightly resolution remains read-only and accepts only the exact
  protected-main HEAD whose latest `Main CI` push run for that SHA succeeded.
  Unrelated commits and manual workflow runs cannot supply this admission.
  Nightly distribution uses
  the same Developer ID, notarization, Sparkle key, macOS arm64 Bundle,
  and immutable-asset verification chain as Stable, but its promotion path has
  no Homebrew or official Agent Skills credential. The landing credential can
  change only `updates/nightly/`; Stable publication owns only
  `updates/stable/` under the shared site-publication lock.
- Nightly retention is a separate fail-closed capability. Scheduled runs have
  read-only permissions and produce plans only. Deletion requires manual
  dispatch plus the protected `nightly-retention` environment, and selects only
  old immutable Nightly prereleases after protecting both live appcasts and
  matching the downloaded Release Bundle index to every remote asset digest.
- Sparkle 2.9.4 is pinned by official archive URL, byte size, SHA-256, source
  revision, framework identity, architectures, and license digest. Production
  packages remove its sandbox-only XPC services, sign the addon and remaining
  nested code inside-out without Electron JIT entitlements, and bind their
  identities into package provenance. The Ed25519 public key is reviewed source;
  the private key is available only to protected
  `sparkle-feed-finalization` jobs and is streamed to official tools over
  standard input. Top-level Release, Nightly and Rehearsal jobs bind that
  environment directly; reusable native-build and Bundle-assembly workflows
  never receive the key. Repository guards reject reusable-workflow transport
  or references outside those protected finalizers. The key is never written
  to an Action artifact, cache, manifest, Pages repository, or log. Before
  signing release assets, the finalizer signs
  a local sentinel and independently verifies it with the reviewed public key;
  the extracted App's `SUPublicEDKey` and sealed runtime manifest must carry
  that same key.
- Every external GitHub Action is pinned to a full commit SHA. Checkout does not
  persist credentials. Repository Actions default permissions remain read-only;
  write authority is granted only to the promotion job.
- Release assets are selected from the verified Release Bundle allowlist. Tag
  creation is exact-SHA and tag-last; tag conflicts, draft digest conflicts, or
  a non-immutable published release stop promotion. Published assets are never
  overwritten.
- Signed appcasts use immutable version-tag enclosure URLs and are published to
  Pages only after every GitHub Release asset has been re-downloaded and
  byte-verified. Pages publication rejects version rollback and same-version
  byte drift; ordinary site deployments preserve existing feeds. Delta history
  accepts only immutable GitHub Releases whose tag resolves to the Release
  Bundle source SHA. The App Team ID is pinned to `8HGUT3HC4Z`, and appcast XML
  enclosure URLs, sizes, signatures, versions, and delta sources must exactly
  match each architecture update manifest.
- Browser runtime publishing requires a reviewed release lock, proves both
  architecture archives' names, sizes, digests, manifests, target identities,
  and complete artifact closures before upload, resumes only drafts whose
  existing assets exactly match that lock, forces `--latest=false`, and verifies
  that the stable app Latest tag remains unchanged.

### Application and runtime controls

- Document dependency discovery exposes only the verified bundled Node and Python closure.
  Pinned archives and wheels are hash-checked before atomic staging; packaged Python and
  native extensions are signed and their manifest is resealed before the outer app signature.
  Main rejects mismatched platforms, altered artifacts and symlinked runtime paths. It never
  installs packages or substitutes system runtimes during discovery. Python import isolation
  is not a sandbox; Agent execution runs with full native access as the current user.

- Provider instance configuration, including decrypted environment secrets, reaches the Agent
  Runtime only as the first frame on its private stdin pipe. It never enters the execution
  process's arguments or environment, which is exactly the launch environment Main composes
  rather than an extension of Main's own.

- The Agent Runtime makes network requests only through the configured providers and the
  tools Agents invoke. It reports execution facts to the Desktop Host over its private pipe and has
  no analytics network path of its own, and its model manifest ships with each
  release instead of being fetched or cached from a remote source. It never writes Git refs or
  commits into a user's repository for its own bookkeeping.

- Native Claude Code instances run user-managed executables through the official Agent SDK.
  Inherited user/project/local settings may execute hooks, skills, subagents, and MCP servers as the
  current user. Nodex starts Claude Code in the permission mode of the chat and routes native
  authorization requests to the person outside Full access; genuine information questions remain interactive. The optional account config directory changes only the
  child/worker environment. Existing Claude credentials are never copied into Nodex settings. Explicit instance environment
  secrets use OS-backed encryption, with immutable ciphertext outside ordinary settings and references
  published only after encryption and storage succeed. Settings reads never return secret plaintext;
  retaining a secret requires the same instance and variable name. Only Main's launch read decrypts
  values, shared by the new connection's history worker and child process. Encryption failure has no
  plaintext fallback. Reserved account-location and nesting variables remain launcher-owned. Main's
  HOME and environment remain unchanged. SDK requests retain exact native Session
  and process-generation correlation and remain bounded.
  Cancellation or connection closure retires their source; foreground completion does not
  revoke live background work. Renderer answers address only the original information request.
  Native tools use the same current-Profile application capabilities across providers.

- Native OpenCode instances use a user-managed executable and the pinned SDK transport.
  Each local connection has an isolated native profile and Thread-scoped server; provider
  credentials and history stay in that profile. Profile-owned environment variables are
  launcher-controlled, inherited OpenCode configuration and authentication overrides are removed,
  and explicit environment secrets follow the same encrypted-reference contract as Claude.
  Native repository configuration and plugins execute inside the local-code trust boundary.
  External HTTP(S) servers are explicit instance configuration, receive only explicit server
  credentials, and never receive Nodex application-tool leases. Native permission rules follow the chat's permission mode. Information-question replies
  address only the exact pending request in the owning Session or proven descendant.
  Discovery and session restoration resolve the exact workspace and configured native owner;
  a missing session or changed profile cannot silently create a replacement conversation.

- ACP instances launch explicitly selected Registry software or a user-managed executable and
  individual arguments. Logical Agent definitions identify software; they are not launch allowlists
  or supply-chain attestations. Registry installs use private owned staging, concrete versions,
  bounded downloads and extraction, atomic publication and installation receipts. Receipts distinguish
  upstream checksums from locally recorded byte digests; neither a top-level package version nor
  npm registry integrity metadata attests an immutable installed dependency closure. Local executables
  remain user-managed and are never deleted by Registry uninstall. Nodex-distributed dependencies
  retain their separate locked artifact and release-verification contract. See [ADR 0071](adr/0071-configured-acp-agents-and-explicit-management.md).
  Main is the sole owner of configuration and encrypted environment references; Runtime holds
  decrypted launch configuration only in memory and rejects configuration persistence through its
  settings writer. The selected credential and proxy policies bound environment inheritance, and
  unsupported ACP client capabilities remain unadvertised. Advertised filesystem callbacks
  resolve exact paths with bounded reads and writes under the native connection lifetime;
  Project roots are execution locations rather than filesystem permission scopes. Advertised
  terminals share the supervised Agent Runtime, bounded output, cwd and Session lifetime; outside
  Full access a terminal starts only after its command is approved. Standard ACP application calls retain
  their exact Session identity with unknown Run left null, and cancellation closes that source.
  Whoever can replace the configured package or executable is inside this local-code trust boundary.
  Setup and terminal flows have trusted window ownership, bounded redacted output and cancellation;
  stale answers cannot complete a replacement flow. Native-history mappings retain a non-secret
  source identity so account or storage changes cannot reconnect a reused native ID to the wrong chat.

- Boundary validation for typed Core Module and IPC requests.
- Managed-worktree workers accept only operation-discriminated requests and
  events whose host id, managed root, worktree path, and cwd form one contained
  execution location. Equivalent filesystem spellings never relax lexical
  containment: Main preserves Core's coherent path pair and explicitly
  reprojects its writable roots on resume. Replacing a Project's primary source
  with a worktree removes the old checkout from writable roots; additional
  authorized roots remain explicit.
- SSH execution hosts are explicit Main-owned configuration and never carry a
  password, private key, identity-file path, or shell fragment. Connections use
  the user's OpenSSH agent/config with `BatchMode`, normal host-key verification,
  bounded connect/request timeouts, and disabled forwarding. Main validates host
  identities and POSIX roots before registration, probes Node/Git/Codex, and
  exposes no host capability until a content-hashed, dependency-contained
  worktree worker is installed atomically with private permissions. Remote
  commands are fixed argv encoded for the remote login shell; prompts, branch
  names, and arbitrary renderer strings never become commands. Cross-host file
  transfer uses stdin/stdout, regular-file and authorized-root checks, byte
  bounds, SHA-256 verification, private staging directories, and atomic rename.
  A disconnected SSH mutation is reported as unknown/reconcilable rather than
  assumed absent or repeated. Local filesystem APIs never inspect a remote path.
- No arbitrary SQL inspection route in IPC or the public CLI.
- Offline Profile cloning accepts only an evidence-backed, assets-inclusive
  published Core backup with a current or exact supported predecessor Store and
  a nonexistent target home. It rejects symlinks and source/target ancestry,
  verifies copied database and asset-tree digests in a private sibling
  staging directory, preserves the imported Store lineage, and remints
  Profile-instance secrets before the target becomes visible. It never copies
  Agent credentials. Development launches sourced from a real Profile disable
  remote observability by default so snapshot content remains local unless a
  developer explicitly uses another tool to export it.
- The production app renderer loads only through the privileged
  `app://-/index.html` origin and receives its CSP from the built renderer HTML;
  development admits only the exact configured Vite origin and receives its CSP
  from the development server. The top-level
  BrowserWindow is sandboxed with context isolation and no Node integration.
  Its preload has no Node imports, and privileged IPC requires both an owned
  top-level window and the exact app origin.
- Electron preload bridge limits renderer access to a typed API surface.
- The canonical application BrowserWindow uses its final sandboxed preload from first paint, but
  preload presence does not confer authority. Before Core acquisition, Main registers only
  initialization wait/replay, renderer-ready reporting, close-flush acknowledgement, and restart;
  every handler requires the trusted top-level app origin and an attached Window Session. Popup
  creation is denied, navigation is restricted to the configured renderer origin, and webview
  attachment is denied until post-Core activation installs the full guest authorization boundary.
- MCP App HTML never executes in the app renderer and is never injected through
  `srcDoc`. The trusted renderer deterministically derives the stable source and
  non-persistent partition from the fixed app/server scope, installs the port
  handshake listener, and only then assigns a random init id in the webview URL
  hash. Main validates the exact source/partition/init tuple during
  `will-attach-webview`, binds a 30-second pending attachment to the owner and
  Electron Session, and consumes it at `did-attach-webview` by Session, owner,
  and init id. When Electron has not published the guest URL yet, Main consumes
  the first pending record for that Session and owner in attachment order.
  MCP authority never depends on a claim IPC or Electron's internal webview
  instance id. Main strips renderer-authored preferences and forces the fixed
  guest preload,
  sandboxing, context isolation, no Node, no nested webviews, and no insecure
  content.
  The isolated session denies every permission and download, blocks popups and
  unexpected main-frame navigation or privileged subframe navigation, rejects
  non-GET sandbox asset loads, strips
  unauthorized response headers, and applies a coarse protocol/host request
  gate. Skybridge compiles the resource metadata CSP for the inner untrusted
  iframe. Guest-to-owner capability transfer accepts the real
  Skybridge `{ ports, replyPort }` shape, extracts only the exact enumerated
  MessagePort set, and forwards it through a process-wide guest registry. After
  initialization, business RPC travels directly over MessagePorts; guest
  preload exposes neither Electron IPC nor Node to widget JavaScript.
- MCP App proxy authority is fixed to the owning thread and server. Tool calls
  resolve the latest server status for every call/list operation; Codex Apps
  remain within the origin tool's trusted connector or target while ordinary
  MCP servers remain within their fixed server. Resource reads from Codex Apps
  require the exact origin widget URI, subscriptions are unsupported, and file
  parameters cannot enlarge scope. Widget follow-ups use the existing
  owning-thread action, while external links are bounded credential-free HTTPS
  URLs. Runtime errors expose sanitized errors without stacks.
- Native menu paste reads are Main-owned, bounded, materialized observations of
  one pasteboard generation; a generation change rejects the whole read. Keyboard
  paste uses only its captured event data and Files, with existing File-object
  path inspection. No synchronous clipboard IPC or later native read can add
  authority to that event. Renderer code cannot request arbitrary native formats
  or arbitrary filesystem metadata through the preload.
- Background Electron network requests without a WebContents continue without a
  client certificate. They must not silently disclose a platform certificate;
  this policy does not change Browser page certificate selection.
- Structural editor copy writes bounded HTML/plain presentation plus an opaque
  capability envelope through trusted Main IPC. The owned snapshot stays in
  Core. Paste verifies the Profile, Library, Store epoch, manifest hash,
  capability hash, execution lifetime, target head, payload size, Block
  count, and nesting depth before it may create an owner; malformed or foreign
  envelopes have no owner-creation authority.
- Imported and pasted rich-document structure remains untrusted after transport
  validation. Table row, column, span, header, and total occupancy dimensions
  are bounded before editor materialization, and Markdown block structure is
  tokenized with linear scans instead of backtracking over document-provided
  delimiters.
- Built-in Browser guests are accepted only from a registered top-level app
  window whose Window Session, complete Browser route, storage identity, renderer
  instance, host generation, and mount generation all match. The partition
  carries the untrusted route claim; Main matches it to its registered host and
  takes the storage identity from that registration rather than trusting custom
  DOM attributes, which Electron does not expose as attachment parameters. Main
  strips renderer-authored preload/web preferences and forces sandboxing,
  context isolation, no Node in frames/workers, no nested
  webviews/plugins/insecure content, one fixed guest preload, and the shared
  persistent Browser Profile in the effective `webPreferences.partition`.
  Main correlates Electron's attach `instanceId`/`viewInstanceId` pair and
  activates ownership during `did-attach-webview`, before accepting any
  renderer host acknowledgement or guest preload message. Guest preload
  messages are enumerated and rebound to that registered guest route; remote
  pages receive no Node, filesystem, arbitrary IPC/invoke, or credential
  capability.
- Browser navigation has distinct entry-point policies. Ordinary user and trusted
  application loads pass their URL directly to Chromium, with empty tabs represented
  by `about:blank`; they have no universal scheme, userinfo, or URL-length filter.
  Address input normalization belongs to the address bar. Explicit external opening
  accepts HTTP(S), file, mailto, sms, tel, supported VS Code links and the narrowly
  validated password-manager broker URL. Error-page external opening accepts HTTPS
  and local HTTP and requires the current tab failure. Link context-menu Browser
  choices accept HTTP(S). Popups deny `other` and open other dispositions in Browser
  tabs, preserving background selection and opener placement.
- `open_in_nodex` lets an Agent show the user HTTP(S) URLs and existing files on this
  device in a Session's Browser, without a user gesture. A page it opens runs in the
  same sandboxed guest as any other Browser page, so a local file carries no more
  authority than a web page the Agent could already open. The tool does not give the
  Agent the page: Browser Use control below stays limited to HTTP(S). Remote Sessions
  cannot open local files, and network-share file URLs are refused.
- Browser Use claims and current-page assertions activate a per-page navigation
  restriction. Explicit navigation, page navigation/redirect hooks and Session
  main-frame/subframe requests admit HTTP(S) or exact `about:blank` while control is
  active; subframes additionally admit `data:`, `about:blank` and `about:srcdoc`.
  Claiming a page first validates its current URL. Release, deactivation and reset
  clear the restriction. Blocked navigation is reported to the controlling Agent.
  Origin approval rules remain separate; a non-origin URL is not itself an explicit
  origin denial. Session requests also follow managed application network
  requirements: internal/local-content schemes and the exact development renderer
  origin are admitted; an active domain restriction otherwise admits only HTTPS/WSS
  on allowed exact domains.
- Browser permissions are Main-owned origin decisions shared by ordinary and Agent
  tabs. Browser-default capabilities do not prompt; sensitive capabilities publish
  an origin-attributed prompt on the requesting tab. Responses require its current
  owner, renderer and host generations, presented mount, live page and unchanged
  navigation. Allow and block decisions persist privately in the Browser Profile;
  one-time grants expire when the tab leaves its origin or closes. Dismissal does
  not retain a decision. Navigation, guest/renderer loss and teardown dismiss pending
  requests. Site information reports effective permissions and can reset one or all
  decisions for its current origin. Native input activation permits sanitized
  clipboard writes without a prompt; there is no blanket main-frame grant. Device
  and display capture remain blocked without a chooser. macOS camera/microphone
  denial offers the corresponding privacy settings pane; stock Electron exposes
  neither location OS status nor geolocation accuracy selection.
- Ordinary registered-page downloads are allowed without a separate gesture token. Agent-controlled downloads require a
  one-use grant matching the final download URL exactly, valid for ten seconds;
  unmatched downloads do not consume it. Unknown download pages are rejected.
- Browser credentials are encrypted synchronously with Electron `safeStorage`
  in a private Main-owned vault. Renderer results contain summary identity only;
  plaintext is decrypted only for an origin-matched one-use fill command to the
  registered guest and is excluded from Browser snapshots, downloads, history,
  logs, diagnostics, screenshots, and IPC responses. Password save/import is
  disabled when platform encryption is unavailable. Profile import uses the
  signed native helper, canonical bounded read-only source/profile selection,
  temporary copies, explicit data/domain choices, and no intermediate plaintext
  password file. Imports are serialized and revalidate that the selected source
  is still present and closed before spawning a scoped, deadline-bounded helper;
  helper output is size- and schema-bounded. Imported cookies enter only the
  Electron Profile cookie store, and imported passwords enter the same encrypted
  credential mutation authority as interactive saves.
- Browser Use loads only a manifest-verified first-party runtime tuple and exact
  trusted client hashes/paths. Its per-session native pipe is private and
  frame-bounded; every command carries the current Codex session and turn.
  Packaged macOS authorizes the socket peer, parent, and grandparent signing
  chain before reading a frame. Unpackaged development keeps peer verification
  separate from feature availability: its native-pipe directory is owned by the
  current user with mode `0700`, each random per-session socket is mode `0600`,
  and native development code-signing verification is only enabled by the
  explicit `CODEX_BROWSER_USE_PEER_AUTHORIZATION=1` opt-in. Unsupported
  platforms fail closed. The same resolved host capability gates plugin
  installation, thread configuration, and pipe creation, so copied user
  configuration cannot leave a privileged Browser skill enabled without a
  verified host.
  Plugin confirmation and origin policy do not replace Main's independent
  route, navigation, permission, upload/download, and conditional full-CDP
  checks. Site-status blocks only an explicit positive policy result; transport
  failure does not authorize a forbidden scheme or capability.
- The Desktop Tool runtime is one signed third-party closure. Packaging restores
  its complete vendor signature graph after signing the outer Nodex app rather
  than applying the Nodex identity to nested Codex, Node, native addons, or
  Computer Use artifacts. Verification binds every declared artifact and checks
  the Browser peer authorizer and Computer Use helper against their manifest
  signing teams, not the outer app's team. The native PiP and Computer Use
  Platforms accept only the verified absolute addon path and require its actual
  complete export set to equal the sorted manifest contract before exposing any
  capability; ambient resource, generated-output, or home-directory candidates
  are never searched. Native callbacks and window/service registrations are
  scoped and removed before the verified closure is released. The materialized
  local marketplace preserves Browser and Chrome as distinct descriptors even
  though they share the attested Browser client/service. Chrome copies only the
  manifest-selected plugin root and revalidates every declared closure artifact
  before reuse; current provider availability separately controls whether that
  descriptor is installed, and disconnect removes Chrome without removing
  Browser.
- Chrome native messaging installs only the declared host for one of the
  attested browser families and extension IDs. Installation writes the signed
  host plus its bounded versioned registry atomically, preserves unrelated
  registry owners, and refuses malformed or unsafe existing registry files.
  The extension reverse-pipe directory may be current-user private or
  current-user-owned sticky shared storage; every candidate must still be a
  non-symlink Unix socket owned by the current user with no group/world write
  permission, then match the exact attested native-host signing team and
  identifier. The pipe rejects frames above 8 MiB, malformed host-endian
  lengths, and a different extension instance from the one selected for an
  operation. PiP click focus resolves a live Main-owned descriptor before
  targeting the exact instance, session, and numeric tab within one total
  deadline; family-level fallback is not an authorization path.
- Remote Hosted PiP renderer IPC is limited to trusted primary windows owned by
  `WindowRuntime`. Renderers can query a bounded revisioned snapshot, submit one
  task-visibility intent, and report finite bounded geometry; they cannot write
  active-task truth, replace the complete visibility map, register native
  callbacks, or address auxiliary windows. Browser screenshot data remains in
  Main/native boundaries and must pass raster MIME, canonical base64, header,
  dimension, pixel, and process/thread/session retention budgets before native
  decode. Control-surface diagnostics contain no screenshot, URL, prompt,
  title, or raw extension payload.
- Computer Use is fail-closed and architecture-gated. On supported Apple
  silicon macOS, Main copies the verified helper with `ditto --noqtn` into a
  canonical Codex-home location, verifies its deep strict signature, bundle ID,
  signing team, regular executable, and materialization key before atomic swap,
  and rolls back a failed post-swap verification. Unsupported targets never
  install or configure its plugin.
- Desktop Tool `node_repl` runs through a persistent vendor-signed Node process
  and the signed Desktop Tool Codex CLI while Nodex runs its separately pinned
  native Codex app-server. The resulting `node_repl -> codex -> node` ancestry
  satisfies Browser's three-generation peer check, while Codex remains the
  immediate parent required by Computer Use sender authentication. The private
  host-services UDS accepts only `ensureService` for `computer-use`, uses the
  same packaged peer-authorization boundary as Browser Use, and never returns a
  service PID to the plugin. Main reuses a helper only when the PID is live,
  non-zombie, and its native-resolved executable equals the canonical helper.
  Action confirmation remains an app-server elicitation decision; denial and
  native failures are delivered as typed tool errors rather than weakening the
  host boundary.
- For every local provider other than Codex, Agent Runtime launches that same
  signed chain, one REPL per chat, and serves it from its loopback MCP listener
  under the chat's existing credential. No provider holds the REPL's trust
  environment or its host-only lifecycle tool, and a chat's credential cannot
  reach another chat's REPL. Agent Runtime stamps each call with the chat's
  Desktop session and the Run attempt that is running; a call with no running
  Run is refused, and the Browser still rejects any session that does not own
  its route. Permission is the Runtime's own decision, so it holds for Agents
  that never ask before calling a tool: running code asks the person unless
  the chat is in Full access or they allowed JavaScript for the chat, and the
  REPL's own consent requests follow the app-server rules (strict automatic
  review fails closed, Full access accepts only forms with no fields,
  everything else reaches a person). Read-only hints on REPL tools are removed
  before any provider sees them, because the REPL runs arbitrary code. The REPL
  cannot outlive Agent Runtime, even when that process is killed.
- Nodex alone configures the Desktop Tool runtime of its process tree. Another
  desktop host's bindings — the private endpoints, executor identities,
  verifying keys, and trust roots it publishes to its own processes — are
  dropped by ownership from every ambient environment Nodex admits (the launch
  environment at Main bootstrap and the login-shell snapshot), whether or not
  their endpoint is still live; the bootstrap log records only their names.
  `node_repl` runs in a closed environment: its server definition pins command,
  arguments, enablement, and an empty forwarding list, and the launcher keeps
  only the Desktop Tool variables Nodex declares and pins the sandbox shell
  policy, so server-environment and shell-policy entries another host
  persisted in the shared Codex home cannot add or replace them. Exact binding
  names, not namespaces, guard user-facing shells, which keep unrelated
  third-party variables. The Browser conformance probe runs under a hostile
  shared Codex home and foreign launch bindings.
- Computer Use settings are a typed Main-only capability. Renderer code cannot
  read arbitrary App Group files or invoke `defaults`/the nested installer.
  Main validates bounded approval identifiers and declared sound modes, writes
  approvals atomically with private file permissions, fails Locked Use closed
  when config requirements disallow it, and resolves the installer only below
  the verified canonical helper app.
- Workspace-file IPC is available only to the top-level renderer frame of an owned app window. Directory browsing accepts canonical root-relative coordinates, verifies lexical and resolved-realpath containment, and omits directory symlinks that escape the selected root. Exact-file existence/metadata/text/binary reads accept an absolute path and explicit host without a Project-root grant so agent outputs remain openable outside the active source; this relies on the trusted-renderer boundary rather than path sandboxing. Remote reads use only the selected native connection, reject results after its generation or capability source epoch retires, enforce decoded byte budgets, and never interpret remote paths through local IO. Directory browsing, writes, save-copy, and watches accept only the local host. Bounded raster previews become ephemeral `blob:` URLs and renderer cleanup revokes them. PDF bytes are transferred to the bundled PDF.js worker as a `Uint8Array`; canvas, selectable text, and annotation links are rendered in app-owned DOM without iframe navigation, form rendering, or embedded script execution. PDF external links cross a top-level trusted-renderer IPC that accepts only bounded, credential-free HTTP(S) URLs before Main calls the system browser. Write requests use an expected-modification-time CAS guard and never create missing parent directories implicitly.
- Renderer file references use a semantic Workbench router: ordinary references enter the validated Files surface, while explicit external/reveal actions use typed IPC. Local references are never opened through renderer-created `file://` windows or a document-wide link capture handler; bounded copy-contents actions still go through the existing `read-file` IPC budget.
- Managed-asset mutation, byte reads, bounded previews, path resolution, and dictation IPC are likewise available only to the top-level frame of an owned app window and validate payload types and byte budgets again in Main. Temporary `nodex://assets/<safe-name>` locators resolve only in the Profile media cache and do not expose the Core Blob root. Durable File and Thread bytes use their authenticated Profile read boundary. File clipboard exports use a validated File source and exact version on every materialization; Main places verified bytes in `cache/file-exports`, never returns a Core Blob path, and does not treat a cache hit as authority. The trusted renderer resolves a managed locator to an absolute path through the synchronous preload capability and uses the shared `app://fs/@fs/...` display transport; successful resolutions are cached only for the renderer window lifetime. Remote-host catalog images use separate opaque, Main-issued `app://fs/host/<asset-id>` capabilities; renderer code cannot choose a host or filesystem path, and Main authorizes only absolute image paths discovered through the native catalog. The `app://fs/*` request gate admits the `app://-` renderer and the exact configured HTTP(S) development origin, excluding the Browser-sidebar partition. It uses Chromium's request-bound initiator origin when present, so initial navigation and redirects retain their original authority; browser-started requests without an initiator require a trusted frame. The handler accepts extension-addressed image, audio, and video MIME families, follows filesystem symlinks, and does not grant renderer script code a general file-read IPC capability. Production CSP admits `app:` for image and media elements and the exact `app://fs` origin for Fetch. The scheme enables CORS and filesystem responses grant anonymous cross-origin reads only to the trusted renderer or exact development origin, allowing image decoding and canvas export without admitting untrusted frames. The handler rejects non-regular files. CSP does not admit `file:`.
- Electron bootstrap fixes Rust Core as the only production authority before
  store startup; the retired selector and JavaScript SQLite/Yjs implementation
  are absent. Native launch validates a regular, executable,
  non-symlinked Core binary, then trusts readiness only after the existing
  descriptor, capability, local endpoint, and handshake checks succeed; failed startup
  never falls back to another authority.
- Store preparation never restores JavaScript storage authority. Core accepts
  only an empty Store, the exact current catalog identity, or an exact declared
  migration source. Unknown revisions, future revisions, non-empty
  revision-zero databases, physical drift, and semantic corruption fail before
  backup or mutation. A supported predecessor is protected by a
  content-addressed SQLite Online Backup whose ancestry and regular-file type
  are validated without following symlinks; the native forward step then runs
  in one SQLite write transaction and must pass exact current validation before
  readiness. The package contains no migration sidecar or executable override
  path.
- Store Administration accepts no filesystem path or Project identity from its
  caller. Core derives bounded backup, staging, cleanup, and restore paths from
  validated operation/Backup identities; every traversed entry must remain a
  regular owned file or directory. A create receipt commits before publication,
  delete/prune cleanup moves only validated Backup directories into an
  operation-owned staging root, and restore retains the single fsynced Store
  replacement journal. Exact retries verify the Core-authored intent hash and
  original Manifest before completing any pending filesystem phase.
- The native Core runtime validates the Profile and runtime ancestry without
  following filesystem aliases. Unix uses current-user ownership, `0700`
  directories and `0600` files and sockets. Windows uses current-user owner SID,
  protected user-only DACLs, and reparse-point refusal, including junctions. Only
  an acquired lifetime lock authorizes stale Unix socket removal. Windows creates
  a new unguessable pipe name for each generation; no stale pipe name is reused.
  Cleanup remains fenced by the exact start nonce and validated owned targets.
- Windows Core pipes use an exclusive first instance, reject remote clients and
  grant access only to the current user SID. Core checks the kernel-reported client
  PID and process-token user SID before HTTP admission. Native clients verify the
  server PID against the descriptor and its process-token user SID. Pipe-name
  validation accepts only the exact local `nodex-core` grammar; bearer authentication
  and generation-bound connection registration remain mandatory.
- Profile clone coordination uses a private `ipc/clone.json` rendezvous with a
  bounded endpoint, server PID and random capability. Its versioned protocol
  authenticates acquisition before granting a connection-bound idle snapshot
  window. It accepts no executable, capture path or content. Unix uses a private
  socket; Windows uses a separate random pipe. Node cannot set an explicit pipe
  DACL, so the Windows endpoint depends on its unguessable name, user-only
  rendezvous DACL and capability authentication. The native client also verifies
  the server process identity. Release or disconnect resumes the source; native
  capture still requires independent writer fencing and consistency checks.
- Core lifecycle diagnostics use the same private runtime ancestry and atomic
  regular-file publication rules. The fixed-size `lifecycle.json` breadcrumb
  contains only bounded generation identity, phase, typed drain reason, and
  stop outcome. It never contains the bearer capability, endpoint, request
  payload, SQL, Document bytes, or user content; a symlink, unsafe mode, or
  malformed prior file disables only the breadcrumb.
- Main fatal incidents are independent of verbose logging and optional telemetry.
  Their Profile-owned `diagnostics/fatal` directories require current-user ownership,
  `0700` mode and real directories; records are atomically published as private `0600`
  files with bounded size and retention. The projection allowlists error classifications,
  operations, generation identity, code symbols/coordinates and cleanup counts. It excludes
  raw error messages, custom exception names, arbitrary exception properties, source paths,
  prompts, attachments, request bodies and credentials. Fatal log breadcrumbs retain only
  the bounded projection and incident identity. Remote fatal reporting submits the same projection only
  when diagnostics are enabled. Unsafe storage disables only incident publication.
  On Windows startup only, an unavailable native permissions helper permits a
  separate `diagnostics/startup` record with inherited permissions. Its closed
  projection contains only ID/time, categorical reason, a fixed component executable
  name and numeric/allowlisted loader codes; no full incident, paths, messages,
  frames, environment or content may enter this fallback. Real-directory checks,
  atomic publication and bounded retention still apply. Private publication on
  other platforms and all secret-bearing files remain fail-closed.
- Optional background registration uses a signed nested application and its bundled `SMAppService` LaunchAgent; it never installs a root helper or writes a launchd plist outside the signed bundle. The selected absolute Profile path is the only persisted input, stored as a private regular file below the current user's Application Support directory. The controller rejects symlinked configuration and executable entries, bounds configuration and control output, and executes the fixed sibling Core without a shell.
- Every native-Core HTTP request is authenticated by a fresh per-start
  capability and verified local peer identity. Handshake registers the
  logical connection against the peer's process run (PID and OS start time),
  OS user identity, client build, protocol, Adapter kind, and start nonce; later
  Module, event, and lifecycle requests require that exact connection binding. The only pre-handshake lifecycle exception is
  incompatible-version handoff: it still requires the bearer capability,
  same-user local peer credentials, genuinely disjoint protocol ranges, and an
  exact match for every descriptor-generation identity field, and it can drain
  only an otherwise idle Core. Compatible process reuse requires a live
  authenticated handshake matching the private descriptor. Neither a stale
  descriptor, recycled PID, self-declared build, nor failed/legacy handoff is
  process authority, and the launcher never kills the claimed process.
- The native Core transport rejects declared or streamed body overflow before
  domain decoding. JSON is required to be valid UTF-8 and is bounded by bytes,
  nesting depth, total nodes, array length, object fields, key length, and
  string length; Yjs/Awareness binary frames retain their narrower framing and
  payload bounds. JSON and Document responses are capped independently, while
  SSE remains a bounded-frame stream instead of being buffered as one response.
- Native CLI search never gives ripgrep a database path or a caller-selected
  directory. Core alone assembles authorized snapshot leases below the Profile,
  rejects symlinked or foreign-owned paths, seals directories and files
  current-user read-only, and publishes the manifest last. The CLI revalidates
  lease expiry, types, modes, relative paths, lengths, hashes, and the exact
  manifest before invoking the packaged binary with `--no-config`, a fixed
  snapshot root, no shell, and a closed read-only option set. Logical Page
  titles affect display mapping only and never physical path construction.
- Native CLI drafts use an explicit current-user-owned destination and a fixed
  manifest/base/work layout. Creation stages beside the destination and
  atomically promotes only a complete tree; base evidence and apply markers are
  read-only, while editable files are private. Every read opens with no-follow,
  validates ownership, type, mode, exact entry names, hashes, UTF-8, and byte
  bounds, and rejects symlink traversal or unknown entries. Core receives only
  the selected identities and accepted title/body semantic commands, never a
  filesystem path. Discard has no recursive caller-selected deletion path and
  refuses uncertainty instead of broadening cleanup.
- Native CLI installation never copies an independently updatable executable.
  Homebrew and the app-menu action link to the signed app-bundled CLI. The
  app-menu path validates a regular executable and regular target directory,
  creates only `~/.local/bin/nodex`, refuses non-symlinks and unrelated
  symlinks, and updates an earlier Nodex app symlink through a staged link plus
  rollback. It never edits a shell profile or requests elevated privileges.
- Native Agent Skill setup is a separate global-only managed-link trust
  boundary. Unix uses symlinks; Windows atomically publishes complete directory
  junctions. It accepts only the fixed Codex and Claude Code leaf paths, verifies
  the exact signed-App bundle allowlist and tree digest before classifying any
  target, preflights every selected target, creates links without clobbering,
  and removes only an absolute link to the current verified source. Ordinary
  directories, copies, hardlinks, relative/foreign/broken links, legacy
  `~/.codex` content, unknown parents, and moved-App links are external or
  conflicts and are never adopted, overwritten, followed, or recursively
  removed. No ownership state is stored under `.agents`, `.claude`, a Project,
  or `NODEX_HOME`.
- The official Skill is an instruction Adapter, not an authority grant. Its
  Page, View, search, and error output is untrusted content; prompt text in a
  Page cannot select a Profile, Project, Core capability, database path, raw
  SQL path, or alternate mutation API. Agent interface mismatch and missing
  CLI states stop with upgrade/install guidance. Local Skill discovery never
  makes Nodex data available to a remote Agent or a machine without the local
  CLI/Core.
- Packaged and public Skill distribution is fail-closed. The exporter and
  package verifier require an exact regular-file allowlist, bounded LF UTF-8,
  a matching release manifest, and one stable tree digest. Prepared build and
  signed provenance bind that identity. The `NodexApp/skills` publisher uses a
  dedicated fine-grained PAT scoped only to that repository with Contents
  read/write permission, injected only through a Git config environment header.
  Credentials are rejected in remote URLs and excluded from output, commits,
  and artifacts. Existing tags never move, lower versions cannot replace
  `main`, and branch plus annotated tag publish atomically.
- Stable asset URI scheme avoids embedding brittle absolute local URLs.
- Native provider requests retain exact request and process-generation correlation. Nodex content access does not depend on a Project permission preset.
- Codex user-input auto-resolution never infers or selects an answer. Main may end an inactive ordinary request with the protocol’s empty answer object after the bounded foreground/background timeout; any request-card interaction snoozes that timeout, and explicit renderer submission remains the only path that can send answer content. App-server disconnect clears renderer-memory request drafts and rejects the old inbound generation, so a reused JSON-RPC scalar id cannot recover secret freeform content or receive a late response from the previous process.
- Codex authentication is owned by the selected native Codex home and its app-server auth protocol. Renderer and Core never receive plaintext authentication material, and Nodex does not maintain a parallel store of native Codex credentials. External-agent imports intentionally omit authentication and connection state; each backend must establish those secrets through its own authority boundary.
- The optional Nodex account has a separate Profile-scoped Main owner. Public
  browser OAuth uses S256 PKCE, a random state and a temporary loopback callback.
  Token requests are bounded, reject redirects and remain at the configured
  HTTPS issuer. Only a verified user-info response may establish identity;
  that identity alone supplies no paid-service authority. Trusted renderer IPC
  exposes semantic commands and public snapshots, never tokens or authenticated
  fetch. Credentials use `SecretEncryption` and a private Profile-bound file,
  with no plaintext fallback, provider-home copying or content backup inclusion.
  Cancellation and account changes retire the generation; uncommitted issued
  credentials receive bounded revocation cleanup. Local work does not depend
  on account availability. Per-user gateway keys share the encrypted credential
  envelope and remain private to Main and managed execution. Isolated per-account
  homes and restricted environments prevent reuse of native Agent credentials;
  sign-out closes admission and cancels managed execution before dropping access.
  Direct injection permits only spending that user's prepaid credit; sub2api owns
  remote key revocation and wallet enforcement. See
  [Nodex Account and Model Access](product-specs/nodex-account-and-subscription-behavior.md)
  and [Nodex Account Login](product-specs/nodex-account-login-behavior.md).
- Codex and Claude conversation imports require a trusted renderer, an exact native conversation identity and the previewed canonical history home. Claude sources also retain the selected profile identity. The Runtime verifies the physical source home and copies bounded visible history and supported media into its own store, then continues through its own native conversation. Source execution, native ancestry references, authentication, queues and pending approvals are never adopted. Import failures cannot turn a retained execution binding into an empty new chat. Stable request identities reconcile retries without mutating or deleting source history; a changed captured history prefix is rejected. Completed receipts remain usable without the source.
- Copy setup is a separate trusted-renderer workflow backed by expiring opaque scan ids. It offers configuration and Agent resources without conversation admission. Source homes are canonicalized. Native file copies never replace a target, reject symlinks, stage directory trees before rename, and do not copy SQLite/WAL/SHM files. Config translation allowlists passive settings, removes literal MCP environment/header/token material, and omits authentication, approval, sandbox, and connection state.
- Application tools use a verified Profile connection and captured execution
  identity. Model arguments cannot replace Store epoch, runtime generation or
  Run identity. Every semantic write revalidates lifecycle, ETag/CAS guards,
  schema revisions, prepared footprint and transaction invariants; Project
  routing and Plan mode impose no content access restriction.
- Native Core prepared operations expose no additional private route: prepare
  and execute are typed intents in the owning Module `read/apply` pair. Only an
  Electron-host connection (or the isolated test role) may submit the exact
  persisted Turn provenance. Tokens contain 256 bits of fresh entropy, live for
  at most 60 seconds, are stored only as hashes, are capped globally and per
  connection, and bind request fingerprint, UDS connection, execution
  identity, target footprint, and effect class. Execution acquires one
  in-flight lease inside the writer command and consumes it only after commit;
  rollback releases the lease for a bounded retry, concurrent use fails, and
  store replacement or process restart invalidates every outstanding token.
  Tokens are omitted from logs and durable receipts.
- Native Core JSONL logging accepts only explicit scalar metadata and applies
  the shared sensitive-key redaction and string bound before either sink. It
  records request/connection/Module/receipt/writer/event correlation but never
  request or Document bodies, Yjs/Canvas/Awareness bytes, SQL text or values,
  prepared tokens, bearer capabilities, runtime socket paths, or local source
  paths. Caller-provided connection, operation, receipt, and resource identities
  are logged only as bounded hashes; unknown request paths use a fixed
  `unmatched` label. The log directory and Core segments must be
  current-user-owned regular entries with exact modes 0700 and 0600. Core
  creates and exclusively locks a new Profile-family segment, refuses symlink
  segments, and removes only segments it can lock; an unsafe or failed file sink
  disables itself without weakening Core availability.
- Canvas tombstone compaction accepts no caller-asserted authority or deletion
  set. Core derives exact eligible rows from the current generation, requires
  the inspected head plus a Host-issued all-subscriber write fence, validates
  the bounded scene before and after removal, and publishes the next generation
  atomically with its pinned safety revision, projections, receipt, and event.
  A stale generation cannot submit or replay pre-compaction element intent.
- Canvas presence accepts only a strict 64-KiB engine-discriminated payload,
  finite coordinates, a safe monotonic clock, and at most 256 sorted unique
  selection IDs. The renderer cannot assert collaborator identity: Main
  requires the exact active Canvas subscription and synchronized generation,
  then derives user identity/color from the trusted WebContents target.
  Presence is memory-only, sender-excluded, TTL-bounded, and never reaches Core,
  SQLite, diagnostics bodies, history, receipts, or the durable outbox.
- The authenticated current Profile has full Library content access. Core validates
  exact execution credentials and physical resource lifecycle; Project placement,
  Plan, parent completion and foreground selection do not narrow content access.
  Child and background work retain their captured execution identity. Cancellation,
  native Scope exit, generation retirement and Session archive/delete invalidate it.
  A delayed request cannot borrow a newer foreground Run.
- Structural writes validate source and target in one Library, move the complete
  ownership closure in one deferred-FK transaction, rebuild derived projections,
  require a clean `foreign_key_check`, and publish immutable source/final owner
  members. Prepared operations bind exact request, footprint, head and lifetime
  for transactional correctness. They carry no resource consent or grant policy.
- Store restore changes the epoch and retires prior execution credentials and
  physical runtime connections. Session, launch, logical Automation dispatch and
  execution receipt identities remain stable so an authenticated new connection
  can reconcile prior work without creating a second task.
- Native Module receipt replay follows the same ordering: current store epoch
  and the exact provenance/intent fingerprint must match, but a committed
  operation is returned before a fresh token, current ETag, or current head is
  required. New or colliding operations cannot use that exception.
- Sentry crash reports are on by default in released builds and off in development builds, on CI and under `DO_NOT_TRACK`. They explicitly disable personal, HTTP payload/header/query, AI/MCP content, database payload, queue argument, and stack-variable collection, and scrub local paths, auth/cookie/token fields, prompt text, card descriptions, transcript content, SQL/query strings, and raw request bodies from errors, streamed spans, and envelope trace metadata before upload. Broad remote log shipping is blocked before transport. Session Replay is a separate off-by-default renderer opt-in that requires crash reports to be enabled, masks all text and inputs, blocks media, and keeps screenshots and broad remote log shipping disabled.
- Usage analytics follow [Product Analytics Behavior](product-specs/product-analytics-behavior.md). Main is the only exit. Events decode against a closed catalog at the Main boundary, so content has no field to travel in and a renderer cannot report installation or execution facts. The identity is a random per-Profile ID, never linked to an account. Nothing is sent before the first-launch notice has been on screen long enough to act on, turning analytics off discards anything unsent, and the Statsig client key in the application can only submit events. The service sees the connecting IP address as with any request. Nodex does not use Statsig AutoCapture or Session Replay.
- The bundled Browser automation runtime always starts with its own ambient analytics and diagnostics network disabled. Nodex's telemetry setting never enables that runtime traffic, while page navigation and agent browser control remain available.

### Dictation and microphone controls

- The final signed macOS app carries a microphone usage description and the `com.apple.security.device.audio-input` entitlement. Nested Electron code uses a separate inherit entitlement set with its required runtime allowances but does not inherit microphone authority; native helpers are signed without the Electron runtime entitlements. The staged and final app are both checked; source plist presence is not release evidence.
- Main owns the macOS TCC request. Electron Session policy grants only `mediaType=audio` to an owned top-level renderer at the exact app origin. Camera, guest, subframe, cross-origin, and unowned requests fail closed.
- Dictation IPC requires a trusted owned renderer and validates request identity, audio MIME, payload bounds, history identity, and operation shape. A dedicated streaming RPC port is admitted synchronously only for a trusted main frame of an owned app or global capture window and is bound to that surface. One port grants one Main-owned socket; the renderer cannot supply an endpoint, credentials, request headers, or another surface. Frames and RPC envelopes are bounded, redirects are rejected, and production endpoints require TLS. Shared backend request preparation enforces the primary host's application network requirements against the final routed destination; an enabled policy permits only explicitly allowed exact domains. Invalid or unavailable modern requirements fail closed. Authentication and account-routing headers never leave Main; production renderer CSP grants no external WebSocket origins. Port loss, renderer navigation/teardown, account changes, and application Scope closure revoke pending work and live sockets. Only selected header presence, desktop metadata, HTTP status, and categorical network evidence may enter diagnostics; credentials, account values, routing URLs, raw errors, and response bodies are excluded.
- The global dictation window has a dedicated preload allowlist containing only capture, settings-read, history-write, transcription, a surface-bound streaming-port transfer, Accessibility-settings, and global-session messages. It has no general `window.api`, Core, filesystem, shell, or Workbench capability.
- The signed macOS helper accepts bounded JSON-lines messages, verifies request/protocol shape, and has no auth, history, or clipboard-content logging access. Input Monitoring and Accessibility are independent capabilities. Global paste acts on the application in the foreground at delivery; activation-time foreground metadata is not a target pin. Focus-scoped shortcut capture suspends global bindings and ends on focus loss, navigation, renderer loss, or explicit cancellation.
- Global paste compares the clipboard with its stop-intent fingerprint before mutation. The native adapter retains a bounded all-format snapshot, writes only the finalized transcript plus one trailing space, and restores after paste only while its own text still owns the clipboard. User clipboard changes always win. Accessibility denial can leave a safely copied transcript for explicit manual paste; a changed clipboard is not overwritten.
- Authenticated dictation policy uses account-scoped service requests independently of optional anonymous telemetry. Dictionary mutations retain the original account/user and expected-account header. Backend routing must preserve primary-host network and residency constraints; a verified routing companion uses an ephemeral credential store and scoped temporary home, never token command-line arguments or persistent credential files.
- Dictation history is stored beneath the active Profile in current-user-only directories/files with atomic metadata replacement, bounded audio/transcript sizes, non-path recording identities, and symlink/path-escape rejection. Native Save-dialog export is explicit user action; history files are not Core or conversation authority.
- Logs and remote diagnostics may contain only stable session/attempt identity, surface, gesture, stage, duration/latency/byte counts, stop reason/action, HTTP status, and stable error/native constructor names. Audio, transcript, dictionary content, microphone labels, clipboard content, raw request bodies, and service response bodies are prohibited.

### Insights

Reading provider history needs an explicit per-Profile grant, and withdrawing it deletes the ledger.
The Agent Runtime reads transcripts only for their counts and stores no prompts or content. Its one
network request fetches a public model price table and carries no user, model or usage data. Share
cards are drawn on the device from counts alone, and the card save path comes from a native dialog,
never from the renderer. See [Insights Behavior](product-specs/insights-behavior.md).

## Current Gaps

- Security logging/auditing is still local-first and not audit-grade. Backend logs redact common secret-bearing fields (for example authorization headers, tokens, API keys, passwords, cookies, and session values) before writing JSON-line log records; optional Sentry crash diagnostics are for failure triage, not an audit trail.
- A compromised trusted top-level renderer can request exact local file reads through the workspace-file bridge. Webviews, subframes, and unowned renderer contents are rejected, but process-level renderer isolation is still the confidentiality boundary for these reads.
- Erasure removes content from the live Store; it does not rewrite existing backups, and freed SQLite pages may keep fragments until they are reused or vacuumed. Text already sent to a model runtime cannot be recalled.
- Dynamic-tool receipts support exact retry and recovery. They exclude raw Markdown and body content.

## Safe Operating Practices

- Follow [Dependency maintenance](#dependency-maintenance) when updating dependencies.
- Use manual backups before destructive operations.
- Keep Sparkle and Developer ID private keys in separate encrypted offline
  backups. A gitignored local note is only a convenience copy, not an encrypted
  disaster-recovery backup.

## Hardening Backlog

- Basic security smoke checks in CI for IPC/body limits and absence of SQL inspection routes.
- Stronger native subprocess lifecycle diagnostics without content-access policy.
