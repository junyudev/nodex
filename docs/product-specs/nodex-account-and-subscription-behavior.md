# Nodex Account and Model Access

- Status: Active
- Last updated: 2026-10-30
- Decision: [ADR 0070](../adr/0070-optional-cloud-account-and-subscription-authority.md)

## Experience

A person signed in with their Nodex Account can explicitly choose GPT-6.1 Sol,
GPT-6 Luna or Claude Opus 5.5 from the existing model picker. All three have the
Nodex source label and mark. The GPT models use the existing Codex app-server
driver; Claude uses the existing Claude Agent SDK driver and its bundled runtime.
They run with the same conversation, tool and workspace behavior as those drivers.

Signed-out users see no Nodex models. Native Codex, Claude, OpenCode and ACP
setups remain independent. Automatic defaults never select a prepaid model.
An unavailable saved choice fails explicitly rather than spending through a
different account or silently choosing another provider.

Settings → Account shows remaining USD credit and one Top up action. The rail
account menu shows the same credit compactly with Top up. Top up opens
`https://console.nodex.jyu.app/topup` in the system browser. Returning from the
console does not grant local credit; the next balance read obtains the gateway's
current wallet amount. A failed balance read displays an unavailable value.
Exhausted credit becomes a run error directing the person to Top up in
Settings → Account. Desktop does not make an optimistic balance deduction or
retry a rejected request against another key.

## Authority and contracts

Clerk owns cloud identity and OAuth grants. The current account identity is
`(issuer, subject)`; email is display data. Main owns the Profile's credential
lifecycle, secure persistence and generation fence. Rust Core owns Library
content and Session placement. Agent Runtime owns execution and history.
Signing in does not upload, claim or reassign local content.

The Nodex API verifies the Clerk OAuth access token and issues the signed-in
user's gateway access. sub2api owns billing, the prepaid wallet, usage accounting
and gateway admission. Credit is purchased through the web console. There is
no Desktop subscription authority, self-built Nodex usage ledger, local usage
grant/reservation system or recurring-plan projection.

`POST https://api.nodex.jyu.app/v1/model-access` takes
`Authorization: Bearer <Clerk OAuth access token>` and returns `apiKey`,
`openaiBaseUrl`, `anthropicBaseUrl`, `models`, `consoleUrl` and `topUpUrl`.
The protocol URLs are `https://api.jyu.app/v1` for OpenAI Responses and
`https://api.jyu.app` for Anthropic. One key serves both protocols. Desktop
accepts only the three declared model IDs with their expected protocols;
additional server models do not expand this catalog automatically.

Errors have the shape `{error: {code, message}}`: `unauthenticated` (401),
`forbidden_client` (403), `email_unverified` (403) or `unavailable` (503).
Model-access failure does not undo a valid local login or block local work.
Responses are bounded, requests time out, redirects are rejected and raw
backend messages never enter account IPC observations.

`GET https://api.jyu.app/v1/usage` uses the gateway API key as its Bearer token.
Wallet-backed responses include numeric `balance` and `unit: "USD"`. Main
reads credit on access acquisition, explicit Account refresh and periodic
account maintenance. The displayed amount is an observation, never permission
to spend. Concurrent devices and actual model costs are enforced by sub2api.

## Managed execution and retirement

Main exchanges only a verified current OAuth identity and saves gateway access
with its encrypted OAuth credential envelope, bound to issuer, client and
Profile. A restored key becomes usable only after identity verification.
When secure storage is unavailable, credentials remain in memory and no
plaintext fallback is written. Renderer receives identity, credit and categorical
errors, and calls semantic commands such as `openTopUp`; it receives no key,
custom endpoint or arbitrary browser-opening capability.

Main declares two managed instances outside user Agent settings. Their identities
and private homes are account-specific. A strict environment carries only host
execution essentials and the managed credentials. Codex uses a custom provider
with `wire_api = "responses"`, `base_url = openaiBaseUrl`, `env_key` and no OpenAI
authentication. Claude receives `ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN`, uses its isolated config directory and excludes filesystem
settings that could replace the managed connection. Native account homes and
credentials are never copied into managed homes.

The key travels directly to the managed processes, not through a local proxy.
It spends only the same user's prepaid wallet. Provider processes necessarily
hold it while executing; the gateway remains responsible for remote key
revocation and spending enforcement. Account retirement first closes request
admission, stops managed Runs and native sessions, then removes instances and
private credentials. If retirement cannot be confirmed through the execution
connection, Main stops that process before releasing the key. Old-generation
OAuth, key or balance responses cannot restore retired access or overwrite a
new account's observation. Local conversation history remains readable.

## Verification

Focused Main tests cover private exchange/persistence, restored-identity
verification, retirement and late-response generation fences. Runtime tests
cover catalog constraints, admission and busy-instance retirement. Picker tests
cover exact Codex/Claude instance identity, allowlisted choices and automatic
default exclusion. Act-clean Account tests cover credit and semantic Top up.
Electron account fixtures provide fake model-access and usage endpoints for
login, credit, Top up, restart and sign-out without paid model calls.

Production gateway availability, payment checkout and real paid inference need
separate deployment acceptance. Desktop test fixtures do not prove those services.
