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
launcher supplies an isolated Profile under `runs.local/`; this prevents a
direct low-level development launch from opening the user's default Profile.

## Main setting groups

The `[server]` table currently owns these product setting families:

- `home` for Profile selection;
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
