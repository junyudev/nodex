# Security

## Relation references

Relation is non-authorizing. Creating a definition requires source schema authority and readable target Data Source; adding an edge requires source write plus independent target Page read. Core assigns each edge a random 256-bit opaque identity. Incremental removal accepts only that source-owned handle and verifies its source membership/Property scope, so losing target read does not make an owned relation undeletable and a guessed Page ID cannot probe membership. Clear-all uses an explicit value-revision fence. Stale, unknown, wrong-source, and unauthorized edge handles share a non-oracular failure boundary. Project reads authorize every projected target, and saved Relation filter operands are reauthorized on every View descriptor/window/context/group read after grants change. A compact preview exposes only visible targets plus the restricted count. The paged selected-target window may expose a generic `Restricted page` row and its source-owned removal handle, but never the target Page ID, title, Document, parent, Data Source, ownership path, or source metadata. Relation cursors contain only an ordinal plus a constant marker. Library-trusted local reads do not materialize grants.

## LocalCommit delivery authorization

Physical Module events are private reconstruction evidence, never an authorization unit. Store v110 seals closed typed DeliveryAtoms whose descriptors contain the exact canonical `ResourceKey` requirements extracted from their payload. Core sends an atom only when the packet's post-state authorization scope can read every requirement. A mixed business result that has independently visible portions is compiled into independently redacted atoms before Manifest sealing; Main and renderer never trim fields or infer claims. Authority-bearing tables record raw OLD/NEW facts only inside a transaction-owned visibility journal; seal compares reconstructed pre-state with current authorization, hashes the resulting visibility evidence, and rejects missing trigger context, unconsumed facts, or noncanonical deltas. Projection requirements are stored as private sealed descriptors, so historical payload authorization does not depend on a future extractor implementation.

Packet v4 binds a separate `DeliveryAddress`, a Core-authored `AuthorizationScope`, complete Manifest coverage, Document and Projection effects, and Manifest-bound `VisibilityDelta` values into one integrity identity. Exact `Revoke` deltas evict matching authority before post-state content; `ConservativeReset` fences an entire address only when the journal cannot prove an exact bounded closure. Transport failures never invent either delta: the Core barrier signs an `AuthorizedRecipientLease`, and Main may use that immutable lease only to route the exact address or author a non-Manifest `AddressReset`. Audience IPC accepts owned top-level renderer frames, validates the requested Library/address and a 200-address bound, and cannot submit an authorization scope. Apply, audience-live, and durable ingress use the same packet-v4 structural validator and fail closed on legacy shape, malformed lease, coverage mismatch, or Store/Library/event mismatch. Visibility evidence evicts stale client authority but never replaces Core authorization on a later canonical read.

Multiple owned WebContents may consume one logical address without sharing
renderer state. Main retains only the current Core lease and barrier floor for
that active address; each later recipient must accept a lease-bound floor reset
before packet admission. Destroying the recipient removes its pending packet,
ACK, reset, timer, and WebContents reference. Neither ref-counting nor retry can
mint a new scope or keep a released lease alive.

Canonical Library navigation/Page, Database View/row, Page Detail, and owned-Document descriptor reads carry a Core-authored `AuthorizedReadStamp`. Its subject, request dependencies, dynamic authorization dependencies, address/scope, Store epoch, covered commit, and canonical hash come from the same SQLite read snapshot. Inherited authorization stamps the complete grant-to-subject ownership path. A proof union beyond the contract bound is replaced by the scope's Library/Project aggregate root, which the visibility journal invalidates on every exact change for that scope; journal compilation overflow still uses `ConservativeReset`. Adapters may transport the stamp but cannot add roots or raise its floor. Renderer caches verify it and reject a response below any observed address or matching root floor. Exact revocation therefore cannot be defeated by a late response, an inferred ancestor path, or a cache entry created before its dynamic roots were known. Root, registration, address, and in-flight bounds fail closed; none use drop-oldest eviction.

## Page-key lookup

Page keys are short and guessable, so they are locators rather than secrets or
capabilities. Core may parse and index-resolve a complete current or historical
key before broad search, but it must evaluate the caller's current
Project/Library/Database grant and lifecycle scope before returning Page ID,
title, current key, matched alias, Database identity, or any other metadata.
Project-bound CLI and Agent callers cannot use a Library-wide prefix hit to
cross their selected authority. External missing and unauthorized results share
the existing non-enumerating error boundary.

