import type { AgentRuntimeLaunchResult, AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import type { CodexPromptInput } from "../../shared/types";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import { createUuidV7 } from "../../shared/uuid-v7";
import { readPastedTextAttachment } from "./api";
import { agentRuntimeRuntime, type AgentRuntimeRendererTransport } from "./agent-runtime-runtime";
import { agentRuntimePromptImages, prepareAgentRuntimeMessage } from "./agent-runtime-prompt";
import {
  agentRuntimeProviderBackendKind,
  defaultAgentRuntimeModelSelection,
  requireAgentRuntimeModelSelection,
  type AgentRuntimeCodexDefaults,
} from "./agent-runtime-model-selection";

/** Programmatic launches use the same Session operation as the shared composer. */
export async function launchAgentRuntimeSession(
  input: {
    readonly sessionId: string;
    readonly projectId: string | null;
    readonly prompt: string;
    readonly promptInput?: CodexPromptInput;
    readonly initialPageIds?: readonly string[];
    readonly title?: string;
    readonly codexDefaults?: AgentRuntimeCodexDefaults;
    readonly modelSelection?: AgentRuntimeLaunch["modelSelection"];
    readonly onSelectionResolved?: (kind: AgentBackendBinding["kind"]) => void;
    readonly interactionMode?: AgentRuntimeLaunch["interactionMode"];
    readonly runInTarget?: AgentRuntimeLaunch["runInTarget"];
    readonly runInEnvironmentPath?: AgentRuntimeLaunch["runInEnvironmentPath"];
    readonly worktreeStartingState?: AgentRuntimeLaunch["worktreeStartingState"];
    readonly presentationTicket?: AgentRuntimeLaunch["presentationTicket"];
    readonly launchIdentity?: Pick<AgentRuntimeLaunch, "launchId" | "acceptedAt"> & {
      readonly messageId: string;
    };
  },
  transport: AgentRuntimeRendererTransport = agentRuntimeRuntime,
): Promise<AgentRuntimeLaunchResult> {
  const providers = await transport.catalog();
  const { provider, model, selection } = requireAgentRuntimeModelSelection(
    providers,
    input.modelSelection ?? defaultAgentRuntimeModelSelection(providers, input.codexDefaults),
  );
  const kind = agentRuntimeProviderBackendKind(provider);
  input.onSelectionResolved?.(kind);
  const prepared = await prepareAgentRuntimeMessage(
    {
      model,
      provider,
      modelSelection: selection,
      kind,
      text: input.prompt,
      promptInput: input.promptInput,
    },
    (file) => readPastedTextAttachment({ file }),
  );
  const identity = input.launchIdentity ?? {
    launchId: createUuidV7(),
    messageId: createUuidV7(),
    acceptedAt: Date.now(),
  };
  return await transport.launch({
    sessionId: input.sessionId,
    projectId: input.projectId,
    launchId: identity.launchId,
    acceptedAt: identity.acceptedAt,
    title: input.title?.trim() || input.prompt.slice(0, 120) || "New chat",
    initialPageIds: input.initialPageIds,
    presentationTicket: input.presentationTicket,
    modelSelection: selection,
    interactionMode: input.interactionMode ?? "default",
    runInTarget: input.runInTarget ?? "localProject",
    runInEnvironmentPath: input.runInEnvironmentPath,
    worktreeStartingState: input.worktreeStartingState,
    message: {
      messageId: identity.messageId,
      ...prepared,
      images: agentRuntimePromptImages(input.promptInput),
      ...(input.promptInput?.agentConfigs ? { agentConfigs: input.promptInput.agentConfigs } : {}),
    },
  });
}
