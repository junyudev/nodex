# Plugins behavior

Customize manages the selected local Codex home's plugins, marketplaces and skills.
Native Codex remains the installation and configuration authority. Nodex does not copy
installation state into its content database.

## Customize pages

The rail's Plugins entry opens Customize. Its sidebar has a search over installed plugins,
the Plugins and Skills pages, and the installed plugins, each with a More actions menu
(Try now, Manage, Uninstall). The gear on every Customize page opens Settings › Plugins.

- **Plugin page.** Any plugin row opens it. The titlebar breadcrumb reads Plugins, then the
  category when the plugin was opened from one, then the plugin; ancestors return to the
  directory tab, category and search the plugin was opened from. The header shows the logo,
  name, origin badge and "By {developer} • {summary}". Its primary action follows the
  plugin's state: Install plugin, Installing, Enable, Try now, Uninstalling, the reason an
  administrator disabled it, or Unavailable. More actions holds Uninstall, or the reason it
  cannot run (Installed by admin, Required by ChatGPT). A starter prompt starts a chat that
  mentions the plugin, installing or enabling it first when needed. A long description folds
  after fifteen lines. Included apps (grouped by category when there are several), MCP
  servers, skills and hooks follow; a list longer than five folds behind "See A, B, and N
  more". Skills preview their instructions; an installed plugin's skill can also be opened,
  revealed, copied or tried. The Information table always lists Website, showing Unavailable
  without one. A plugin with apps ends with the notice of how connected apps may use chat
  data, worded for one or several apps and extended for Google apps.
- **Connecting apps after install.** When a plugin that connects its apps on install still
  needs accounts for them, installing it offers to connect each app. Connect opens the app's
  connection page; the row waits, then reads Connected once the account link appears when
  Nodex regains focus, and the dialog closes when every app is connected. View details and
  Try {plugin} now (with the starter prompt the install began from) close it; connecting is
  always optional.
- **Skills page.** Installed lists every standalone skill and folds to six only when at least
  three more would be hidden. Tabs then group the same skills by where they are installed:
  Personal, the project's folder (or Team), System, and Admin installed. Search narrows
  everything into one list; Command-F focuses it, the arrow keys move the highlight and
  Enter opens the highlighted skill. A skill's preview switches it on or off, opens, reveals
  or copies its SKILL.md, and tries it in a new chat. A recommended skill's preview shows its
  instructions before it is installed. Add starts a chat with the skill
  creator.
- **Settings › Plugins.** Counted Plugins, Apps, MCPs, Skills and Marketplace tabs share one
  search. MCPs is always offered; another tab is hidden while it has nothing in it, and an
  emptied tab falls through to the next one that has something. Every installed plugin and
  personal skill has a switch. A plugin row opens that plugin's settings; a skill row opens
  its instructions. The skills listed are personal skills that aren't recommended ones.
  Browse directory returns to the Customize page for the selected tab. Add offers Create
  plugin and Record a skill when their helpers exist, Add a marketplace, and Add MCP server.
- **Apps.** The apps you have connected each have a switch; one controlled by an administrator
  or another configuration layer stays locked and says why. A row opens the app's tools, split
  into tools that change things and tools that only read, with the app's switch and Try now,
  which starts a chat that mentions the app. App rows on a plugin's page open the same tools.
- **MCPs.** Your servers each have settings and a switch; servers that plugins provide are
  listed separately and only sign in. A server that needs a sign-in offers Authenticate,
  with a choice of how its OAuth client registers. Adding or editing a server replaces the
  lists with its form: a new server's name and type (a command, or a streamable HTTP URL),
  then its arguments, environment, working directory, or headers. Fields the form doesn't
  show, such as timeouts and tool filters, are kept. An edited server can be uninstalled.
  MCP Apps › Clear all app data clears the site data and caches every interactive MCP app has
  saved in this session, without asking first.
- **Marketplace.** The marketplaces you added show how many plugins each offers and where it
  lives. Git marketplaces can be upgraded. Removing one first lists its installed plugins,
  then uninstalls them one at a time, marking each, before removing it; a failure names the
  plugin it stopped at and Retry resumes there. Marketplaces that failed to load are listed
  above the others with a Retry.
- **Plugin settings.** Manage, wherever it appears for an installed plugin, opens its settings
  under Settings › Plugins: each of its skills with a switch and its instructions, and what is
  known about it (when it was connected, developer, version, website, privacy policy, terms).
  View details returns to the plugin's page; Uninstall removes it and returns to the list.

## Context and capabilities

