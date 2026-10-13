/** Internal ACP tool helpers stay off the full engine startup path. */
const command = process.argv[2];
if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
  const { runAcpMcpCliFastPath } = await import("../mcp/AcpMcpStdioBridge.ts");
  await runAcpMcpCliFastPath(command, process.argv.slice(3));
} else {
  const { runAgentRuntimeProcess } = await import("./Daemon.ts");
  await runAgentRuntimeProcess();
}
// @effect-diagnostics nodeBuiltinImport:off
import { Console } from "node:console";

// Every diagnostic shares stderr, including native SDK helpers loaded after this entry.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
