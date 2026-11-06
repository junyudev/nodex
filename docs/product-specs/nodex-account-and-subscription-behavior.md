# Nodex Account and Model Access

- Status: Active
- Last updated: 2026-10-31
- Decision: [ADR 0070](../adr/0070-optional-cloud-account-and-subscription-authority.md)

## Experience

A person signed in with their Nodex Account can explicitly choose GPT-6.1 Sol,
GPT-6 Luna, Claude Opus 5.5 or Claude Sonnet 5.5 from the existing model picker. All four have the
Nodex source label and mark. The GPT models use the existing Codex app-server
driver; Claude uses the existing Claude Agent SDK driver and its bundled runtime.
They run with the same conversation, tool and workspace behavior as those drivers.

Signed-out users see no Nodex models. Native Codex, Claude, OpenCode and ACP
setups remain independent. Automatic defaults never select a prepaid model.
An unavailable saved choice fails explicitly rather than spending through a
different account or silently choosing another provider.

People spend Nodex credits, not dollars. A credit balance is a whole number with
no currency sign, so a fraction of a credit is never shown as something left to
spend. The server sets the rate (`creditsPerUsd`, 25 today); dollars appear only
where money changes hands, on a Top up tile and on Stripe's page.

The rail shows a Nodex credits meter below the provider usage meters and above
the account avatar: the Nodex mark inside a ring that empties as credits since the
last top-up are spent, quiet until they run low. Its card shows the balance and
one Top up action; the meter and that action open Settings → Account. There the
balance sits above every server-defined tier, laid out without a menu: the section
states the rate (`25 credits = $1`), each tile reads dollars first and credits second
(`$10` · `275 credits +10%`), and choosing one starts Checkout. Unavailable tiers
stay visible and disabled; paused supply reads “Top up is paused.” The account menu
keeps identity and settings only. Choosing an available tier asks Main to create a
Stripe Checkout and open its returned URL in the system browser. Account management
requires no website or web console.

**Model prices** sits below the tiers and shows what each model costs in credits per
1M tokens: input, cache hit, cache write and output. Hovering a price shows it in
dollars. Prices come only from the server, so a change needs no Desktop release, and
they keep the decimals they need, because only a balance rounds to whole credits. A
column appears only when some model has that price, and a missing price reads `—`.
Each row is something a person can actually run:

- The header's `×1 API list price` stands for every unmarked row.
- A rate on the only group, such as OpenAI models at `×0.5`, marks those rows, shows
  the charged price in green and crosses out the list price beneath it.
- A separate group adds a row named for the group under each model it includes. The
  list price is then already on the row above, so nothing is crossed out.
- When no single factor explains a model's prices, its row claims no rate and shows
  only the charged and crossed-out list prices.

An unavailable model or group stays listed, dimmed, with “Unavailable”. When the
server sends no prices, or malformed ones, the section is absent and Top up keeps
working; Desktop never falls back to prices of its own.

Main observes credit on opening Account settings, on window focus while a credit
surface is mounted, during regular maintenance while the rail credit meter is
enabled, and every ten seconds for up to five minutes while a Checkout is pending. A higher observed balance completes that
pending state. Closing the UI does not stop payment observation. Expiry, sign-out
and account replacement retire pending observation; a canceled Checkout never
leaves an unbounded fast poll. A browser return does not grant credit. A failed
balance read displays an unavailable value; Desktop never deducts or grants
credit optimistically or retries against another key.

Upstream model supply is finite. Models marked unavailable remain listed with
“Unavailable” and cannot be selected. Main reads public supply at startup and
every minute, and rechecks when account/model surfaces open or the app regains
focus, sharing a thirty-second status cache across windows. Missing or failed
status observations disable Nodex model choices until supply can be observed
again. Availability does not depend on the user's displayed wallet balance.

The gateway reports exhausted user credit as HTTP 403 with
`{"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}`.
Only this `INSUFFICIENT_BALANCE` code, or the Claude SDK's explicit
`403 insufficient balance` representation, means the user's own credit is
exhausted and directs them to Top up in Settings → Account. Other Nodex failures,
including OpenAI `insufficient_quota`, Anthropic “credit balance is too low”,
no available upstream accounts, rate limits, server errors and network failures,
report temporary Nodex model unavailability without a Top up suggestion.

## Authority and contracts

Clerk owns cloud identity and OAuth grants. The current account identity is
`(issuer, subject)`; email is display data. Main owns the Profile's credential
lifecycle, secure persistence and generation fence. Rust Core owns Library
content and Session placement. Agent Runtime owns execution and history.
Signing in does not upload, claim or reassign local content.

The Nodex API verifies the Clerk OAuth access token and issues the signed-in
user's gateway access. sub2api owns billing, the prepaid wallet, usage accounting
and gateway admission. Nodex creates in-app Stripe Checkout purchases through its API. There is
no Desktop subscription authority, self-built Nodex usage ledger, local usage
grant/reservation system or recurring-plan projection.