Prefix creation and rename validate canonical ASCII grammar and Library-wide
current/retained uniqueness inside the Core transaction. Renderer suggestions,
display settings, copied text, and caller-provided Project names cannot reserve
or allocate a key. `pageKey`, matched aliases, and namespace revisions are
untrusted input at Adapter boundaries; mutation authority is always canonical
Page UUID plus the existing ETag, ownership, grant, and exact-Turn evidence.

Page keys may appear in local diagnostics as bounded structured identifiers,
but they must not replace UUIDs in audit/receipt identity or be joined with
otherwise inaccessible Page metadata. Ordinary telemetry and remote diagnostics
follow the same content-redaction policy as Page titles and search queries.

## Threat Model

Nodex is local-first. Main risks are malformed local inputs, accidental data loss, renderer capability abuse, and unsafe command/file-change approvals during Codex thread execution.

## Page File boundaries

Owner Files manifests, mutations, lifecycle, and version history are authorized
by the canonical owner Page and Project scope. A containing Page may resolve
only current metadata and bytes for a File in its canonical placement
projection. File references carry opaque stable IDs, but the ID alone grants no
access, exposes no content hash, and reveals no Profile path. Core verifies the
requesting Page placement on every current-content read and rejects missing,
deleted, cross-Library, or unauthorized references before Document commit.
Typed structural compilers may carry an already-authorized placement within one
transaction; generic collaborative writes must prove existing owner or
placement read access. Prepared upload receipts are Store-, Project-,
operation-, size-, and expiry-bound and are single-use except for exact
idempotent replay.

Logical paths are normalized and must be portable relative paths. Core rejects
absolute paths, traversal, empty segments, reserved Windows names, Unicode/case
collisions, control characters, and bounded depth/length violations. Desktop
file and directory import accepts only regular files, rejects symlinks and
special nodes, and enforces 64 MiB per File, 100 Files, and 256 MiB per batch.
Text previews are separately bounded. Download chooses a user destination and
does not reinterpret a logical path as a host filesystem authority.

Exact-format scripts and binaries are inert content. Agents cannot execute a
managed blob root or use it as cwd; execution requires explicit materialization
into the normal workspace and remains governed by existing filesystem and
command approval policy. Backup restore hashes every managed Page File blob
before Profile switch, and garbage collection is serialized against snapshots.

## Security Controls in Place

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
  the same Developer ID, notarization, Sparkle key, dual-architecture Bundle,
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
- Browser runtime publishing forces `--latest=false` and verifies that the
  stable app Latest tag remains unchanged.

### Application and runtime controls

- ACP Agent definitions are compatibility allowlists, not supply-chain attestations. The current
  Claude Agent integration launches only an explicitly enabled, user-managed absolute package root
  and Node executable after canonical path, entry containment, package/version, executable-version,
  and Node-version checks. The Settings UI states that these checks do not verify package or
  dependency bytes. The selected credential and proxy policies bound environment inheritance, and
  unowned ACP client capabilities remain unadvertised. Advertised filesystem callbacks reject
  paths outside the canonical Project workspace and symlink traversal; advertised terminals share
  the supervised Main runtime, bounded output, workspace cwd, and session lifetime. Whoever can
  replace the configured package
  or executable is inside this local-code trust boundary. A future managed ACP distribution must
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
- Offline Profile cloning accepts only a current evidence-backed published Core
  backup and a nonexistent target home. It rejects symlinks and source/target
  ancestry, verifies copied database and asset-tree digests in a private sibling
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
- Native file/folder paste inspection is Main-owned. The synchronous paste-event
  request returns only bounded formats and absolute non-symlink path metadata;
  rich text and image payloads use a separately bounded asynchronous request.
  Renderer code never imports Electron clipboard access or reads arbitrary
  filesystem metadata through the preload.