Every operation identifies a host and a nullable Project. The initial host is `local`.
Main resolves the Project's active, ordered filesystem sources, removes duplicate roots,
and fences observations against its binding revision. A null Project requests native-home
inventory without explicit working directories. Missing, inactive and changed Projects
reject stale work. Local paths are never forwarded to another host.

Resolved context contains the host generation, account epoch, Project binding revision
and ordered roots. Renderer query keys include these coordinates. Resolving native context
is independent of ChatGPT directory availability, so a failed directory feed does not
prevent installed inventory or standalone skills from loading.

Public home, categories, personal feeds, shared feeds and remote enablement require resolved
ChatGPT service capabilities. API-key and signed-out accounts do not issue these HTTP
requests. Read-only access probes resolve denied or absent endpoints as unavailable
capabilities. An enabled feed's network, authorization or decoding failure is an error,
never an empty result. Workspace-created and shared feeds are considered only for workspace
accounts. Requests freeze the account and user; an account switch discards stale responses
and cannot retarget a pending remote mutation.

Native search requires ChatGPT or API-key authentication and app-server version `0.0.0`
or at least `0.147.0-alpha.6`. Other configurations filter native inventory locally.

## Inventory and identity

A row retains the native `PluginSummary`, native ID, stable identity, exact marketplace
identity, and an explicit local or remote selector. Stable identity prefers the remote
plugin ID, then the shared remote ID, then the native ID. A local selector uses the
marketplace file and plugin name. A remote selector uses the marketplace name and opaque
remote plugin ID. Exactly one marketplace selector is permitted. Detail route targets
round-trip these selectors without inferring a filesystem path from an ID.

Directory metadata and installed state have separate authorities. Listing metadata wins
for presentation; installed inventory supplies installation, enabled state, local version
and installation policy. Installed checkouts take precedence over duplicate remote copies.
Disabled and administrator-disabled installations remain in inventory. Sidebar ordering is
stable: newest installation first, with administrator-disabled rows last.

Renderer image URLs are authorized app assets or HTTPS catalog URLs. Raw local logo paths
are not image URLs. Detail includes skills, apps, hook summaries, MCP server names and the
plugin's published information fields. MCP names are not executable declarations. Detail app connection projections distinguish connected, authentication required, unavailable,
administrator-disabled and unknown states. A failed connector read makes no claim about authentication.
Scheduled-task templates retain the native protocol shape.

Detail skills expose an authorized `iconUrl` and `installedSkill` containing the local
`path`, `name` and `enabled` state. Uninstalled plugins and unmatched local skills return
`installedSkill: null`; this means unavailable, regardless of the manifest's enabled flag.
Matching prefers the exact path, then the exact name (qualified with the plugin name for
pathless, unqualified skills), then a unique comparable name. Comparable names lowercase
each colon-delimited segment and remove whitespace, underscores and hyphens. Duplicate
observations of the same path across roots do not make a match ambiguous. Local small icons
use the same asset authorization as plugin logos, with an HTTPS small-icon fallback.
Switches address the installed skill by name when it contains a colon, otherwise by path.
`skillsError` distinguishes a failed inventory read from a complete inventory with no match.

Each Profile's Browser, Chrome and Computer Use plugins are managed desktop tools. Local
inventory omits foreign desktop copies, retains unrelated same-name plugins, and presents
installed managed tools as effectively enabled. Managed IDs, alternate identities,
contained skills and their source marketplace cannot bypass protection through direct
commands. Required installations cannot be uninstalled; administrator-disabled plugins
cannot be toggled. Hidden desktop copies also protect their source marketplaces from page
commands. Desktop-tool settings retain ownership of managed configuration.

## Directory composition

Public service sections preserve server section order, plugin order, titles and slugs.
Repeated section IDs merge using the first title and latest non-null slug. Sections contain
at most nine distinct rows. Without the Public capability, the local fallback builds
Featured from native featured IDs and categories from plugin metadata. It creates no
popularity or recency sections and uses no remote category slugs.

Category pages retain server metadata and opaque cursors. The first page places local
category supplements after the first fourteen service rows, then deduplicates by stable
identity. Category search and native search use fifty-row pages. Local search normalizes
ASCII alphanumeric words and punctuation; it matches display name, plugin name and keywords,
without treating descriptions as default search keys. Native ranked results are not
filtered a second time.

Personal combines local created plugins, remote Created by you, Shared with you, and imported
marketplace groups. Local created plugins come from the home directory's
`.agents/plugins/marketplace.json`. Checkouts win over remote shared copies. Duplicate
marketplace labels use the shortest disambiguating path suffix. Created previews request
nine rows from each eligible source. See all requests fifty rows per source and retains
independent user and workspace-created cursors; an exhausted source is skipped on later
pages. Shared pages retain their own cursor.

