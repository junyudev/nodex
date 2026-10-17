import type { AgentRuntimeLaunchResult, AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import type { CodexPromptInput, CodexThreadSettings, CodexServiceTier } from "../../shared/types";
import { createUuidV7 } from "../../shared/uuid-v7";
import { prepareAgentMessage } from "../../shared/agent-prompt";
import { applyAgentRuntimeOptionIntent } from "../../shared/agent-runtime-provider";
import { readPastedTextAttachment } from "./api";
import { agentRuntimeRuntime, type AgentRuntimeRendererTransport } from "./agent-runtime-runtime";
import { agentRuntimePromptImages } from "./agent-runtime-prompt";

/** Programmatic launches use the same Session operation as the shared composer. */
export async function launchAgentRuntimeSession(
  input: {
    readonly sessionId: string;
    readonly projectId: string | null;
    readonly prompt: string;
    readonly promptInput?: CodexPromptInput;
    readonly initialPageIds?: readonly string[];
    readonly title?: string;
    readonly codexDefaults?: Pick<CodexThreadSettings, "model" | "reasoningEffort"> & {
      readonly serviceTier?: CodexServiceTier;
    };
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
  const provider = providers.find(
    (value) =>
      value.instanceId === "codex" &&
      value.enabled &&
      value.installed &&
      value.status !== "error" &&
      value.status !== "disabled",
  );
  const model =
    provider?.models.find((value) => value.slug === input.codexDefaults?.model) ??
    provider?.models.find((value) => value.isDefault) ??
    provider?.models[0];
  if (!provider || !model)
    throw new Error("Choose an available Agent model before starting this chat");
  const prepared = await prepareAgentMessage(
    input.prompt,
    input.promptInput,
    (file) => readPastedTextAttachment({ file }),
    { images: true, agentConfigs: true },
  );
  const identity = input.launchIdentity ?? {
    launchId: createUuidV7(),
    messageId: createUuidV7(),
    acceptedAt: Date.now(),
  };
  const options = applyAgentRuntimeOptionIntent(
    model.capabilities?.optionDescriptors ?? [],
    undefined,
    {
      ...(input.codexDefaults?.reasoningEffort
        ? { reasoningEffort: input.codexDefaults.reasoningEffort }
        : {}),
      serviceTier: input.codexDefaults?.serviceTier ?? null,
    },
  );
  return await transport.launch({
    sessionId: input.sessionId,
    projectId: input.projectId,
    launchId: identity.launchId,
    acceptedAt: identity.acceptedAt,
    title: input.title?.trim() || input.prompt.slice(0, 120) || "New chat",
    initialPageIds: input.initialPageIds,
    presentationTicket: input.presentationTicket,
    modelSelection: {
      instanceId: provider.instanceId,
      model: model.slug,
      ...(options.length ? { options } : {}),
    },
    interactionMode: input.interactionMode ?? "default",
    runInTarget: input.runInTarget ?? "localProject",
    runInEnvironmentPath: input.runInEnvironmentPath,
    worktreeStartingState: input.worktreeStartingState,
    message: {
      messageId: identity.messageId,
      ...prepared,
      images: agentRuntimePromptImages(input.promptInput),
      ...(input.promptInput ? { agentConfigs: input.promptInput.agentConfigs ?? [] } : {}),
    },
  });
}
