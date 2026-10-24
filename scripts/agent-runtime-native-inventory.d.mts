export interface AgentRuntimeNativeArtifact {
  readonly path: string;
  readonly size: number;
  readonly executable: boolean;
  readonly sha256: string;
}
export function agentRuntimeNativeInventory(root: string): readonly AgentRuntimeNativeArtifact[];
export function agentRuntimeNativeDigest(root: string): string;
export function assertPackagedAgentRuntimeNative(input: {
  sourceRoot: string;
  packagedRoot: string;
}): void;
