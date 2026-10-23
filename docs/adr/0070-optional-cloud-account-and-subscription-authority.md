# ADR 0070: Optional cloud accounts and server-owned subscription access

- Status: Proposed cloud subscription authority; native login implemented separately
- Date: 2026-10-22
- Owners: Nodex maintainers
- Preserves: [ADR 0068](0068-agent-runtime-execution-authority.md)

The native identity-only slice is implemented under
[Nodex Account Login](../product-specs/nodex-account-login-behavior.md).
The cloud Account mapping, subscription and paid-model authority in this ADR
remain proposed; native login alone grants none of those capabilities.

Nodex needs an optional first-party account through which a person can buy and
use Nodex-provided model capacity. A local Profile already owns its Library,
and native Agent Instances already own their provider authentication. Making
either depend on a cloud subscription would couple local work to unrelated
identity, network and payment availability.

Use Clerk for cloud identity and Stripe Billing for recurring payments. Nodex
Cloud owns its stable Account identity, subscription access and model usage
ledger. Electron Main owns the current Profile's optional account connection;
Core continues to own local content and the Agent Runtime continues to own
execution. Cloud sign-in, sign-out, account deletion and payment failure do not
claim, migrate or remove local content or native provider credentials.

Prefer system-browser OAuth with PKCE and a temporary loopback callback over
embedding Clerk's Electron UI. This keeps authentication independent of local
startup and lets Nodex retain its existing Profile, window and process
lifecycle. Native clients use revocable opaque Clerk access tokens, verified
online by the cloud boundary. The initial design does not introduce a second
Nodex refresh-token system. This trades an online identity dependency for
clear revocation behavior on paid requests; local work remains independent.

Stripe payment evidence creates idempotent, time-bounded usage grants in the
cloud ledger. Every model request reserves capacity before dispatch and
settles from trusted usage evidence. Client flags, a Checkout return URL,
cached subscription state and local Profile identity cannot authorize paid
consumption. Auth, subscription status and spendable capacity remain distinct.

First-party model access uses an explicit managed Agent Instance. An isolated
OpenCode instance is the preferred feasibility path because it can reuse the
existing execution loop and tool integration. It must pass protocol,
credential, request-attribution and distribution validation before production
Checkout is enabled. The proposal does not add a second conversation owner or
reinterpret the existing Codex/Claude accounts.

The complete proposed behavior, Interfaces, rollout gates and unresolved
commercial inputs live in
[Nodex Account and Subscription Behavior](../product-specs/nodex-account-and-subscription-behavior.md).
