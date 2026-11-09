# ADR 0083: One remote identity: Member Devices per Space; remote access is not team-ness

## Status

Accepted, 2026-11-07. Supersedes ADR 0075's separate phone identity and listener
ownership decision. [ADR 0084](0084-phones-as-member-devices.md) specifies the phone
façade on Core's Device session frontier; the mobile Effect boundary remains unchanged.

## Context

People use several installations to reach personal and shared Spaces. Treating
a listener as team membership changes attribution rules without another person
joining. Separate phone and desktop identity registries also create competing
enrollment and withdrawal authorities.

## Decision

Core owns one Member/Device/session model per Space for every form factor. One
human has one Member per Space and enrolls each desktop or phone as an independent
Device there. A Device's form factor, label and timestamps convey no authority.
Each Device is revocable independently. The pinned-TLS listener authenticates
session principals and explicitly admits commands; host façades preserve that
verified Member and never substitute a local Host credential.

Remote access is independent of team membership. A personal Space remains personal
while its Owner links their own Devices. A second active Member's enrollment
promotes it to team; removal does not implicitly restore personal Agent fallback.
Headless repository execution is explicit hosting state, independent of either
listener activation or team membership.

An authenticated Member may mint a five-minute, one-time self-link offer bound
to their Member. The writer enforces a 16 active-Device cap, including outstanding
reservations, and six offers per Member per hour. It rechecks membership and cap
at redemption. The offer includes Space identity, pin, reachable routes and expiry.
It cannot mint another Member or confer a different role.

Owners may invite, inspect membership and Devices, revoke any Device, remove
another Member and rename through remote sessions. Members may list and revoke
their own Devices and choose their own display name; a stored name is never the
relative word "You". Writer transactions recheck current role, Device ownership and
revocation; administrative writes seal T1 Member Actor evidence. Listener control,
certificate/key management, backups and shutdown remain local. Personal Remote
access uses an explicit private/loopback/CGNAT/link-local peer policy; operator
hosting retains its own policy.

## Consequences

Main, the native CLI and desktop Settings share Space-qualified administration.
A phone can adopt these contracts without adding another identity model or making
the laptop a relay for a team host. Each Space needs its own Device enrollment,
credential and certificate trust. Revocation ends future access and live responses;
it does not remotely erase downloaded content. Direct reachability still requires
an available host and suitable LAN, tailnet or operator network routes.
