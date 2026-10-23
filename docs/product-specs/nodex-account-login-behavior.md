# Nodex Account Login Behavior

- Status: Active
- Last updated: 2026-10-23

## Scope

Desktop can optionally connect a local Profile to a Clerk identity from
the rail's account menu or Settings → Account. Local startup, content, backups,
export and local CLI operations remain independent of that connection. Codex,
Claude Code and other native Agent accounts keep their existing homes and authentication.

This slice supplies sign-in, identity display, refresh, encrypted persistence
and sign-out. It does not enable purchases, grant model capacity, upload the
Library or introduce a cloud Account database. The current identity is the
pair `(issuer, subject)`. A future cloud service maps that pair to its own
Account ID and independently verifies access before authorizing spending; see
the [subscription proposal](nodex-account-and-subscription-behavior.md).

## Account entry points

The bottom rail avatar opens an account menu beside the rail. Settings remains
available in every account state, including an unconfigured or offline build.
When an identity is remembered, the menu begins with that identity and opens
Account settings from its header. Its account actions follow the current
connection: sign in, cancel the pending browser login, sign in again, or sign
out. These actions only affect the Nodex connection.

The menu and Account page use the same identity and avatar presentation. An
available HTTPS profile image is preferred; an unavailable image falls back to
initials. The rail shows the Nodex icon when no account identity is available.
Sign-out removes the prior identity from both surfaces. The menu supports keyboard navigation,
outside dismissal, Escape and focus restoration through the shared menu
primitive. Settings navigation preserves the Workbench return route.

Native Codex login and quota controls remain separate. The Nodex menu does not
present a subscription plan, remaining quota or purchasing action before those
capabilities have a cloud authority.

## Ownership and public Interface

The Profile-scoped Main `NodexAccount` Module owns the connection, generation,
pending browser login, refresh lane and observation stream within the existing
application Scope. Node and Electron Adapters own HTTP, the loopback listener,
OS browser handoff and encrypted filesystem access. Core owns no OAuth state.

Trusted top-level application renderers can read and observe a public snapshot,
start or cancel sign-in, refresh identity and sign out. They cannot choose an
issuer, supply a token, read a credential file or invoke arbitrary authenticated
requests. Snapshots contain a monotonic revision, configuration availability,
auth status, identity, connection availability, persistence mode and a bounded
error code. The avatar menu and Account settings share the same identity,
pending action and error state. Renderer owners reject older query and command
responses, including read failures, after a newer observation. Local status
reads, cancellation and sign-out remain callable while the renderer is offline.
Closing the menu or leaving Account settings does not cancel a browser login.

## Browser sign-in

Deployment configuration supplies a public OAuth client ID and HTTPS Clerk
issuer. Missing or invalid configuration leaves local work available. An
unconfigured Profile performs no identity discovery or login network request.

Each attempt binds an ephemeral `127.0.0.1` listener, generates independent
state and an S256 PKCE verifier, and opens the system browser. The registered
redirect is `http://127.0.0.1/callback`; the actual request includes the random
port. Clerk hosts the authentication and consent screens. The desktop requests
`openid profile email offline_access` and never embeds a client secret.

Discovery must match the configured issuer. Token, user-info and revocation
requests stay on that origin, reject redirects, bound response size and time,
and never expose raw responses through IPC. The access token is verified by
Clerk's user-info endpoint before the identity is adopted. ID tokens are not
used as authorization evidence. This identity check does not authorize any
future subscription service.

The callback accepts only the expected method, host, path, state and one code.
Malformed or unrelated callbacks do not consume a valid attempt. Its response
only acknowledges receipt; successful token exchange and identity verification
are reflected in Desktop. Cancellation, timeout and Scope closure release the
listener. Newly issued credentials remain owned by the attempt until Main
adopts them under the matching generation; abandoned credentials receive
bounded revocation cleanup.

## Persistence, refresh and sign-out

Main uses the existing `SecretEncryption` Adapter to persist credentials under
the selected Profile's private `account` directory. Encryption must be
available; Linux `basic_text` is rejected. The regular credential file is
written atomically with restrictive permissions and bound to Profile path,
issuer and OAuth client. Credentials never enter content storage, provider
homes, backups, exports, diagnostics or renderer snapshots. When secure
persistence is unavailable, the connection is memory-only and the UI makes
that limitation visible.

One refresh lane serves all windows. A remembered identity can be displayed
while verification is unavailable. Network failure preserves that remembered
identity without asserting current access; invalid grants require sign-in.
If token rotation succeeds before a temporary user-info outage, Main retains
the replacement credentials with the remembered identity and marks the
connection unavailable until a later identity verification succeeds.
Refresh may update the same subject's display data, but never adopt a different
subject. Responses from a retired generation cannot publish or persist a new
connection.

Sign-out retires the generation, cancels a pending attempt, removes local
credentials and requests revocation of the captured OAuth grant. Browser
sessions and other Profiles are separate. A failed local removal or remote
revocation remains visible; offline sign-out cannot guarantee remote
revocation. Credential cleanup is bounded, and the app never signs a person
back in merely to present a replacement session during logout.

## Verification boundaries

Focused Main tests prove lifecycle, cancellation and stale-result behavior.
Platform tests exercise real loopback HTTP, PKCE, endpoint validation,
encrypted persistence and abandoned-token cleanup. Renderer tests prove
observation ordering and user actions without leaking tokens.

Electron E2E tests use a fresh Profile and a controlled OAuth server through
the actual Main/preload/renderer path. The HTTP fixture is available only in
unpackaged test mode. Native credential bytes and seeded local content must
remain unchanged across sign-in, refresh, restart, cancellation and sign-out.
An explicit live test separately exercises the configured Clerk development
instance with a synthetic test identity and produces review evidence without
credentials or private user content.
