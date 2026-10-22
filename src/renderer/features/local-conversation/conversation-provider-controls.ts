import type { ConversationProviderPresentation } from "./thread-stage-types";

export const supportsConversationProviderControl = (
  provider: Pick<ConversationProviderPresentation, "kind" | "controls"> | undefined,
  control: keyof NonNullable<ConversationProviderPresentation["controls"]>,
): boolean => {
  const explicit = provider?.controls?.[control];
  if (explicit !== undefined) return explicit;
  if (!provider || provider.kind === "codex") return true;
  return false;
};