`POST https://api.nodex.jyu.app/v1/model-access` takes
`Authorization: Bearer <Clerk OAuth access token>` and returns `apiKey`,
`openaiBaseUrl`, `anthropicBaseUrl` and `models`.
The protocol URLs are `https://api.jyu.app/v1` for OpenAI Responses and
`https://api.jyu.app` for Anthropic. One key serves both protocols. Desktop
accepts only the four declared model IDs with their expected protocols;
additional server models do not expand this catalog automatically.

Errors have the shape `{error: {code, message}}`: `unauthenticated` (401),
`forbidden_client` (403), `email_unverified` (403) or `unavailable` (503).
Model-access failure does not undo a valid local login or block local work.
Responses are bounded, requests time out, redirects are rejected and raw
backend messages never enter account IPC observations.

`GET https://api.nodex.jyu.app/v1/status` is public and returns
`{creditsPerUsd, pricing?, models: [{id, available}], topUp: {available, currency: "USD", tiers: [{amount, credit, available}]}}`.
It advertises supply, not spending authority. A tier's `credit` and the wallet
stay in USD, and Desktop converts them for display with `creditsPerUsd`; a status
without a valid rate is a failed observation. Main keeps the last rate it saw, so a
status outage closes supply without taking a known balance off the screen. `pricing`
is `{currency: "USD", perTokens, notes: [string], groups: [{id, label, description,
available, models: [{id, label, provider, reference, effective, multiplier}]}]}`,
where `reference` and `effective` each hold `input`, `cacheRead`, `cacheWrite` and
`output`, with `null` for a price the provider doesn't charge. `reference` is the
official API price and `effective` what the group charges now, both resolved by the
gateway's billing, so Desktop formats prices and never computes them. `multiplier`
is set only when one factor explains every price. Pricing is validated on its own:
a malformed table is dropped without affecting supply or Top up, and it never
affects model admission or Checkout. `POST /v1/checkout` at the same
origin uses the Clerk Bearer token and `{amount}`, returning `{url}`. Main
validates the chosen amount against current available tiers and accepts only
HTTPS Stripe Checkout destinations. Checkout errors are `unauthenticated` (401),
`forbidden_client` (403), `tier_unavailable` (409) and `unavailable` (503).
These failures leave wallet credit intact and are projected as categorical UI
states; raw backend details and Checkout URLs never enter renderer snapshots.
Concurrent Checkout creation is coalesced and late responses cannot open a
browser or restore pending state after account retirement.

`GET https://api.jyu.app/v1/usage` uses the gateway API key as its Bearer token.
Wallet-backed responses include numeric `balance` and `unit: "USD"`. Main
reads credit on explicit Account refresh, credit-surface focus, bounded
pending-Checkout polling, and periodic account maintenance while the rail meter is enabled. The displayed amount is an observation, never permission
to spend. Concurrent devices and actual model costs are enforced by sub2api.

## Managed execution and retirement

Main exchanges only a verified current OAuth identity and saves gateway access
with its encrypted OAuth credential envelope, bound to issuer, client and
Profile. A restored key becomes usable only after identity verification.
When secure storage is unavailable, credentials remain in memory and no
plaintext fallback is written. Renderer receives identity, credit and categorical
errors and supply status, and calls semantic commands such as `openTopUp(amount)`; it receives no key,
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
connection within 30 seconds, Main stops that process before releasing the key. Old-generation
OAuth, key, Checkout or balance responses cannot restore retired access or overwrite a
new account's observation. Local conversation history remains readable.

## Verification

Focused Main tests cover private exchange/persistence, restored-identity
verification, retirement, Checkout authentication/destinations/errors, bounded
payment polling, status caching and late-response generation fences. Runtime
tests cover error semantics, catalog constraints, admission and busy-instance
retirement. Picker tests cover unavailable rows, exact instance identity,
allowlisted choices and automatic default exclusion. Act-clean Account tests
cover whole-credit balances, tiers, paused supply, model prices at each rate shape,
absent pricing, focus refresh and pushed credit updates. Electron
account fixtures provide fake model-access, status, Checkout and usage endpoints
for automatic payment observation, live supply changes, restart and sign-out
without paid model calls.

Production gateway availability, payment checkout and real paid inference need
separate deployment acceptance. Desktop test fixtures do not prove those services.

The Profile's **Nodex credits** switch in Settings → General → Usage meters controls the rail meter and its periodic balance reads. Turning it off preserves OAuth renewal, managed model access, and the public model and top-up supply refresh. Account settings and pending Checkout still read credit, and enabling the meter reads once immediately. Only credit surfaces refresh balance on window focus; observing identity or model access does not.
