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

Nodex is local-first. Main risks are malformed local inputs, accidental data loss, renderer capability abuse, and stale or incorrectly attributed Agent execution. Native execution uses full access and automatically answers controllable permission requests; connection and execution identity remain enforced.

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

Scripts and binaries remain inert managed content. Execution requires explicit
materialization in a workspace. Backup restore hashes managed bytes before
publication; collection is serialized with snapshots. Queued and submitted
conversation inputs retain exact bytes independently of a source File and are
read through the authenticated Profile and exact execution identity boundary.

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
  CI` push run. The privileged release `workflow_run` additionally validates the
  originating repository, protected-main push event, and successful conclusion.
  Release and recovery also require the exact linear parent diff to be a
  metadata-only Release Identity transition.
- Release credentials use dedicated repository Action secrets and explicit,
  named `workflow_call.secrets` mappings. Lowercase reusable-workflow aliases
  prevent environment-secret precedence from changing the transport contract;
  broad `secrets: inherit` is not used. Secret-consuming jobs remain separated
  by protected environments for deployment policy and audit. Credentials are
  mapped only onto the steps that need them, and the temporary Apple API key is
  removed in an always-run cleanup step.
- Scheduled Nightly resolution remains read-only and accepts only the exact
  protected-main HEAD whose latest CI run succeeded. Nightly distribution uses
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
  standard input. Top-level release, rehearsal, and recovery jobs bind that
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
  tools Agents invoke. It sends no product analytics, and its model manifest ships with each
  release instead of being fetched or cached from a remote source. It never writes Git refs or
  commits into a user's repository for its own bookkeeping.

- Native Claude Code instances run user-managed executables through the official Agent SDK.
  Inherited user/project/local settings may execute hooks, skills, subagents, and MCP servers as the
  current user. Nodex starts Claude Code with bypass permissions and automatically approves
  native authorization requests; genuine information questions remain interactive. The optional account config directory changes only the
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
  credentials, and never receive Nodex application-tool leases. Native permission requests are approved automatically. Information-question replies
  address only the exact pending request in the owning Session or proven descendant.
  Discovery and session restoration resolve the exact workspace and configured native owner;
  a missing session or changed profile cannot silently create a replacement conversation.

- ACP Agent definitions are compatibility allowlists, not supply-chain attestations. The current
  Claude Agent integration launches only an explicitly enabled, user-managed absolute package root
  and Node executable after canonical path, entry containment, package/version, executable-version,
  and Node-version checks. The Settings UI states that these checks do not verify package or
  dependency bytes. The selected credential and proxy policies bound environment inheritance, and
  unsupported ACP client capabilities remain unadvertised. Advertised filesystem callbacks
  resolve exact paths with bounded reads and writes under the native connection lifetime;
  Project roots are execution locations rather than filesystem permission scopes. Advertised
  terminals share the supervised Agent Runtime, bounded output, cwd and Session lifetime.
  Native permission requests are approved automatically. Standard ACP application calls retain
  their exact Session identity with unknown Run left null, and cancellation closes that source.
  Whoever can replace the configured package or executable is inside this local-code trust boundary. A future managed ACP distribution must
  use a separate locked archive, verified dependency closure, private immutable staging, and release
  provenance path; npm registry integrity metadata alone cannot attest a mutable installed tree.

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
- Browser address, popup, external-protocol, page-context, and IPC navigation
  all pass the same URL policy. `javascript:`, `data:`, credential-bearing URLs,
  and unknown protocols never reach `loadURL`; external protocols require an
  allowed scheme plus user-owned action. The Browser Profile grants only
  top-frame sanitized clipboard writes by default. Permission check and request
  handlers deny notifications, media, subframes, and all unrecognized
  permissions; downloads require either a user action or an exact short-lived
  Browser Use grant.
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
- Computer Use settings are a typed Main-only capability. Renderer code cannot
  read arbitrary App Group files or invoke `defaults`/the nested installer.
  Main validates bounded approval identifiers and declared sound modes, writes
  approvals atomically with private file permissions, fails Locked Use closed
  when config requirements disallow it, and resolves the installer only below
  the verified canonical helper app.
- Workspace-file IPC is available only to the top-level renderer frame of an owned app window. Directory browsing accepts canonical root-relative coordinates, verifies lexical and resolved-realpath containment, and omits directory symlinks that escape the selected root. Exact-file existence/metadata/text/binary reads accept an absolute path and explicit host without a Project-root grant so agent outputs remain openable outside the active source; this relies on the trusted-renderer boundary rather than path sandboxing. Remote reads use only the selected native connection, reject results after its generation or capability source epoch retires, enforce decoded byte budgets, and never interpret remote paths through local IO. Directory browsing, writes, save-copy, and watches accept only the local host. Bounded raster previews become ephemeral `blob:` URLs and renderer cleanup revokes them. PDF bytes are transferred to the bundled PDF.js worker as a `Uint8Array`; canvas, selectable text, and annotation links are rendered in app-owned DOM without iframe navigation, form rendering, or embedded script execution. PDF external links cross a top-level trusted-renderer IPC that accepts only bounded, credential-free HTTP(S) URLs before Main calls the system browser. Write requests use an expected-modification-time CAS guard and never create missing parent directories implicitly.
- Renderer file references use a semantic Workbench router: ordinary references enter the validated Files surface, while explicit external/reveal actions use typed IPC. Local references are never opened through renderer-created `file://` windows or a document-wide link capture handler; bounded copy-contents actions still go through the existing `read-file` IPC budget.
- Managed-asset mutation, byte reads, bounded previews, path resolution, and dictation IPC are likewise available only to the top-level frame of an owned app window and validate payload types and byte budgets again in Main. Temporary `nodex://assets/<safe-name>` locators resolve only in the Profile media cache and do not expose the Core Blob root. Durable File and Thread bytes use their authenticated Profile read boundary. File clipboard exports use a validated File source and exact version on every materialization; Main places verified bytes in `cache/file-exports`, never returns a Core Blob path, and does not treat a cache hit as authority. The trusted renderer resolves a managed locator to an absolute path through the synchronous preload capability and uses the shared `app://fs/@fs/...` display transport; successful resolutions are cached only for the renderer window lifetime. Remote-host catalog images use separate opaque, Main-issued `app://fs/host/<asset-id>` capabilities; renderer code cannot choose a host or filesystem path, and Main authorizes only absolute image paths discovered through the native catalog. The `app://fs/*` request gate admits the `app://-` renderer and the exact configured HTTP(S) development origin, excluding the Browser-sidebar partition. The handler accepts extension-addressed image, audio, and video MIME families, follows filesystem symlinks, and does not grant renderer script code a general file-read IPC capability. Production CSP admits `app:` for image and media elements and the exact `app://fs` origin for Fetch. The scheme enables CORS and filesystem responses grant anonymous cross-origin reads only to the trusted renderer or exact development origin, allowing image decoding and canvas export without admitting untrusted frames. The handler rejects non-regular files. CSP does not admit `file:`.
- Electron bootstrap fixes Rust Core as the only production authority before
  store startup; the retired selector and JavaScript SQLite/Yjs implementation
  are absent. Native launch validates a regular, executable,
  non-symlinked Core binary, then trusts readiness only after the existing
  descriptor, capability, UDS, and handshake checks succeed; failed startup
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
- The native Core runtime validates the Profile, `run`, and `run/core`
  ancestry without following symlinks; requires current-user ownership; and
  requires 0700 for `run/core` plus 0600 and the expected file type for the
  lock, socket, descriptor, and bearer capability. It removes a stale socket
  only after acquiring the lifetime lock and proving the existing entry is the
  current user's Unix socket. Runtime cleanup similarly removes only the exact
  start-nonce generation after validating every target.