- Structural editor copy writes bounded HTML/plain presentation plus an opaque
  capability envelope through trusted Main IPC. The owned snapshot stays in
  Core. Paste verifies the Profile, Library, Store epoch, manifest hash,
  capability hash, current authorization, target head, payload size, Block
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
  signing teams, not the outer app's team.
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
- Workspace-file IPC is available only to the top-level renderer frame of an owned app window. Directory browsing accepts canonical root-relative coordinates, verifies lexical and resolved-realpath containment, and omits directory symlinks that escape the selected root. Exact-file metadata/text/binary operations intentionally accept an absolute local path without a Project-root grant so user-visible agent outputs and patches remain openable outside the active source; this relies on the trusted-renderer boundary rather than path sandboxing. Bounded raster previews become ephemeral `blob:` URLs and renderer cleanup revokes them. PDF bytes are transferred to the bundled PDF.js worker as a `Uint8Array`; canvas, selectable text, and annotation links are rendered in app-owned DOM without iframe navigation, form rendering, or embedded script execution. PDF external links cross a top-level trusted-renderer IPC that accepts only bounded, credential-free HTTP(S) URLs before Main calls the system browser. Write requests use an expected-modification-time CAS guard and never create missing parent directories implicitly.
- Renderer file references use a semantic Workbench router: ordinary references enter the validated Files surface, while explicit external/reveal actions use typed IPC. Local references are never opened through renderer-created `file://` windows or a document-wide link capture handler; bounded copy-contents actions still go through the existing `read-file` IPC budget.
- Managed-asset mutation, byte reads, bounded previews, path resolution, and dictation IPC are likewise available only to the top-level frame of an owned app window and validate payload types and byte budgets again in Main. Persisted `nodex://assets/<safe-name>` identities do not expose filesystem roots. The trusted renderer resolves a managed locator to an absolute path through the synchronous preload capability and uses the shared `app://fs/@fs/...` display transport; successful resolutions are cached only for the renderer window lifetime. The `app://fs/*` request gate admits the `app://-` renderer and the exact configured HTTP(S) development origin, excluding the Browser-sidebar partition. The handler accepts extension-addressed image, audio, and video MIME families, follows filesystem symlinks, and does not grant renderer script code a general file-read IPC capability. Production CSP admits `app:` for image and media elements but does not admit `file:`.
- Opt-in local-path clipboard presentation resolves a Page File only after an authorized metadata read exposes its current SHA-256. The synchronous preload capability accepts only that exact lowercase hash, considers only regular non-symlink files under the Profile `assets` directory, and returns no arbitrary caller-selected path. The resulting physical locator appears only in copied `text/plain`; stored NFM, rich clipboard payloads, and general File interfaces retain stable semantic locators.
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
- Codex approvals are explicit protocol responses (`accept`/`decline`/etc) and are gated by the per-project Threads permission mode.
- Codex user-input auto-resolution never infers or selects an answer. Main may end an inactive ordinary request with the protocol’s empty answer object after the bounded foreground/background timeout; any request-card interaction snoozes that timeout, and explicit renderer submission remains the only path that can send answer content. App-server disconnect clears renderer-memory request drafts and rejects the old inbound generation, so a reused JSON-RPC scalar id cannot recover secret freeform content or receive a late response from the previous process.
- Codex authentication is owned by the isolated Codex runtime state and its app-server auth protocol. Renderer and Core never receive plaintext authentication material, and Nodex does not maintain a parallel application credential store. External-agent imports intentionally omit authentication and connection state; each backend must establish those secrets through its own authority boundary.
- External-agent import is an explicit trusted-renderer workflow backed by expiring opaque scan ids. Source homes are canonicalized and read-only; the writable Agent home cannot be selected as its own source. Session content is hashed before and immediately before import, then app-server `thread/fork(path)` creates the target Thread. Native file copies never replace a target, reject symlinks, stage directory trees before rename, and do not copy SQLite/WAL/SHM files. Config translation allowlists passive settings, removes literal MCP environment/header/token material, and omits authentication, approval, sandbox, and connection state.
- `nodex_app` reads and writes derive an exact-Turn authority snapshot from the verified launched task; model arguments and renderer responses cannot select another Project, Library, store epoch, Turn, or catalog revision. Ordinary snapshots use Project binding/grants. Main persists the selected Nodex preset separately from raw Codex config and requires both to agree before the built-in Full access preset records `:danger-full-access` provenance and receives temporary same-Library scope; Custom settings with equivalent raw sandbox values do not upgrade a Turn. Missing historical provenance falls back to Project scope, while stale or inconsistent recorded provenance fails closed.
- Every `nodex_app@6` write performs mutation-free canonical preflight before any required consent, then re-resolves the exact `(thread, turn, root thread, actor Project, Library, Profile, store epoch)` authority. Execution proceeds only when the fresh effect class, target resources, deletions, and ownership transformations equal the approved footprint. Primary-Database and `read_write`-grant operations, including destructive writes, execute without a renderer card. Full-access Library scope also auto-approves. Neither path bypasses ETag/CAS guards, schema revisions, lifecycle checks, footprint equality, or transaction validation.
- Native Core prepared operations expose no additional private route: prepare
  and execute are typed intents in the owning Module `read/apply` pair. Only an
  Electron-host connection (or the isolated test role) may submit the exact
  persisted Turn provenance. Tokens contain 256 bits of fresh entropy, live for
  at most 60 seconds, are stored only as hashes, are capped globally and per
  connection, and bind request fingerprint, UDS connection, authority
  revisions, target footprint, and effect class. Execution acquires one
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
- Nodex resource consent exists only in main and is independent of Codex filesystem/command approval modes. One-call consent binds the exact call and prepared footprint. Task consent binds app session, verified root task, Project, Library, store epoch, and canonical resource roots; it is not owned by the renderer that presented it. Project consent is the only choice that persists `project_resource_grants`, and exact-Turn authority is revalidated before that write. Canonical conversation-state ownership and renderer fields cannot grant or elevate Nodex authority. Denial, timeout, task archive, Project/store change, shutdown, restart, or a headless first prompt withholds or invalidates transient authority without mutation.
- Full-access Library authority is an ephemeral overlay and never creates or expands `project_resource_grants`. Cross-compatibility-owner structure writes validate actor/source/target in one Library, move the complete ownership closure in one deferred-FK transaction, rebuild derived projections, require a clean `foreign_key_check`, and publish immutable source/final owner members. Store restore changes the epoch and invalidates prior Turn authority and the Main-scoped authorization Module's transient grants.
- Authorization responses travel through the targeted active-view renderer route and use random occurrence identities, preventing another renderer or an equal app-server call ID from satisfying the request. The renderer validates the bound Project/task, presents the request as a local overlay, and cannot publish it into or elevate canonical owner/follower state. Exact durable call replay bypasses authorization only after its request fingerprint and prior compact result are verified; same-call/different-input collisions fail closed.
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
- Dictation IPC requires a trusted owned renderer and validates request identity, audio MIME, payload bounds, history identity, and operation shape. Streaming uses a sender-bound MessagePort; renderer code never receives ChatGPT credentials or the Main-owned WebSocket.
- The global dictation window has a dedicated preload allowlist containing only capture, settings-read, history-write, transcription, streaming-port, Accessibility-settings, and global-session messages. It has no general `window.api`, Core, filesystem, shell, or Workbench capability.
- The signed macOS helper accepts bounded JSON-lines messages, verifies request/protocol shape, and has no auth, history, or clipboard-content logging access. Input Monitoring and Accessibility are independent capabilities. The helper captures the foreground PID/bundle at activation, and paste targets that identity instead of whichever app is foreground after transcription.
- Global paste checks Accessibility before changing the clipboard. Main holds a bounded all-format snapshot, writes only the finalized transcript plus one trailing space, and conditionally restores after paste only while its own text still owns the clipboard. User clipboard changes always win.
- Dictation history is stored beneath the active Profile in current-user-only directories/files with atomic metadata replacement, bounded audio/transcript sizes, non-path recording identities, and symlink/path-escape rejection. Native Save-dialog export is explicit user action; history files are not Core or conversation authority.
- Logs and remote diagnostics may contain only stable session/attempt identity, surface, gesture, stage, duration/latency/byte counts, stop reason/action, HTTP status, and stable error/native constructor names. Audio, transcript, dictionary content, microphone labels, clipboard content, raw request bodies, and service response bodies are prohibited.

