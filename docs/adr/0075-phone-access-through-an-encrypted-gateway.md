# ADR 0075: Phones reach a Profile through an encrypted Desktop Host gateway

- Status: Superseded by [ADR 0084](0084-phones-as-member-devices.md)
- Date: 2026-11-04
- Owners: Nodex maintainers

## Context

People want to capture to the Inbox, start chats and follow running chats from a phone. Everything
a phone would act on lives on the desktop: Core owns content and Sessions, the Agent Runtime owns
Runs, and Agents use the computer's accounts and files. A phone that can start a chat can run
commands on that computer, so this surface is as sensitive as the computer itself.

Core's local endpoint is Profile-private and renderer IPC is
limited to owned windows. A phone on Wi-Fi cannot use either, and plain HTTP on a shared network
would expose every message and any bearer credential to anyone on that network. Certificates do not
fit: a private address cannot get a public one, and pinning a self-signed one needs native TLS code
on each platform. Requiring a tunnel such as Tailscale would exclude ordinary home Wi-Fi.

## Decision

A Main Module, the Mobile Gateway, is the personal Space phone ingress, separate from Core team TLS. It is off by default per Profile and
is a human ingress: its calls carry no Agent provenance and pass through the same application
Interfaces as the personal Space's local Member. Team Spaces are unavailable on this channel. It adds no data authority and reimplements no Core or Runtime
semantics. A phone sees view models owned by `@nodex/mobile-protocol`, which decouple its version
from Core and Runtime shapes.

Traffic is one WebSocket carrying a Noise channel, so transport trust is not required on any network.

- Pairing uses `Noise_IKpsk1_25519_ChaChaPoly_SHA256`. The QR code carries the Host's static public key
  and a one-time secret, which pins the Host from the first message and lets it reject a wrong
  secret immediately.
- Every later connection uses `Noise_IK_25519_ChaChaPoly_SHA256`. A device's identity is its static
  key; revocation forgets the key and closes its channels. No bearer credential exists to steal.
- The first handshake message can be replayed. A Host therefore grants nothing, consumes no offer and
  registers no device until an authenticated transport frame arrives, and that frame requires the
  phone's ephemeral key. The phone speaks first after the handshake for this reason.
- A route's address carries no trust. Phones race their saved routes and identity comes from the
  handshake, so a stale address owned by another machine simply fails.

Lists follow change signals plus re-reads. An open chat follows a bounded snapshot plus patch
operations, and any gap or reconnect replaces the snapshot. Neither has resume cursors, since a
re-read over this channel costs less than the machinery to resume one.

## Consequences

- There is one more inbound frontier, listed in the [external frontier ledger](../effect-external-frontiers.md)
  and specified in [Security](../SECURITY.md#phone-access).
- The app works only while the desktop runs and shares a network or tailnet with the phone. This is
  stated in [Nodex Mobile Behavior](../product-specs/mobile-companion-behavior.md).
- A relay could later carry the same channel without being trusted with its content, which is the path
  to reachability away from home. Notifications use a separate push relay that cannot read their
  content; see [Security](../SECURITY.md#mobile-gateway).
- Native connected conversations stay readable but not continuable from a phone until their ownership
  and reconnect semantics are worked out.
