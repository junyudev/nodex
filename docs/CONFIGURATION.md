# Configuration

## Resolution

Nodex configuration uses TOML, but Profile selection and Profile runtime
settings have different authorities. Bootstrap reads only `server.home` from
the user config and nearest project config to select a Profile. After that
selection, Desktop settings come exclusively from the selected Profile's
`config.toml`. The executable readers and behavioral tests under
`src/main/settings/` are the source of truth for accepted keys, bounds,
defaults, and override reporting.

Profile home resolves in this order:

1. nonblank `NODEX_HOME`;
2. `server.home` in the nearest `.nodex/config.toml` found from the current
   directory;
3. `server.home` in `~/.nodex/config.toml`;
4. the default `~/.nodex` home.

## Nodex account

Nodex Account has its own production identity domain and user pool:

| Domain | Purpose |
| --- | --- |
| `nodex.jyu.app` | Product website, downloads and update feeds |
| `accounts.nodex.jyu.app` | Clerk-hosted sign-in and account management |
| `clerk.nodex.jyu.app` | Clerk OAuth issuer and Frontend API |
| `api.nodex.jyu.app` | Reserved for the proposed Nodex Cloud API; no service is implemented yet |

The account portal is not the OAuth issuer. Other products under `jyu.app`
do not share Nodex identities or subscription access. Development and
production use separate Clerk instances and public OAuth clients.

Packaged Desktop reads its default public issuer/client pair from the Main
bundle. The build takes this pair from
[`config/nodex-account-production.json`](../config/nodex-account-production.json),
whose value is either `null` for an unconfigured build or an object containing
`issuer` and `clientId`. Installed apps therefore do not depend on a shell
environment for sign-in. `NODEX_BUILD_CLERK_ISSUER` and
`NODEX_BUILD_CLERK_CLIENT_ID` replace the pair at build time; both empty produce
a local-only build. A nonempty incomplete pair, malformed issuer or Clerk
development issuer fails the build. Build configuration is part of the
prepared-build cache identity.

At startup, either `NODEX_CLERK_ISSUER` or `NODEX_CLERK_CLIENT_ID` in the captured
process environment replaces the entire bundled pair. Supply both for a
runtime override; values are never combined across environments. Both empty
disable the connection. Unpackaged development stays local unless these runtime
values are supplied. Restart Desktop after changing them. These are public
deployment values, not secrets or TOML preferences. Missing or invalid account
configuration leaves local work available; a malformed pair is reported in
Account settings.

Configure a public Clerk OAuth application with PKCE required, opaque access
tokens, consent enabled, scopes `openid profile email offline_access` and
redirect URI `http://127.0.0.1/callback`. The desktop chooses an ephemeral port.
No Clerk secret key or OAuth client secret belongs in the Desktop environment
or bundle. DNS, TLS and Clerk configuration must be verified separately from
the build; a configured client is not evidence that production sign-in works.

The hosted Account Portal is branded through the Clerk Dashboard, separately
from the Desktop build. Its application logo and favicon reuse
[`packages/landing/public/nodex-icon.png`](../packages/landing/public/nodex-icon.png).
The production portal uses light appearance, a white background, primary blue
`#0071E3`, and flush elevation. Clerk retains ownership of authentication forms
and their validation.

Social sign-in connections require their own production credentials in Clerk.
Their provider callback is the URL supplied by Clerk, not the Desktop loopback
callback. Provider client secrets stay in Clerk; enable each connection only
after its production configuration and browser sign-in have been verified.

Credentials are encrypted under `${NODEX_HOME}/account/credentials.enc`, bound
to the Profile, issuer and client. They are separate from native Agent homes
and content backups. The test-only `NODEX_TEST_CLERK_LOOPBACK=1` flag permits a
`127.0.0.1` HTTP issuer in unpackaged fixtures; packaged builds always require
HTTPS. See [Nodex Account Login](product-specs/nodex-account-login-behavior.md).

## Composer prediction assignments

Composer predictions default on. **Settings → General → Composer → Show predictions**
stores the Profile preference as `server.composer_predictions_enabled` in its configuration.
Main broadcasts successful changes to all windows. Turning it off cancels pending generation
and clears cached suggestions across hosts, including when no Composer is open.

The built-in prompt predicts a concise follow-up in the user's language, using the chat's
model with low reasoning effort, and permits no suggestion when the next step is unclear.
Generation is an additional model request using the selected chat's account.