## Current Gaps

- No role-based access control model (single-user/local trust assumption).
- Security logging/auditing is still local-first and not audit-grade. Backend logs redact common secret-bearing fields (for example authorization headers, tokens, API keys, passwords, cookies, and session values) before writing JSON-line log records; optional Sentry crash diagnostics are for failure triage, not an audit trail.
- `full-access` is intentionally high authority: it removes Nodex approval prompts for the exact Turn and permits every read/write/destructive action currently exposed by `nodex_app@6` across the current Library, in addition to unrestricted Codex filesystem and network access.
- Workspace-write sandbox roots are derived from user-configured project sources. Additional allow-listing beyond those local source roots remains future hardening work.
- A compromised trusted top-level renderer can request exact local file reads through the workspace-file bridge. Webviews, subframes, and unowned renderer contents are rejected, but process-level renderer isolation is still the confidentiality boundary for these reads.
- Dynamic-tool receipts are an idempotency and recovery ledger, not an audit-grade record of human intent. They intentionally exclude raw Nested Markdown/body content; the authorization preview is not retained as a second document history.

## Safe Operating Practices

- Keep dependencies updated through reviewed pnpm, Cargo, and GitHub Actions
  Dependabot changes.
- Use manual backups before destructive operations.
- Keep Sparkle and Developer ID private keys in separate encrypted offline
  backups. A gitignored local note is only a convenience copy, not an encrypted
  disaster-recovery backup.

## Hardening Backlog

- Basic security smoke checks in CI for IPC/body limits and absence of SQL inspection routes.
- Approval policy profiles (for example, command/file-change scopes and allow-lists) beyond the current `sandbox`/`full-access`/`custom` permission presets.
- Additional execution boundary controls for Codex subprocess invocations.