- Profile clone coordination uses a current-user-owned `0700` IPC directory and
  `0600` Unix socket. Its bounded, versioned protocol grants only a connection-bound
  idle Agent snapshot window; it accepts no executable, capture path, credentials,
  or content. The Endpoint supervisor controls only its owned local stdio process,
  preserves active work, and resumes after release or disconnect. Native capture
  still requires its independent writer fence and source consistency checks.
- Core lifecycle diagnostics use the same private runtime ancestry and atomic
  regular-file publication rules. The fixed-size `lifecycle.json` breadcrumb
  contains only bounded generation identity, phase, typed drain reason, and
  stop outcome. It never contains the bearer capability, socket path, request
  payload, SQL, Document bytes, or user content; a symlink, unsafe mode, or
  malformed prior file disables only the breadcrumb.
- Optional background registration uses a signed nested application and its bundled `SMAppService` LaunchAgent; it never installs a root helper or writes a launchd plist outside the signed bundle. The selected absolute Profile path is the only persisted input, stored as a private regular file below the current user's Application Support directory. The controller rejects symlinked configuration and executable entries, bounds configuration and control output, and executes the fixed sibling Core without a shell.
- Every native-Core HTTP request is authenticated by a fresh per-start
  capability and same-UID Unix peer credentials. Handshake registers the
  logical connection against peer PID/UID, client build, protocol, Adapter
  kind, and start nonce; later Module, event, and lifecycle requests require
  that exact connection binding. The only pre-handshake lifecycle exception is
  incompatible-version handoff: it still requires the bearer capability,
  same-UID/PID UDS credentials, genuinely disjoint protocol ranges, and an
  exact match for every descriptor-generation identity field, and it can drain
  only an otherwise idle Core. Compatible process reuse requires a live
  authenticated handshake matching the fixed-path descriptor. Neither a stale
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
- Native Agent Skill setup is a separate global-only, symlink-only trust
  boundary. It accepts only the fixed Codex and Claude Code leaf paths, verifies
  the exact signed-App bundle allowlist and tree digest before classifying any
  target, preflights every selected target, creates links without clobbering,
  and removes only a raw absolute link to the current verified source. Ordinary
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
- Codex authentication is owned by the selected native Codex home and its app-server auth protocol. Renderer and Core never receive plaintext authentication material, and Nodex does not maintain a parallel application credential store. External-agent imports intentionally omit authentication and connection state; each backend must establish those secrets through its own authority boundary.
- External-agent import is an explicit trusted-renderer workflow backed by expiring opaque scan ids. Source homes are canonicalized. Session content is hashed before and immediately before import. Conversations in the active Codex home are explicitly attached through read-only native metadata without changing their IDs; other homes use app-server `thread/fork(path)` to create independent Threads. Attachment failures never delete native history. Import receipts stay in the Nodex Profile. Native file copies never replace a target, reject symlinks, stage directory trees before rename, and do not copy SQLite/WAL/SHM files. Config translation allowlists passive settings, removes literal MCP environment/header/token material, and omits authentication, approval, sandbox, and connection state.
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
- Optional Sentry diagnostics are disabled by default, use `sendDefaultPii: false`, and scrub local paths, auth/cookie/token fields, prompt text, card descriptions, transcript content, SQL/query strings, and raw request bodies before upload. Session Replay is a separate off-by-default renderer opt-in that requires diagnostics to be enabled, masks all text and inputs, blocks media, and keeps screenshots and broad remote log shipping disabled.
- Optional Statsig telemetry is disabled by default, sends no `userID` or account data, and relies on Statsig's anonymous Stable ID plus safe app/runtime metadata. Statsig web analytics is a separate off-by-default opt-in that disables console-log capture, copy-text capture, and current-page URL attachment, then filters AutoCapture to low-risk technical events such as web vitals, performance, and session start. Click, copy, form, dead-click, rage-click, error, and page-view AutoCapture events are blocked by default. Nodex does not enable Statsig Session Replay.
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