For advanced overrides, the Main startup boundary reads `NODEX_COMPOSER_PREDICTION_CONFIG`
from its captured environment as a JSON object with a `hosts` map. Keys are exact Codex host
IDs; unlisted hosts use the built-in configuration. The Profile switch gates both defaults
and overrides. This environment value belongs to the selected Desktop process; restart
Desktop after changing it. Invalid JSON, missing required fields, or sampling rates outside
`[0, 1]` fail startup rather than enabling an incomplete configuration.

For example, a disabled local assignment has this shape:

```json
{
  "hosts": {
    "local": {
      "is_enabled": false,
      "prompt": "Suggest the next useful user message.",
      "prompt_version": "local-1",
      "prediction_reasoning_effort": ""
    }
  }
}
```

`unsupported_models` optionally excludes model names. `live_sample_rate` and
`catch_up_sample_rate` override `sample_rate` for their respective triggers; the effective
rate defaults to `1`. An empty `prediction_reasoning_effort` keeps the parent's effort.
An enabled assignment still requires native prediction-fork support and an eligible,
persisted OpenAI Thread outside plan mode. Availability queries reveal the enabled state
and host scope without exposing the prompt or starting a native connection. See
[Composer prediction behavior](product-specs/composer-prediction-behavior.md).

## Workspace document dependencies

Packaged macOS builds include managed document dependencies; no Profile setting or system
Python installation is required. Native application MCP reports the verified runtime paths
through `load_workspace_dependencies`. Development checkouts stage the Apple Silicon runtime with
`vp run materialize:workspace-runtime:mac:arm64`, then restart Desktop if the capability was
already checked. Runtime selection does not search `PATH` or user Python environments.
See [the distribution and verification contract](../resources/workspace-runtime/README.md).

## Codex home

Codex uses the pinned official executable and the user's native account and configuration.
Its home resolves in this order:

1. nonblank `server.codex_home` in the selected Nodex Profile;
2. inherited `CODEX_HOME`;
3. `~/.codex`.

Use **Agent > Configuration > Codex home** to choose an absolute or `~/` path. Clearing
the field restores environment/default resolution. The control shows the active directory;
saved changes apply after restarting Nodex. Changing the home selects that directory's native
configuration and history. Nodex does not move history between homes; connected native
conversations are readable only when their history exists in the active home.

**Account directory** selects an independent native login while retaining the Codex home's
configuration and conversation history. It is stored as `server.codex_account_home`; clearing it
uses the native home account. Sign into that directory using
`CODEX_HOME=/path/to/account codex -c 'cli_auth_credentials_store="file"' login`.
Account selection applies after restart and
preserves existing native conversation IDs. Nodex supports one active local Codex account;
independent account directories are available on macOS and Linux. Authentication and account model
caches remain private to the selected directory; source credentials are never copied. An empty
account directory can also be signed into from Nodex after restart.

To continue the same shared history from an external terminal with that account, use
`CODEX_HOME=/path/to/account CODEX_SQLITE_HOME=/path/to/shared-home codex -c 'cli_auth_credentials_store="file"'`.
Nodex supplies that SQLite fallback when none is inherited; an explicit native `sqlite_home`
configuration takes precedence. CLI name indexes remain local to each account; native conversation
IDs and paginated history remain shared.

Profiles reuse the native home by default. Files under `${NODEX_HOME}/agent` do not select a
Codex home or change the Profile's settings. Development launchers explicitly select their own
disposable Codex home.

The native home owns login, configuration, hooks, skills, plugins, and conversation persistence. Nodex
owns its helper resources, import receipts, and desktop tool source copies under
`${NODEX_HOME}/runtime/agent`. Startup supplies missing feature defaults as process options and
leaves native configuration bytes intact. Nodex tasks use full native execution access;
only an explicit native configuration edit updates Codex settings. Nodex desktop plugins use a
distinct namespace per Profile and are enabled only in its chats.

Sharing a native home does not add all native conversations to the Nodex sidebar. In **Settings >
Conversations**, importing a Codex or Claude conversation creates an independent Nodex chat with copied history
and its own execution identity. Choose a Project or Projectless destination and an existing working
directory; a missing source directory requires a replacement. Continuing the copy leaves the source
conversation unchanged. Existing native connections retain their original identities and read-only
history. Setup migration copies supported configuration and Agent resources to the shared Codex
configuration; it does not import conversation history. Import receipts remain in the Nodex Profile. See
[Native Conversation Import Behavior](product-specs/native-conversation-connection-behavior.md).

## Claude Code instances

