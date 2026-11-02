import { z } from "zod";

export const AGENT_RUNTIME_STARTUP_PROBE_ENV = "NODEX_AGENT_RUNTIME_STARTUP_PROBE";
export const AGENT_RUNTIME_STARTUP_EVIDENCE_FILE = "agent-runtime-startup.json";

const evidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1).max(256),
    hostPid: z.number().int().positive(),
    runtimeId: z.string().min(1).max(256),
    runtimeGeneration: z.string().min(1).max(256),
    nodeSource: z.enum(["standalone", "browser-bundle"]),
    nodeVersion: z.string().min(1).max(64),
  })
  .strict();
export type AgentRuntimeStartupEvidence = z.infer<typeof evidenceSchema>;

/** Diagnostic readiness contains no endpoints, credentials, provider details or content. */
export function parseAgentRuntimeStartupEvidence(
  value: unknown,
  expected: { readonly runId: string; readonly hostPid: number },
): AgentRuntimeStartupEvidence {
  const evidence = evidenceSchema.parse(value);
  if (evidence.runId !== expected.runId || evidence.hostPid !== expected.hostPid)
    throw new Error("Agent Runtime readiness belongs to another host generation");
  return evidence;
}
