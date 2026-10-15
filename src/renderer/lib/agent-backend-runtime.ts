import type { AgentModelCatalog, AgentModelCatalogInput } from "../../shared/agent-model-catalog";
import type { IpcApi } from "../../shared/ipc-api";
import type { ClaudeDiscoveryInput, ClaudeModelCatalogInput } from "../../shared/claude-models";
import { createUuidV7 } from "../../shared/uuid-v7";
import { invokeRendererControl, invokeRendererQuery } from "./renderer-command";

export interface AgentBackendRuntime {
  readonly modelCatalog: (
    input: AgentModelCatalogInput,
    signal?: AbortSignal,
  ) => Promise<AgentModelCatalog>;
  readonly claudeDiscovery: (
    input: ClaudeDiscoveryInput,
    signal?: AbortSignal,
  ) => Promise<IpcApi["agent-backend:claude:discover"]["result"]>;
  readonly claudeModels: (
    input: ClaudeModelCatalogInput,
  ) => Promise<IpcApi["agent-backend:claude:models"]["result"]>;
  readonly inspect: (
    threadId: string,
  ) => Promise<IpcApi["agent-backend:session:inspect"]["result"]>;
  readonly history: (
    input: IpcApi["agent-backend:session:history"]["args"][0],
  ) => Promise<IpcApi["agent-backend:session:history"]["result"]>;
  readonly historyImage: (
    input: IpcApi["agent-backend:session:history-image"]["args"][0],
  ) => Promise<string>;
  readonly toolOutput: (
    input: IpcApi["agent-backend:session:tool-output"]["args"][0],
  ) => Promise<IpcApi["agent-backend:session:tool-output"]["result"]>;
}

/** Native catalogs and persisted history are reads; Session execution belongs to Agent Runtime. */
export const agentBackendRuntime: AgentBackendRuntime = {
  modelCatalog: async (input, signal) => {
    if (signal?.aborted) throw new DOMException("Model discovery cancelled", "AbortError");
    const requestId = createUuidV7();
    let rejectCancellation: ((reason: unknown) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = () => {
      void invokeRendererControl("agent-backend:model-catalog:cancel", { requestId }).catch(
        () => {},
      );
      rejectCancellation?.(new DOMException("Model discovery cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await Promise.race([
        invokeRendererQuery("agent-backend:model-catalog:read", { ...input, requestId }),
        cancellation,
      ]);
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  },
  claudeDiscovery: async (input, signal) => {
    if (signal?.aborted) throw new DOMException("Claude discovery cancelled", "AbortError");
    const requestId = createUuidV7();
    let rejectCancellation: ((reason: unknown) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = () => {
      void invokeRendererControl("agent-backend:claude:cancel-discovery", { requestId }).catch(
        () => {},
      );
      rejectCancellation?.(new DOMException("Claude discovery cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await Promise.race([
        invokeRendererQuery("agent-backend:claude:discover", { ...input, requestId }),
        cancellation,
      ]);
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  },
  inspect: (threadId) => invokeRendererQuery("agent-backend:session:inspect", threadId),
  history: (input) => invokeRendererQuery("agent-backend:session:history", input),
  historyImage: (input) => invokeRendererQuery("agent-backend:session:history-image", input),
  toolOutput: (input) => invokeRendererQuery("agent-backend:session:tool-output", input),
  claudeModels: (input) => invokeRendererQuery("agent-backend:claude:models", input),
};
