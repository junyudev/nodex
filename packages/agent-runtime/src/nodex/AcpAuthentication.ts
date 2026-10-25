import { createHash } from "node:crypto";
import type { AgentWire } from "./Interface.ts";
import type { ProviderAuthState } from "@t3tools/contracts";
import type { AgentAcpAuthentication } from "./AcpManagementContract.ts";

interface FlowMetadata {
  readonly configurationRevision: number;
  readonly digest: string;
  readonly revision: number;
}
interface ControllerMetadata {
  readonly flows: Map<string | null, FlowMetadata>;
  starting?: { readonly configurationRevision: number };
  current?: { readonly flowId: string; readonly configurationRevision: number };
}

/** Metadata only: the Provider controller still owns authentication and redaction. */
export const makeAuthenticationProjection = (runtimeGeneration: string) => {
  const controllers = new WeakMap<object, ControllerMetadata>();
  let revision = 0;
  const controllerMetadata = (controller: object): ControllerMetadata => {
    const existing = controllers.get(controller);
    if (existing) return existing;
    const created = { flows: new Map<string | null, FlowMetadata>() };
    controllers.set(controller, created);
    return created;
  };
  return {
    begin: (controller: object, configurationRevision: number) => {
      const metadata = controllerMetadata(controller);
      const capture = { configurationRevision };
      metadata.starting = capture;
      return () => {
        if (metadata.starting === capture) delete metadata.starting;
      };
    },
    project: (
      controller: object,
      capturedConfigurationRevision: number,
      state: AgentWire<ProviderAuthState>,
    ): AgentAcpAuthentication => {
      const metadata = controllerMetadata(controller);
      const previous = metadata.flows.get(state.flowId);
      const active = ["starting", "waiting", "verifying"].includes(state.phase);
      const configurationRevision =
        state.flowId === null
          ? ((active ? metadata.starting?.configurationRevision : undefined) ??
            (state.phase !== "idle" ? metadata.current?.configurationRevision : undefined) ??
            capturedConfigurationRevision)
          : (previous?.configurationRevision ??
            (metadata.current?.flowId === state.flowId
              ? metadata.current.configurationRevision
              : undefined) ??
            metadata.starting?.configurationRevision ??
            capturedConfigurationRevision);
      if (state.flowId !== null && !previous && (metadata.starting || !metadata.current))
        metadata.current = { flowId: state.flowId, configurationRevision };
      const digest = createHash("sha256")
        .update(JSON.stringify([state, configurationRevision]))
        .digest("hex");
      const current =
        previous?.digest === digest
          ? previous
          : { configurationRevision, digest, revision: ++revision };
      metadata.flows.delete(state.flowId);
      metadata.flows.set(state.flowId, current);
      if (metadata.flows.size > 64) metadata.flows.delete(metadata.flows.keys().next().value!);
      return {
        ...state,
        runtimeGeneration,
        configurationRevision,
        revision: current.revision,
        cancellable: state.flowId !== null && active,
      };
    },
  };
};
