import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";

export type AntigravityRuntimeInspection =
  AgentRuntimeOperations["providers.install.read"]["output"];
export type AntigravityRuntimeOperation =
  AgentRuntimeOperations["providers.install.start"]["output"];
export type AntigravityExecutableChoice = AntigravityRuntimeInspection["instances"][number];

export interface AntigravityRuntimeSnapshot {
  /** Main orders reads, command replies and events across execution generations. */
  readonly revision: number;
  /** Null until an already-running process or an explicit request checks the runtime. */
  readonly inspection: AntigravityRuntimeInspection | null;
  readonly operation: AntigravityRuntimeOperation | null;
}
