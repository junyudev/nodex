import { isNodexProviderId } from "./nodex-models";
import { isProviderKeyRuntimeInstanceId } from "./provider-keys";

/**
 * Runtime instances Nodex declares itself, for Nodex credits and for API key connections. They
 * live in the Runtime catalog rather than among the Profile's native Agent configurations, so no
 * native Agent setting resolves them.
 */
export const isManagedRuntimeInstanceId = (instanceId: string): boolean =>
  isNodexProviderId(instanceId) || isProviderKeyRuntimeInstanceId(instanceId);
