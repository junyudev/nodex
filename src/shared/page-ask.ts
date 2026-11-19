import type { components } from "@nodex/core-protocol";
import { CODEX_PROVIDER_ID } from "./codex-agent-config";
import type { CodexPromptAgentConfigInput } from "./types";

export const PAGE_ASK_MESSAGE_PREFIX = "page-ask:";
export type PageAskAgent = components["schemas"]["DiscussionAskAgent"];

/** Retain the choices from a Page's Agent config chip for the Run's catalog resolver. */
export function pageAskAgentFromConfig(
  config: Pick<
    Required<CodexPromptAgentConfigInput>,
    "mode" | "provider" | "model" | "reasoning" | "speed"
  >,
): PageAskAgent | undefined {
  const { mode, provider, model, reasoning, speed } = config;
  if (!provider && !model && !mode && !reasoning && !speed) return undefined;
  return {
    providerInstanceId: provider,
    model,
    options: { ...(mode && { mode }), ...(reasoning && { reasoning }), ...(speed && { speed }) },
  };
}

/** A chip records the Codex model provider. The runtime addresses the Codex Agent instance. */
export const pageAskProviderInstanceId = (id: string): string =>
  id === CODEX_PROVIDER_ID ? "codex" : id;

export function pageAskAgentConfig(agent: PageAskAgent): CodexPromptAgentConfigInput | null {
  const provider = agent.providerInstanceId;
  if (provider && provider !== CODEX_PROVIDER_ID && provider !== "codex") return null;
  const options = agent.options as Partial<Record<"mode" | "reasoning" | "speed", unknown>> | null;
  return {
    ...(provider && { provider: CODEX_PROVIDER_ID }),
    ...(agent.model && { model: agent.model }),
    ...(typeof options?.mode === "string" && { mode: options.mode }),
    ...(typeof options?.reasoning === "string" && { reasoning: options.reasoning }),
    ...(typeof options?.speed === "string" && { speed: options.speed }),
  };
}

/** Create the Discussion after the pending Block is committed to the Page. */
export function createInPlaceAskCommand(input: {
  readonly pageId: string;
  readonly discussionId: string;
  readonly pendingBlockId: string;
  readonly request: string;
  readonly askAgent?: PageAskAgent;
  readonly requestedSessionId?: string;
}): Extract<components["schemas"]["DiscussionCommand"], { kind: "create" }> {
  return {
    kind: "create",
    pageId: input.pageId,
    discussionId: input.discussionId,
    quote: input.request.slice(0, 500).replace(/[\uD800-\uDBFF]$/u, ""),
    anchor: { kind: "blocks", blockIds: [input.pendingBlockId] },
    firstComment: {
      body: input.request,
      toNodex: true,
      askKind: "in_place",
      ...(input.askAgent && { askAgent: input.askAgent }),
      ...(input.requestedSessionId && { requestedSessionId: input.requestedSessionId }),
    },
  };
}

/** The first line of the request, without Markdown, short enough for a sidebar row. */
export function pageAskConversationTitle(request: string, fallback: string): string {
  const line = request
    .split("\n")
    .map((part) =>
      part
        .replace(/<nodex:\/\/[^>]+>/gu, "")
        .replace(/[*_`#>[\]]+/gu, "")
        .trim(),
    )
    .find(Boolean);
  if (!line) return fallback;
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}