## Current Gaps

- Security logging/auditing is still local-first and not audit-grade. Backend logs redact common secret-bearing fields (for example authorization headers, tokens, API keys, passwords, cookies, and session values) before writing JSON-line log records; optional Sentry crash diagnostics are for failure triage, not an audit trail.
- A compromised trusted top-level renderer can request exact local file reads through the workspace-file bridge. Webviews, subframes, and unowned renderer contents are rejected, but process-level renderer isolation is still the confidentiality boundary for these reads.
- Erasure removes content from the live Store; it does not rewrite existing backups, and freed SQLite pages may keep fragments until they are reused or vacuumed. Text already sent to a model runtime cannot be recalled.
- Dynamic-tool receipts are an idempotency and recovery ledger, not an audit-grade record of human intent. They intentionally exclude raw Nested Markdown/body content; receipts do not retain a second document history.

## Safe Operating Practices

- Follow [Dependency maintenance](#dependency-maintenance) when updating dependencies.
- Use manual backups before destructive operations.
- Keep Sparkle and Developer ID private keys in separate encrypted offline
  backups. A gitignored local note is only a convenience copy, not an encrypted
  disaster-recovery backup.

## Hardening Backlog

- Basic security smoke checks in CI for IPC/body limits and absence of SQL inspection routes.
- Stronger native subprocess lifecycle diagnostics without content-access policy.
