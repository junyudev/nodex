# Conversation Peer Service

The desktop exposes a dedicated conversation coordination service to trusted main-frame
renderers. A window transfers one MessagePort through its sandboxed preload. Main rejects
unknown windows, untrusted frames and requests containing any other number of ports.
Replacing the connection or destroying the window releases that window's service and socket
client. The Profile Scope owns listening endpoints and releases them at shutdown.
One endpoint manager is shared across application peers. Direct host callbacks and window
RPC views use the same socket discovery, follower dispatch and broadcast implementation.
Read-state sessions borrow `services.threadReadState` from that same window connection.
Opening or retiring a read-state session never replaces the window's coordination peer or
closes its MessagePort; the final window-service consumer owns transport disposal.

## Service and socket boundaries

The port carries bidirectional Cap'n Web calls with structured-clone encoding. Only `null` is
the port-level close sentinel; other values pass through to RPC decoding. Both root
capabilities expose the coordination service as `services.clientCoordination`. The view
resolves a host's manager when a request arrives and awaits its role lookup. A rejected lookup
remains an error rather than a follower response; the service does not cache a conversation
document. Each window service has a separate socket client identity. The router assigns that
identity during initialization and forwards broadcasts and requests without inspecting
conversation revisions.
The identity belongs to one initialized socket connection. A reconnect reports the old identity's
reset and obtains a new identity; requests targeting the old identity fail rather than being
redirected to the new connection. Window registration identities must not be used as peer targets.

Socket frames contain a four-byte little-endian UTF-8 JSON payload length followed by the
payload. The maximum is 256 MiB. An explicitly empty broadcast target list sends nothing;
ordinary broadcasts exclude their source client. Targeted requests return the handling
client's identity. Untargeted requests discover an accepting peer. Request deadlines and
disconnection settle pending calls instead of retaining a retry queue of conversation writes.

The service methods cover stream state, follow intent, following-status requests, local
ownership advertisement, owner discovery, archive/unarchive notifications, queued follow-up changes
and method-specific follower actions. Archive and queue payloads pass through unchanged, retain
the source socket identity and exclude the sending peer. Broadcast
versions are checked at the service boundary. Host identity selects the receiving manager;
identical conversation IDs on different hosts do not share state. The service retains no
snapshot readiness, membership epoch or accepted-revision state.
The receiving manager requires the addressed conversation's current owner before dispatching
a supported follower method. Ordinary resident-history reads and direct picker/tool replies
remain local manager operations; the service has no generic action dispatcher.
The local host is `local` throughout renderer requests, native app-server routing, search,
catalog caches and notifications. Remote host IDs pass through unchanged; there is no separate
renderer alias for the local host.

## Resource and response lifetime

Endpoint election is lazy. Each socket peer uses the application endpoint manager; the Profile Scope
owns any listening servers until shutdown, even after the originating window closes. On Unix it first
probes the private Profile endpoint, then a temporary-directory candidate scoped by the Profile
path digest and user ID. A temporary candidate must be a socket owned by the current user in
an owned directory without group/world write permission. The primary IPC directory is checked
and set to `0700`; its socket is rechecked and set to `0600` before routing starts. Only stale
sockets owned by the current user are eligible for removal.

Election returns the endpoint pathname before listening finishes. An occupied address closes
the losing listener; other bind and security errors are reported. The client retries connection
failures rather than treating a pathname as proof of router readiness. Once its router starts,
the endpoint manager reuses that endpoint without probing again. Scope release closes all
owned listeners and clients, including a pending listen. These failures do not prevent the
desktop from starting. Port closure and window destruction release pending work.
Local disposal rejects a pending port receive immediately, discards queued messages and closes
the endpoint even when the remote close sentinel has already failed the session.
Follower response envelopes are copied before releasing their RPC references; handler
deadlines also release outstanding RPC promises. The follower request client preserves remote
error envelopes and rejects success envelopes for another method. Cancellation before dispatch
sends no request; cancellation while waiting releases the RPC call and returns an aborted
error without replaying the operation. An unavailable coordination service produces an explicit
error response.

This service is an independent transport capability. The existing conversation application's
current behavior remains specified in [Thread Owner/Follower Streaming](codex-thread-owner-follower-streaming.md).