Card action precedence is pending operation, installed menu, administrator-disabled,
unavailable, unknown installation state, then install. Installed, enabled and connector
connected states remain distinct. Auth policies and apps requiring authentication are
returned by installation for the caller's setup workflow.

## Skills

Skills flatten in resolved root order and deduplicate by path, then by name. Scope precedence
is Project, user, system, administrator; lexical path breaks ties. Standalone groups exclude
plugin-owned skills and retain system skills. Match keys include directory basename, raw and
humanized name, display name, and punctuation-free variants. Plugin-owned skills still
contribute installed match keys. Local contents must match current skill inventory or an exact
absolute SKILL.md path returned by a completed plugin detail query, including disabled and
uninstalled plugins. Detail path grants are scoped by host generation, account identity and
epoch, Project bindings and ordered roots. The original native plugin selector is re-read
before accessing the file; removed paths lose authorization. Account changes and reconnects
revoke grants. Preview authorization does not depend on rediscovering the plugin in installed
or catalog inventory, and never grants sibling files or directories. Filesystem reads retain
the skill directory's canonical containment checks.

Skill contents return `SkillContentsResult`: `status: "success"` with `contents` and `files`,
or `status: "failed"` with a typed `error`, null contents and no files. Unknown local paths
return `error.code: "not_found"` through IPC instead of rejecting the preview query. Remote
plugin contents continue to use the named native `plugin/skill/read` operation. No arbitrary
file-read or skill deletion operation is exposed without inventory authorization.

Recommended standalone skills come from the curated and experimental directories in
`openai/skills`, checked out sparsely under the native home's `vendor_imports/skills`.
The catalog refreshes after ten minutes; each Git command has a thirty-second timeout.
A bundled repository is used when present and no checkout exists. Failed refreshes retain
the cached catalog and expose a separate error. User installations go into `<codexHome>/skills/<id>`;
Project installations go into the selected active source's `.agents/skills/<id>`.
Installation copies supporting files through a staging directory and refuses to overwrite an
existing skill. Standalone uninstall requires a current user or Project skill, no plugin owner,
and an immediate child of an authorized installation directory. Symbolic-link escapes and
managed directories are protected. Local contents include the original SKILL.md and the
contained file list; remote skill reads expose only SKILL.md because the native protocol
has no remote included-files operation.
Recommended previews use `useSkillContents(context, {recommendedSkillId})` before installation.
The catalog owner resolves the ID to its validated curated/experimental directory and reads
SKILL.md plus its contained file list under the same catalog lane as refresh/install. Unknown
IDs return the typed not-found result. Traversal and escaping symlinks are refused. The catalog's
`RecommendedSkill.iconUrl` authorizes an existing contained small icon from skill interface
metadata, including `agents/openai.yaml`; missing or unsafe icons are null.

## Mutations and refresh

Commands return `success`, `success-with-refresh-warning`, `protected`, `policy_denied`, or
`failed` with a safe structured failure. Installation retains its attempt ID and native
auth result. Local plugin toggles read configuration layers and write against the observed
user-layer version. A version conflict does not overwrite external changes. Higher-priority configuration overrides
return a policy denial. Remote plugin
toggles use the ChatGPT service only for remote sources.

A committed plugin change forces skill reload for every observed host/root set, including
other Projects and composer inventories, and refreshes plugin, app, hook and MCP
observations. Refresh failures remain warnings on a successful mutation. An unknown delivery
outcome triggers verification and cache invalidation, never a generic mutation retry or a
claim that the native write rolled back. Upgrade errors retain their structured marketplace
failures and are not reported as complete success.

Marketplace removal uninstalls installed plugins sequentially, stops at the first failure,
and removes the marketplace only after a fresh inventory proves no installations remain.
Progress records an operation ID, completed prefix and remaining IDs. Retrying the operation
revalidates context and protection and resumes the remaining prefix. A reinstalled completed
plugin or a newly protected installation blocks continuation. Removal progress is owned by
Main for the running application lifetime and is broadcast to every window.

The composer and `uninstall_plugin` application tool share the native removal owner.
Application-tool name resolution retains exact-ID precedence, ambiguity candidates,
current-invocation checks and post-removal verification.

## Renderer cache contract

TanStack Query owns bounded observations. Installed inventory is fresh for one minute;
skills for five minutes; native directory for six hours with five-minute garbage collection;
HTTP home for one hour with one-hour garbage collection; categories and search for one minute.
HTTP feeds do not retry automatically. Search debounces for two hundred milliseconds and
retains previous results only within the same resolved scope.

