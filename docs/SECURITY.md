# Security

## Threat Model
Nodex is local-first. Main risks are malformed local inputs, accidental data loss, unintended exposure of the local HTTP API, and unsafe command/file-change approvals during Codex thread execution.

## Security Controls in Place
- Input validation for card writes (`card-input-validation.ts`).
- HTTP body limits for mutation and image-upload routes.
- Browser-origin checks for mutating HTTP requests (trusted local dev origins only).
- Restrictive CORS policy for browser access (trusted local dev origins only).
- Read-only guard on SQL query endpoint.
- Read-only SQL result-size cap to avoid large memory responses.
- Electron preload bridge limits renderer access to a typed API surface.
- Stable asset URI scheme avoids embedding brittle absolute local URLs.
- Codex approvals are explicit protocol responses (`accept`/`decline`/etc) and are gated by the per-project Threads permission mode.
- Codex user-input requests are never auto-answered and require explicit renderer interaction.

## Current Gaps
- No built-in authentication on the local HTTP API.
- No role-based access control model (single-user/local trust assumption).
- Security logging/auditing is still local-only and not audit-grade, but backend logs now redact common secret-bearing fields (for example authorization headers, tokens, API keys, passwords, cookies, and session values) before writing JSON-line log records.
- `full-access` mode is convenience-first and auto-accepts any approval requests that still surface.
- Workspace path allow-listing/sandboxing is not enforced beyond user-configured project `workspacePath`.

## Safe Operating Practices
- Bind HTTP server to loopback-only contexts where possible.
- Do not expose the local API port publicly without external controls.
- Keep dependencies updated (`bun update` cadence).
- Use manual backups before destructive operations.

## Hardening Backlog
- Optional API token gate for CLI/browser calls.
- Basic security smoke checks in CI (write-limit and read-only query assertions).
- Approval policy profiles (for example, command/file-change scopes and allow-lists) beyond the current `sandbox`/`full-access`/`custom` permission presets.
- Additional execution boundary controls for Codex subprocess invocations.
