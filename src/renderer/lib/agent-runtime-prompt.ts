import type { CodexPromptInput } from "../../shared/types";
import { prepareAgentAppContext, prepareAgentMessage } from "../../shared/agent-prompt";
import type { CodexUntrustedAppMessage } from "../../shared/codex-untrusted-app-input";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeMessage } from "../../shared/agent-runtime-api";
import { resolveAgentRuntimeAgentConfig } from "../../shared/agent-runtime-agent-config";

type RuntimeProvider = AgentRuntimeOperations["providers.read"]["output"][number];
type RuntimeModel = RuntimeProvider["models"][number];

export {
  agentRuntimeImageInputSupport,
  agentRuntimeImageInputUnavailableReason,
} from "../../shared/agent-runtime-image-input";
import { agentRuntimeImageInputUnavailableReason } from "../../shared/agent-runtime-image-input";
import { splitCodexPromptAgentConfigLines } from "../../shared/codex-prompt-preparation";

/** Every Runtime submission validates visual attachments against its exact selected model. */
export async function prepareAgentRuntimeMessage(
  input: {
    readonly model: RuntimeModel | undefined;
    readonly provider?: RuntimeProvider;
    readonly modelSelection?: AgentRuntimeMessage["modelSelection"];
    readonly kind: AgentBackendBinding["kind"];
    readonly text: string;
    readonly promptInput?: CodexPromptInput;
    readonly untrustedAppMessage?: CodexUntrustedAppMessage;
  },
  readPastedText: Parameters<typeof prepareAgentMessage>[2],
): ReturnType<typeof prepareAgentMessage> {
  // Compile the same text Main will receive, including document items and pasted text. This
  // only prepares data: visual input must still pass admission below before preparation returns.
  const prepared = await prepareAgentMessage(input.text, input.promptInput, readPastedText, {
    images: true,
    agentConfigs: true,
    nativeSkills: input.kind === "claude",
    untrustedAppMessage: input.untrustedAppMessage,
  });
  // Resolve before any caller can rewind or otherwise mutate the chat. Main repeats this
  // check against its live catalog when it admits the original message and Agent config.
  const message = {
    text: prepared.text,
    agentConfigs: input.promptInput?.agentConfigs,
  };
  const hasAgentConfig =
    (message.agentConfigs ?? splitCodexPromptAgentConfigLines(message.text).agentConfigs).length >
    0;
  let model = input.model;
  if (hasAgentConfig) {
    if (!input.provider || !input.modelSelection)
      throw new Error(
        "The selected Agent model catalog is unavailable. Refresh its models and try again.",
      );
    const resolved = resolveAgentRuntimeAgentConfig({
      message,
      modelSelection: input.modelSelection,
      interactionMode: "default",
      providers: [input.provider],
    });
    const selection = resolved.message.modelSelection ?? input.modelSelection;
    model = input.provider.models.find((entry) => entry.slug === selection.model);
  }
  const reason = agentRuntimeImageInputUnavailableReason(model);
  if (reason && agentRuntimePromptImages(input.promptInput, input.untrustedAppMessage).length > 0)
    throw new Error(reason);
  return prepared;
}

/** Preserve the shared editor's explicit visual attachments across every Agent runtime. */
export const agentRuntimePromptImages = (
  input?: CodexPromptInput,
  untrustedAppMessage?: CodexUntrustedAppMessage,
) => [
  ...(input?.images ?? []),
  ...(input?.appshots ?? []).map((entry) => ({
    source: entry.imageDataUrl,
    caption: entry.imageName,
  })),
  ...(input?.browserAnnotationAttachments ?? []).flatMap((entry) =>
    entry.evidence ? [{ source: entry.evidence.source, caption: entry.note }] : [],
  ),
  ...prepareAgentAppContext(input, untrustedAppMessage).images,
];
