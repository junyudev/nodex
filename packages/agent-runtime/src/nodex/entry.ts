import { workerData } from "node:worker_threads";

/** Internal ACP tool helpers stay off the full engine startup path. */
const command = process.argv[2];
if (workerData?.kind === "session-search-index") {
  const { runSessionSearchWorker } = await import("../persistence/SessionSearchWorkerEntry.ts");
  await runSessionSearchWorker(workerData.filename);
} else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
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
