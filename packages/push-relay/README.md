# Nodex Push Relay

The relay at `https://push.nodex.jyu.app` forwards encrypted Nodex Mobile notifications to Apple Push
Notification service (APNs). It has no database and no runtime dependencies. Its two Vercel Node.js
functions use only Node built-ins, including `node:http2` for APNs.

## Delivery contract

- `POST /v1/devices` accepts `{ token, environment, bundleId }` and returns `{ handle }`. Tokens are
  32–200 hexadecimal characters; environment is `sandbox` or `production`. Only
  `app.jyu.nodex.mobile` and `app.jyu.nodex.mobile.dev` are allowed.
- A handle is base64url of a version byte (`1`), a random 12-byte nonce, a 16-byte authentication
  tag, and the AES-256-GCM ciphertext of the registration JSON. Authenticated additional data is
  `nodex-push-device:v1`. The desktop cannot open it. Keep handles private: possession authorizes
  sending to that phone. Handles do not expire; changing the seal key invalidates every handle,
  so phones must register again and share their replacement handles with their desktops.
- `POST /v1/push` accepts `{ handle, sealed, urgency }`. Urgency is `active` or `time-sensitive`.
  The relay opens the handle to obtain the token, environment and topic, and makes exactly one
  APNs request. Production uses `api.push.apple.com`; sandbox uses `api.sandbox.push.apple.com`.
- Every request uses `apns-push-type: alert`, `apns-priority: 10`, and the registered bundle ID as
  `apns-topic`. The provider JWT uses ES256 and is reused within each warm function for 45 minutes.
- The APNs JSON body is `{ aps: { alert: { title: "Nodex", body: "You have an update." },
  "mutable-content": 1, sound: "default", "interruption-level": urgency }, n: sealed }`.
  Only the phone and its desktops hold the notification key. The relay never decrypts `sealed`;
  the iOS Notification Service Extension reads `n` and replaces the placeholder alert.
- Raw HTTP bodies are limited to 8192 bytes, including unknown fields and whitespace. The complete
  serialized APNs body is limited to 4096 UTF-8 bytes, including JSON escaping. Overflow returns
  `413` with `BodyTooLarge` or `PayloadTooLarge` in `reason`.

| Outcome                                                               | HTTP response                          |
| --------------------------------------------------------------------- | -------------------------------------- |
| APNs accepts the request                                              | `200 { "ok": true }`                   |
| APNs `410`, or `400` with `BadDeviceToken` / `DeviceTokenNotForTopic` | `410 { "gone": true }`                 |
| APNs throttles                                                        | `429 { "reason": "…" }`                |
| APNs `5xx`, connection failure, reset, or 10-second timeout           | `503 { "reason": "…" }`                |
| Handle cannot be authenticated                                        | `400 { "reason": "InvalidHandle" }`    |
| Invalid request fields or unauthorized bundle                         | `400 { "reason": "…" }`                |
| Other APNs `4xx`                                                      | Same status, with a short `reason`     |
| Missing or invalid relay configuration                                | `503 { "reason": "RelayUnavailable" }` |
| Non-POST method                                                       | `405`, with `Allow: POST`              |

Retryable responses include `Retry-After: 60`. The desktop owns retries and forgetting gone
handles. Logs contain only status and recognized APNs reason codes; never tokens, handles,
sealed payloads, upstream response bodies, or raw transport errors. The relay has no account
authentication, registration store, deduplication, or per-device rate limit.

## Deploy with the Vercel CLI

Prerequisites: a Vercel account with access to `push.nodex.jyu.app`'s DNS, and an Apple APNs signing key
(`AuthKey_<KEY_ID>.p8`) authorized for both Nodex bundle IDs and the required APNs environments.
Its team ID is `8HGUT3HC4Z`. Real delivery also needs a physical phone registered for the selected
environment and the signed app's Notification Service Extension.

Start at the repository root and use the Vercel scope that owns the project:

```sh
cd packages/push-relay
npx vercel@latest login
npx vercel@latest link
```

In `link`, select the owning scope and create a project named `nodex-push-relay` (or link that
existing project). Keep its root directory at this package directory and framework preset at
**Other**. `vercel.json` enables Fluid compute for the Web Standard function entrypoints and the package pins
Node `24.x` through `engines.node`. The package declares no dependencies, because Vercel installs
whatever `package.json` names and cannot resolve workspace ones; its tests reach
`@nodex/mobile-protocol` through the repository root. This directory alone is sufficient for
deployment; neither the desktop nor Expo needs building.

Generate a seal key in a private, Git-ignored file, without printing or putting it in shell history.
The command refuses to overwrite an existing file:

```sh
(umask 077; set -C; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))' > .env.seal-key)
npx vercel@latest env add PUSH_RELAY_SEAL_KEY production --sensitive < .env.seal-key
npx vercel@latest env add APNS_KEY_P8 production --sensitive < /absolute/path/to/AuthKey_KEYID.p8
npx vercel@latest env add APNS_KEY_ID production
npx vercel@latest env add APNS_TEAM_ID production --value 8HGUT3HC4Z
```

At the `APNS_KEY_ID` prompt, enter the Apple key's ten-character key ID. `APNS_KEY_P8` must contain
the complete PEM text with actual newlines. `PUSH_RELAY_SEAL_KEY` is standard padded base64 of
exactly 32 random bytes. Back up `.env.seal-key` in the team's secret manager, then delete the local
file with `rm .env.seal-key`; Vercel's sensitive values cannot be read back. Use the same key across every
production deployment. For preview testing, repeat the four `env add` commands with `preview`
instead of `production`, using a separate seal key.

Attach the domain, configure the DNS records printed by the CLI at your DNS provider, then deploy:

```sh
npx vercel@latest domains add push.nodex.jyu.app nodex-push-relay
npx vercel@latest domains inspect push.nodex.jyu.app
npx vercel@latest deploy --prod
npx vercel@latest domains inspect push.nodex.jyu.app
```

Production deployment assigns the project's domain automatically. Production must be publicly
reachable by native apps: do not enable Vercel Authentication/password protection on the production
domain. Requests go to `/v1/devices` and `/v1/push`; `vercel.json` rewrites them to the functions.
Updating an environment variable affects new deployments; run `deploy --prod` again after a change.
Do not send a real token in a URL, terminal transcript, or deployment verification log.

See Vercel's [Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions),
[Node functions](https://vercel.com/docs/functions/runtimes/node-js),
[environment CLI](https://vercel.com/docs/cli/env), and
[domain CLI](https://vercel.com/docs/cli/domains) documentation.

## Development checks

From the repository root:

```sh
vp install --frozen-lockfile
vp test run --config vitest.node.config.ts packages/push-relay/src/relay.test.ts
vp run typecheck
vp run fmt:check
vp run verify:static
```

Tests use generated signing keys and a local HTTP/2 server, including failures and timeouts.
`@nodex/mobile-protocol` is used only by tests, to check the hand-written validators against the
shared schemas. No production module imports it. Real APNs delivery and Vercel
deployment require the operator credentials above and are separate from these local checks.