Install, uninstall and enablement patch affected cached rows and restore snapshots on a
known rejection. Successful installation immediately updates installed inventory even when
refresh returns a warning. Account changes remove old account caches and prevent late
mutation settlement from restoring them. Project source or lifecycle changes reset only
the affected scope. One subscription owner handles host-qualified plugin, skill, app,
account and connection events, marketplace progress and Project scope changes. Plugin
mutations also invalidate composer plugin/skill and MCP observations.

Connector account flows, recommendations, sharing, archive uploads, teams, workspace
management and other Agent Backend exports are separate capabilities outside this contract.

## Settings inventory

Marketplace inventory joins native catalogs with effective layered configuration, including
configured sources that failed to load. Rows retain name/path identity, display name, local
or Git source, source string/ref, built-in and user ownership, plugin count, and load errors.
Built-in catalogs cannot be removed. Only configured Git sources can be upgraded; upgrading
all targets each eligible configured source individually. Removal previews retain display
rows and matching marketplace errors, and retries preserve previously completed removals.

Apps use the committed `app/installed` runtime snapshot and `app/read` metadata in batches
of at most one hundred IDs. Only an unsupported-method response falls back to paginated
`app/list`. Effective enabled and callable state remain separate from connection state.
App rows and detail apps expose `editable` and `editRestriction` for switches. Editability
uses current effective config origins and a writable base user layer; administrator,
managed, Project, session and active-profile restrictions cannot be bypassed with connector
aliases. Missing config fails closed. `setAppEnabled` writes only the quoted
`apps.<id>.enabled` leaf through the versioned native config owner and reloads native app
state. It preserves unrelated fields and returns policy denial for an overriding layer.
App enablement invalidates app views, installed/plugin detail and composer observations.
`usePluginAppTools(context, appId)` reads native `app/read` with tool summaries. Rows retain
native `name`, `title`, `description`, `isEnabled`, `disabledReason` and `isReadOnly`, plus
`editable`/`editRestriction`. `setAppToolEnabled` validates a unique tool name against fresh
metadata, then writes only its quoted `apps.<id>.tools.<name>.enabled` leaf through the same
versioned config owner. Disabled parent apps and non-user tool policies prevent editing.
App, tool and MCP changes invalidate the app tools view as well as affected app/detail views.
The pinned app metadata does not expose destructive hints or events: `destructiveHint` is
null, `events` is empty and `eventsAvailable` is false. A missing native tool catalog returns
`available: false` with a typed error instead of inferring tools from unrelated MCP names.
Detail app rows retain their manifest fields and expose `logoUrl`, `logoDarkUrl`,
`accessible`, `enabled`, `callable`, `connectionState` and `canDisconnect`. Unknown native
flags are null; the legacy inventory supplies accessibility when available. `installUrl`
is a validated HTTPS browser destination. `usePluginDetail` can opt into
`refreshAppConnectionsOnFocus`; `usePluginApps` can opt into `refreshOnFocus`. Both force
native app reconciliation and blocking account-link refresh when refetched after focus,
including when the existing query is fresh.
ChatGPT-authenticated reads join accessible account links with connector metadata. An active,
visible, usable link wins over a blocked link for the same connector. Implicit and hidden
links do not establish an account connection. Disconnect targets either every account for
an app or a verified individual link, under the captured account identity.

Connector connection initiation is unavailable until a backend-approved Nodex redirect and
correlated native callback receiver are verified. The known desktop contract returns a
Codex-specific `://connector/oauth_callback` URL and posts the full redirect to the connector
callback endpoint. Nodex does not claim to own that callback, create pending OAuth installs,
or uninstall plugins for a connection it did not start.

MCP inventory joins paginated native status with configured declarations. Plugin-provided
servers and declarations owned by another configuration layer are read-only. Adds, edits,
renames, removal and enablement use the observed writable user-layer version through the
native config writer. Unrelated declarations and unknown native config fields are retained.
Plugin declarations remain read-only; the detail page can change only their enabled override.
`mcpServerStates` accompanies the native `mcpServers` names and contains `name`, `configKey`,
`enabled`, `installed` and `canSetEnabled`. Installation reflects the plugin's installed
state. Keys resolve from current configuration by exact name or a unique comparable key or
declaration name. Ambiguous keys and servers owned by another plugin cannot be toggled.
`setPluginMcpServerEnabled` revalidates the selector and resolved key, then writes only
`mcp_servers.<quoted-key>.enabled` through native `config/value/write` against the observed
user-layer version. `mcpServerError` reports unavailable configuration or status inventory.
MCP OAuth returns a validated HTTP(S) authorization URL for the UI's browser action;
native completion notifications refresh MCP observations. The login response retains its
native login ID so the UI can correlate completion. This flow is independent of
ChatGPT connector authentication.