Agent settings expose Claude Code with an enabled default instance, executable `claude`, and the
normal Claude configuration directory. Nodex searches the Desktop PATH, then the login-shell PATH
and the native `~/.local/bin/claude` installation when needed. Explicit executable paths and
instance or worktree PATH overrides remain authoritative. Add separate profiles for independent
accounts or gateways. An optional absolute or `~/` config directory sets `CLAUDE_CONFIG_DIR` for
that instance without changing HOME or copying credentials. Run `claude auth login` with the same
config directory to sign in. Restart the task connection after changing executable or account paths.

Use **Settings > Conversations** to import independent copies of Claude Code conversations from
enabled profiles into a Project or projectless chat. The copy retains the source profile as its Agent
and starts its own native session when continued. Imported history and media belong to the Nodex
Profile and remain available after the source conversation is removed.

The official Claude Agent SDK loads user, project, and local configuration, including instructions,
skills, hooks, and MCP servers. Nodex stores instance identity, display name, executable,
config directory, enabled state, custom model declarations and environment overrides in the Profile's `claude_agent_instances`
setting. Use **Agent > Claude Code > Environment variables** for API endpoints, authentication tokens,
and other instance variables. Paste literal `export KEY="value"` or `KEY=value` lines into a row to
import them. Sensitive values are encrypted separately under the selected Profile's `agent-secrets/claude`;
ordinary settings contain only references. Saved secrets can be retained, replaced, or removed.
An empty value overrides inheritance with an empty string; deleting the row restores inheritance.
Custom models pair a concrete ID with a display name and explicit supported effort, Fast, Thinking
and context traits. Adaptive thinking and support for disabling thinking are separate capabilities;
the latter enables Off in the Effort menu. Changes refresh discovery and apply when Claude next
connects, without restarting Nodex. See
[Agent Backend Behavior](product-specs/agent-backend-behavior.md#native-claude-code).

The executable and configuration select trusted user-managed code; enabling an instance does not
attest executable or configuration bytes.
Disabling it prevents new connections and leaves existing durable task bindings explicit.

## OpenCode instances

The default OpenCode instance is enabled for new, unconfigured Profiles and uses the
installed `opencode` executable. Use **Agent > OpenCode** to disable it or configure an instance.
If OpenCode is missing, Nodex can run its official installer after you choose to install it.
Installation uses your operating-system user directory. Nodex verifies the installed
executable and discovers it immediately, without requiring an application restart.
Choose its profile directory or leave it empty for Nodex's isolated
`<Profile>/agents/opencode/<instance-id>` directory. Native provider configuration belongs under
`config/opencode` and authentication/history under `data/opencode` within that directory. Add provider
keys such as `MOONSHOT_API_KEY` or `OPENROUTER_API_KEY` as sensitive environment rows. Nodex stores
explicit secrets through system secure storage; it does not import another OpenCode account.
Native project configuration remains active in the selected execution folder.

Model discovery supports OpenCode 1.x and 2.x and verifies the native metadata it requires.
Nodex reuses a compatible installed executable; the install action leaves version selection
to OpenCode's official installer. Native execution uses full access and automatically answers
permission requests. Unsupported metadata produces a compatibility error with the native
version when available. An incompatible local executable includes an upgrade hint.

The composer's model menu initially shows OpenCode models with native IDs ending in `-free`
and keeps the current selection visible. **Show all models** reveals the other OpenCode models.
Model availability follows the instance's native catalog. Upgrading the executable alone
does not replace cached model data; use **Refresh models** when a newly offered model is missing.
Selecting a model selects
its instance and exposes only its native variants and primary agents. An optional Server
URL connects an externally managed OpenCode HTTP(S) endpoint; configure
`OPENCODE_SERVER_PASSWORD` as a sensitive environment row and optional `OPENCODE_SERVER_USERNAME` when needed. External servers retain their
own account, configuration and history and do not receive Nodex application tools.
See [Agent Backend Behavior](product-specs/agent-backend-behavior.md#native-opencode).

## ACP Agent instances

ACP Agent instances are Profile-local configurations of trusted local code. The current Claude
Agent integration uses a user-managed package root and Node executable; both paths must be absolute.
Nodex canonicalizes them at launch and checks the supported package identity, package version,
entrypoint containment, Node version, and executable-reported Agent version. This is a compatibility
probe, not a package-integrity or dependency-provenance check. Enabling an instance means that the
configured local code is trusted to run as the current user.

Each instance separately chooses whether to inherit the host Claude credential profile or use an
existing isolated home, and whether to inherit standard proxy environment variables. Credential
secrets are never copied into Profile settings. Disabling or deleting an instance prevents new
launches; durable Threads retain their explicit backend binding and report the unavailable instance
instead of silently falling back to another backend.

A Dock-launched app has no repository cwd and therefore uses environment/user
configuration. Malformed, oversized, or non-UTF-8 configuration fails closed
instead of selecting another Profile silently.

The selected Profile owns one absolute settings document at
`${NODEX_HOME}/config.toml`. The default Profile therefore keeps the familiar
`~/.nodex/config.toml` path. A custom or isolated Profile gets a separate
document; project configuration does not overlay its backup, notification,
Git, worktree, execution-host, keyboard, update, or window settings.

An unpackaged Desktop process requires an explicit nonblank `NODEX_HOME` and
does not fall back to project or user configuration. The supported `vp run dev`
launcher supplies an isolated Profile, defaulting to `<worktree>/runs.local/default`
when `--home` is omitted; this prevents a direct low-level development launch
from opening the user's default Profile. Agent-created manual development
instances and Profile snapshots use an explicit absolute `--home` under the
primary repository's `runs.local/<slug>/`, following
[AGENTS.md](../AGENTS.md#worktrees-and-local-artifacts).
Automatic test harnesses retain their fresh temporary Profiles. See
[Development](development.md) for launch commands.

The development launcher persists each home's renderer origin in
`renderer-origin.json` and starts Vite with `strictPort`. An occupied saved port
fails visibly instead of moving IndexedDB to another origin. New homes receive
an available port; an existing home with one localhost IndexedDB origin reuses
it. If several older origins exist, `--renderer-port <port>` explicitly selects
which cache to reopen and persists that choice. No existing origin is deleted.
The port can also be explicitly selected when setting up a new home. Built
Desktop runs continue to use the packaged application origin.

## Main setting groups

The `[server]` table currently owns these product setting families:

- `home` for Profile selection;
- `codex_home` for the selected native Codex directory;
- automatic backup enablement, interval, count retention, and automatic-snapshot byte budget;
- deleted-content history retention compatibility setting;
- automatic app-update checks;
- opt-in diagnostics and optional renderer Session Replay;
- opt-in product telemetry and separately opt-in safe web analytics.

Settings → Backups and Settings → General update the selected Profile document
through serialized typed Main operations. Unrelated TOML sections survive each
atomic replacement, and concurrent setting-family updates cannot overwrite one
another. Existing but malformed, oversized, non-UTF-8, symlinked, or
non-regular documents fail closed and are not replaced. An environment
override captured during bootstrap remains effective and the UI marks the
affected control as managed. Backup scheduling reapplies immediately; settings
that require restart say so in the UI.

## Environment overrides

Supported operational overrides include:

- `NODEX_HOME`;
- `CODEX_HOME` when the Profile has no explicit `server.codex_home`;
- `NODEX_BACKUP_AUTO_ENABLED`, `NODEX_BACKUP_INTERVAL_HOURS`,
  `NODEX_BACKUP_RETENTION`, and `NODEX_BACKUP_RETENTION_GIB`;
- `NODEX_HISTORY_RETENTION` for the retained compatibility setting;
- `NODEX_SENTRY_ENABLED`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`,
  `SENTRY_RELEASE`, `NODEX_SENTRY_TRACES_SAMPLE_RATE`,
  `NODEX_SENTRY_REPLAY_ENABLED`,
  `NODEX_SENTRY_REPLAYS_SESSION_SAMPLE_RATE`, and
  `NODEX_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE`;
- `NODEX_TELEMETRY_ENABLED`, `STATSIG_CLIENT_KEY`,
  `STATSIG_ENVIRONMENT`, and `NODEX_TELEMETRY_AUTOCAPTURE_ENABLED`.

Use the current executable parser for exact boolean/number syntax and bounds.
Do not add a setting to this reference before adding it to the typed parser,
Settings snapshot, and behavioral tests.

## Privacy

Diagnostics, renderer replay, product telemetry, and web analytics are disabled
by default. Replay is effective only when diagnostics are enabled. Web analytics
is effective only when product telemetry is enabled and excludes copy text,
console logs, current-page URLs, forms, clicks, and error/replay payloads from
the default safe event set. The bundled Browser runtime has its own ambient
network policy and is not enabled by Nodex telemetry preferences.

## Related documentation

- [Development](development.md) for local run and isolated Profile commands.
- [Reliability](RELIABILITY.md) for backup, restore, and Profile lifecycle.
- [Security](SECURITY.md) for diagnostics, sandbox, and trust boundaries.
- [Settings Route Behavior](product-specs/settings-route-behavior.md) for UI
  routing and ownership.
