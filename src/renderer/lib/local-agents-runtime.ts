import type { LocalAgentScan } from "../../shared/local-agents";
import { invokeRendererQuery } from "./renderer-command";

/** Agent command lines Main found on this computer; Main caches each scan briefly. */
export const localAgentsRuntime = {
  scan: (): Promise<LocalAgentScan> => invokeRendererQuery("local-agents:scan"),
};
