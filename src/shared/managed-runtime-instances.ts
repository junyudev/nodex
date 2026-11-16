import type { AgentBackendBinding } from "./agent-backend";
import { isNodexProviderId } from "./nodex-models";
import { isProviderKeyRuntimeInstanceId } from "./provider-keys";

/**
 * Runtime instances Nodex declares itself, for Nodex credits and for API key connections. They
 * live in the Runtime catalog rather than among the Profile's native Agent configurations, so no
 * native Agent setting resolves them.
 */
export const isManagedRuntimeInstanceId = (instanceId: string): boolean =>
  isNodexProviderId(instanceId) || isProviderKeyRuntimeInstanceId(instanceId);

/** The binding of a managed instance; null for an instance the Profile configures. */
export function managedRuntimeBinding(instanceId: string): AgentBackendBinding | null {
  if (!isManagedRuntimeInstanceId(instanceId)) return null;
  return instanceId.startsWith("nodex_codex_")
    ? { kind: "codex", runtimeInstanceId: instanceId }
    : { kind: "claude", instanceConfigId: instanceId, runtimeInstanceId: instanceId };
}