MCP app data clearing is a local, Profile-wide sandbox capability. The renderer reads
`useMcpAppDataCapabilities(context).data.available` and invokes
`usePluginManagement(context).clearMcpAppData()` without confirmation. A dedicated typed
sandbox IPC owner keeps this operation available without a native agent connection or
ChatGPT authentication. Remote hosts report unavailable.

"All" means every unique Electron MCP sandbox session configured by the host when the clear
operation starts, including sessions retained after their views/windows close. MCP app
partitions use `nodex-mcp-app-sandbox:<id>` without `persist:`; they are in-memory and leave
no persistent MCP app partition directory to discover after restart. Each session clears
all origins and data types through Electron `clearData()`, including cookies, storage,
HTTP/cache storage, shader caches and service workers; compiled code caches and HTTP auth
caches are cleared as well. The ordinary desktop/browser session is outside this registry.
Open apps may recreate data afterwards, and sessions first created after the snapshot start
with their own empty state. Clear requests serialize and attempt every session/cache even
after a failure. Partial failure returns a typed failure instead of reporting success.

Plugin hook inventory filters native hook metadata by the exact owning plugin ID and counts
untrusted or modified hooks as needing review. Rootless contexts explicitly mark hook inventory unavailable; their zero scanned review count
does not establish that the plugin is trusted. Hook summaries and scheduled tasks remain available directly on native detail.
Detail exposes `hooksNeedingReviewCount`, `hooksAvailable` and `hooksError`.
`trustAllPluginHooks` reloads current metadata and writes each unmanaged, untrusted or
modified hook's current hash to its quoted `hooks.state.<key>.trusted_hash` entry. It cannot
trust another plugin's hooks, caller-supplied hashes or a rootless inventory. A subsequent
hook content change still requires review. Trust changes refresh hook observations and
detail without invalidating unrelated app or skill catalogs.

## Creation and detail extras

Creation capabilities resolve official Plugin Creator and Record and Replay catalog entries.
When necessary, ChatGPT connector metadata resolves the canonical Plugin Creator plugin.
Preparation installs or enables the chosen helper, preserves the caller's installation
attempt ID, re-reads native installation state and verifies required apps are enabled and
callable. It returns a native plugin ID and an unsent mention draft; failed preparation
returns no draft. Required app authentication remains a typed setup failure when connector
connection initiation is unavailable. Same-name third-party plugins cannot become official
creation helpers.

Native detail exposes app templates, onboarding skills and scheduled-task templates without
redefining their protocol fields. The optional Works with projection comes from the
account service's disclosed provider dependencies, retaining categories, availability,
installation/enablement observations and validated navigation. Provider installed badges use
complete native installed inventory for the selected home; incomplete inventory leaves them unknown. It is distinct from native
skill tool dependencies. Missing access or missing dependency data is explicit and does not
fabricate an empty supported feature. Connector read failures remain visible separately
from the plugin's native detail.

## Settings observation updates

Skill changes invalidate skills, recommended skills, previews, affected detail and composer
observations. App changes invalidate app-dependent plugin projections and MCP catalogs.
MCP changes invalidate MCP/app status and detail without refetching unrelated skill or
marketplace catalogs. Account and host changes remove old scoped and composer observations;
late results cannot repopulate them. MCP OAuth completion carries host generation and account
epoch. Removal progress additionally retains its originating Project context and display rows,
with uninstalling, removing, complete and failed phases.

Skills browse suppresses recommendations matching any installed skill's normalized name,
directory or display-name keys. A recommendation installed during the current flow remains
visible and carries its installed skill, while the duplicate installed row is suppressed.
Without search, recommendation order is Imagegen, Sora, PDF, Doc, Spreadsheet and Playwright;
search considers the full catalog. Standalone settings user skills wait for recommendations
to load and exclude recommendation matches. System standalone skills remain in browse.

Inventory rows for local and installed plugins resolve their declared apps before projecting
connection states; catalog summaries alone do not establish app ownership or callability.
Dependency reads and icon URLs do not bypass account fencing or local-file authorization.
Recommended-skill Git commands discard inherited Git directory/config overrides and pin the
owned checkout, preventing another repository from becoming the refresh target.
