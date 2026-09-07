# Nodex application MCP transport

This package adapts MCP tools/list and tools/call to a host-owned tool interface.
It does not grant permissions or implement application commands. The host must
validate invocation identity, arguments, capabilities and current authority before
executing a call. Request metadata is forwarded unchanged and is not itself proof
of authority. The SDK handles MCP framing and protocol validation.

Run the focused transport tests from the repository root:

```sh
vp test run --config vitest.node.config.ts packages/nodex-app-tools-mcp/src/server.test.ts
```

Run the pinned app-server experiment against a fresh disposable directory:

```sh
vp run probe:app-tools-mcp --home runs.local/app-tools-probe
```

The experiment uses the staged app-server and a loopback scripted model, with no
model account needed. It starts a real stdio MCP process, proves direct and code
mode invocation, and correlates each request's callId, Thread and Turn with the
native MCP transcript item. It reports Turn interruption and whether the client
forwarded cancellation separately. The host must cancel work when the trusted
Turn ends even if no MCP cancellation notification arrives. Probe metadata and
reports stay under the disposable run directory.

The experiment is not evidence of Core authorization or production tool
availability. Those boundaries are exercised by the application host tests when
its dispatcher is connected.

The standalone server keeps standard SDK stdio framing. Its private socket uses
JSON-RPC messages with a four-byte little-endian payload length, and routes
`tools/list`, `tools/call`, and `tools/cancel` to Main. MCP cancellation becomes a
private `tools/cancel` carrying the original request ID. A first
`nodex/authenticate` RPC binds the connection to its physical app-server session's
instance and private token; a reachable socket alone is not an admitted caller.
Native request metadata reaches Main unchanged, where the exact active Turn and
Core authority are checked separately. The pipe limits frames to 1 MiB and concurrent requests to 32 per connection,
and never replays calls after disconnect. The Main Node adapter acquires the
endpoint in a private temporary directory and binds cleanup to its Effect Scope.
Socket cancellation is converted once into interruption of the tracked host
Effect. Application Turn cancellation remains the dispatcher's responsibility.

`desktop-mcp.json` declares the bundled server's launch settings and tool approval
policy. Main embeds that validated definition, resolves its working directory and
entrypoint outside ASAR, and replaces `command` with the verified bundled Node.
The private descriptor is injected through one process-level inline TOML server
override. It is never saved in Thread configuration. Explicit consent is requested
for creating, messaging, forking, or handing off a Session and updating an
Automation; approval policy never replaces application authorization. The server
retains a bounded 185-second call timeout. Catalog visibility remains unchanged.
