// Keep the real wire and resource-lifetime contracts in the Runtime test gate.
// Vendor test directories are intentionally outside the suite's collection glob.
import "../../vendor/effect-acp/src/client.test.ts";
import "../../vendor/effect-acp/src/protocol.test.ts";
import "../../vendor/provider-acp/src/server/clientTerminals.test.ts";
import "../../vendor/provider-acp/src/server/mcpOverAcpBridge.test.ts";
