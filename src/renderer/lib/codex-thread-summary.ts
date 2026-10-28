import type { CodexThreadSummary } from "./types";
import { invokeRendererQuery } from "./renderer-command";

/** Reads bounded execution Thread metadata without exposing transport to editor views. */
export function readCodexThreadSummary(threadId: string): Promise<CodexThreadSummary | null> {
  return invokeRendererQuery("codex:thread:summary:get", threadId);
}
