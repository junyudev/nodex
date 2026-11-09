# ADR 0084: Phones are Member Devices on the Space listener

- Status: Accepted
- Date: 2026-11-07
- Owners: Nodex maintainers
- Supersedes: [ADR 0075](0075-phone-access-through-an-encrypted-gateway.md)
- Builds on: [ADR 0083](0083-one-remote-identity.md)
- Retains: [ADR 0076](0076-mobile-runtime-effect-boundary.md)

## Context

A person must reach their personal Space while its desktop runs and their team
Space while its host runs, independently of their laptop. Separate phone identity,
enrollment and listeners make withdrawal ambiguous and cannot preserve a team's
Member authority through a personal desktop relay.

## Decision

A phone is a Device of a Member in one Space. It enrolls separately in each Space
by redeeming a five-minute, one-time Device-link offer. The versioned phone link
is defined by `@nodex/mobile-protocol` and carries the Space identity and name,
reachable HTTPS routes, leaf certificate fingerprint, code and expiry. The native
transport verifies the complete leaf DER SHA-256 before sending any enrollment,
credential or application bytes. Device credentials use device-only secure
storage; sessions renew through Core's existing Device frontier.

Each Space has one pinned-TLS listener owned by Core. Phones use one authenticated
WebSocket for bounded mobile RPC and observation. Core authenticates the upgrade,
meters Device and Member budgets, and closes streams on Device or Member
withdrawal. Writes recheck current authority. A Core-issued invocation proof binds
the host façade to that Member's admission. Caller JSON and a local Host bearer
cannot substitute for it. Each RPC proof ends with its response or deadline; the
stream's observation proof admits reads only. Service-owned continuations use the
persisted Session and requesting Member, releasing transient request proof before
forking background work.

The phone façade lives with the shared host kernel and uses the same semantic
owners as a team desktop. Main embeds it for the personal Space; `nodex serve`
embeds it for a hosted Space. Core retains content, Actors, receipts, attention and
answer entitlement; the execution owner retains Runs and transcript truth. The
bounded phone view models remain in `@nodex/mobile-protocol`. Unsupported host
operations return a typed unavailable capability, with no personal Runtime,
credentials or filesystem fallback.

The phone catalog, caches, drafts and durable outbox use `(spaceId, memberId)`.
Switching or re-enrolling another Member never delivers an earlier Member's
captures. Removing a Space locally stops its connections and removes its local
state; remote Device revocation is a separate action. There is no old credential
migration or compatibility decoder.

The leaf pin is the phone's only certificate authority, as it is a desktop's. A
self-signed, pinned host is reachable at every address a link carries: a LAN or
tailnet (100.64.0.0/10) IP address, a `.local` or unqualified name, or a DNS name,
on iOS and Android alike. On iOS the pinned transport is Network.framework with its
own TLS verify step, not `URLSession`: App Transport Security governs the URL
Loading System and, during trust evaluation, cancels a certificate the system does
not trust at a tailnet, public or DNS address regardless of the pin, while it does
not evaluate Network.framework. The transport bypasses the URL Loading System by
design; ATS stays at `NSAllowsLocalNetworking` for the app's other traffic, with no
app-wide arbitrary-loads exception. Android uses an isolated OkHttp client. A phone
tries a link's local addresses first, then its tailnet addresses.

## Consequences

Phones and desktops share enrollment, revocation, certificate trust and Member
identity. Core owns personal Remote access intent in private Profile configuration,
shared by Desktop settings and native CLI commands. Core restores its listener
during startup, reusing the saved port and certificate. An occupied port chooses
an available port and reports new routes. Desktop owns no restoration loop.
A phone reaches a team host directly and does not depend on a joined laptop. The
personal desktop or team host must remain running and reachable; a phone reaches
it with the Space's own certificate on the host's network or over a tailnet, with
no certificate authority or trust-store change. Nodex provides no Internet relay
for content, NAT traversal or remote cache wipe. Background notifications are
registrations of the Device in Core, addressed by Core's answer entitlement,
sealed by the host and carried by a push relay that cannot read them.

The Main-only phone registry, pairing secret, Noise channel and separate gateway
listener are removed. The mobile Effect runtime, offline capture and bounded
presentation contracts remain. A future untrusted relay would require a new
shared transport decision rather than a second permanent identity model.
