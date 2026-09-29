import type { ConversationProviderPresentation } from "./thread-stage-types";

export const supportsConversationProviderControl = (
  provider: Pick<ConversationProviderPresentation, "kind" | "controls"> | undefined,
  control: keyof NonNullable<ConversationProviderPresentation["controls"]>,
): boolean => {
  if (!provider || provider.kind === "codex") return true;
  return provider.controls?.[control] === true;
};
