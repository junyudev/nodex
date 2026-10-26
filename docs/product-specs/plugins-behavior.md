# Plugins behavior

Customize manages the selected local Codex home's plugins, marketplaces and skills.
Native Codex remains the installation and configuration authority. Nodex does not copy
installation state into its content database.

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
contribute installed match keys. Local contents must match current skill inventory or a visible plugin's current detail,
including disabled and uninstalled local plugins; remote
plugin contents use the named native skill-read operation. No arbitrary file-read or skill
deletion operation is exposed without inventory authorization.

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
MCP OAuth returns a validated HTTP(S) authorization URL for the UI's browser action;
native completion notifications refresh MCP observations. This flow is independent of
ChatGPT connector authentication.

Plugin hook inventory filters native hook metadata by the exact owning plugin ID and counts
untrusted or modified hooks as needing review. Rootless contexts have no root-scoped hook
inventory. Hook summaries and scheduled tasks remain available directly on native detail.
