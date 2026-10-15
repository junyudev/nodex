import type { CodexPromptInput } from "../../shared/types";
import { prepareAgentAppContext } from "../../shared/agent-prompt";
import type { CodexUntrustedAppMessage } from "../../shared/codex-untrusted-app-input";

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
