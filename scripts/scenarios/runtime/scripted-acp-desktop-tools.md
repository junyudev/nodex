# Scripted ACP Desktop Tools scenario

Configure a local-command ACP Agent with the absolute path to the repository's
development Node as its command and the absolute path to
`scripts/scenarios/runtime/scripted-acp-agent.ts` as its only argument. The
scripted Registry fixture can launch the same peer. Install workspace
dependencies first.

Set the Agent environment variable `NODEX_SCRIPTED_ACP_SCENARIO` to this JSON,
select the `default` model, and send an ordinary prompt in a Thread with Desktop
Tools available.

```json
{
  "sessionConfig": {
    "id": "model",
    "category": "model",
    "currentValue": "default",
    "values": ["default"]
  },
  "desktopToolCall": {
    "code": "console.log(6 * 7)",
    "title": "Compute a fixture value",
    "timeout_ms": 5000
  }
}
```

The peer launches the `node_repl` stdio command with the arguments and environment
provided by ACP session setup. It initializes MCP, lists tools, and calls `js`
with the supplied arguments. Its ACP updates include the public arguments and
the actual MCP result. `NODEX_SCRIPTED_ACP_OBSERVATION` can point to a temporary
file to record the tool names reported by discovery and the ACP cancellation
event. The peer does not record credentials or MCP request bodies there.

For cancellation, set `code` to
`await new Promise(resolve => setTimeout(resolve, 60_000))` and `timeout_ms` to
`120000`. If the Runtime asks for permission, approve the call. Stop the Run
while the computation is pending. On `session/cancel`, the peer cancels the MCP request
and closes the bridge's stdin. The fixture test holds the HTTP call open and
checks that its response socket closes. With the real Desktop endpoint, the
Runtime applies its normal permission policy before forwarding the computation.

The Electron smoke uses `desktopTurns`, a map from prompt markers to
`{ calls, reply }`. Each matching prompt runs its ordered list of `js` calls and
then sends the reply. The peer asks for ACP tool permission before each call so
the smoke can check that the Runtime is the only user-facing approval owner.
An empty list lets the peer complete a Turn when there is no Desktop Tools
descriptor. The observation file records descriptor names, tool names, result
block types, bounded text, and cancellation.
