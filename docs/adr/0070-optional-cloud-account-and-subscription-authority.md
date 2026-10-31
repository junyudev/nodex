# ADR 0070: Optional Nodex accounts and prepaid model access

- Status: Accepted
- Date: 2026-10-30
- Owners: Nodex maintainers
- Preserves: [ADR 0068](0068-agent-runtime-execution-authority.md)

## Decision

Clerk owns Nodex identity. The optional Profile-scoped Main account owner uses
system-browser OAuth with PKCE, verifies identity, and privately persists its
credentials. Local content, startup and user-configured Agents remain independent.

`api.nodex.jyu.app` exchanges the Clerk OAuth access token at
`POST /v1/model-access` for that user's gateway API key. sub2api owns the billing,
prepaid wallet, usage ledger and model gateway at `api.jyu.app`. Credit is
purchased inside Desktop: Main reads supply and tiers from public `GET /v1/status`,
creates an authenticated `POST /v1/checkout` through `api.nodex.jyu.app`, and opens
the returned Stripe Checkout in the system browser. No web console is required.
Main automatically observes wallet credit through `GET /v1/usage`, including
focus refresh and bounded polling while payment is pending. Desktop neither
implements a ledger nor treats
a checkout return, cached balance or local flag as spending authority. The
gateway authorizes every model request and rejects exhausted credit.

Two account-specific managed provider instances reuse the existing Codex
app-server and Claude Agent SDK drivers. They appear as one Nodex source with
GPT-6.1 Sol, GPT-6 Luna, Claude Opus 5.5 and Claude Sonnet 5.5. Runtime instance identity survives
picker selection; a model allowlist constrains catalog observations and request
admission. Managed models require explicit selection and are excluded from
automatic defaults. User-configured Codex, Claude, OpenCode and ACP instances
retain their existing credentials and configuration.

Supply is finite and independent of user credit. Unavailable models and tiers
remain visible but disabled; a failed supply read cannot advertise availability.
Only gateway-confirmed `INSUFFICIENT_BALANCE` (including Claude's explicit
`403 insufficient balance`) means the user's credit is exhausted. Upstream
quota, balance, capacity, transport and server failures mean Nodex models are
temporarily unavailable and never suggest Top up.

## Credential tradeoff

This release injects the per-user gateway key directly into the managed driver
processes over the private Main-to-Runtime pipe. A local forwarding proxy is not
used. The key can spend only the signed-in user's own prepaid credit. Main owns
its encrypted persistence using the existing secure-storage capability, with
memory-only operation when encryption is unavailable. Neither renderer IPC,
configuration files, command-line arguments nor provider catalog snapshots
contain the key. Each account has separate private managed homes; managed
processes do not inherit the user's provider credentials or account homes.

Sign-out, invalid identity and account replacement close admission and stop
managed execution before dropping the key and provider instances. Retired
asynchronous exchanges cannot republish or persist credentials. Direct injection
means a running provider necessarily holds the key, and local sign-out cannot
revoke a copy obtained outside the application; server-side key revocation and
spending enforcement belong to the gateway. Isolation and process retirement
bound the desktop lifecycle without claiming that a desktop client is a secret
vault against its own user.

The current contract and verification boundaries are specified in
[Nodex Account and Model Access](../product-specs/nodex-account-and-subscription-behavior.md).
The OAuth protocol remains owned by
[Nodex Account Login](../product-specs/nodex-account-login-behavior.md).
