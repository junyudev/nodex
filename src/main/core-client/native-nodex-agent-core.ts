import type { CoreAuthorityIdentity, CoreGenerationClient } from "./core-generation-client";

/**
 * Narrow Core transport view used by the native Nodex Agent algorithms.
 * Generation ownership and recovery stay in CoreSessionAccess; these helpers only
 * need the exact client selected for the current operation.
 */
export interface NativeNodexAgentCore {
  readonly identity: CoreAuthorityIdentity;
  readonly rootClient: CoreGenerationClient;
  readonly clientForProject: (projectId: string) => CoreGenerationClient;
}

/** Null is an actual Library binding; it never selects another Project. */
export const nativeAgentClient = (
  runtime: NativeNodexAgentCore,
  actorProjectId: string | null,
): CoreGenerationClient =>
  actorProjectId === null ? runtime.rootClient : runtime.clientForProject(actorProjectId);
