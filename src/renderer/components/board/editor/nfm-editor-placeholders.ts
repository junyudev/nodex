export const NFM_QUOTE_PLACEHOLDER = "Empty quote";
export const NFM_PROMPT_PLACEHOLDER = "Write a prompt to send to a chat";

export function createNfmEditorPlaceholders(defaultPlaceholder: string) {
  return {
    default: defaultPlaceholder,
    quote: NFM_QUOTE_PLACEHOLDER,
    prompt: NFM_PROMPT_PLACEHOLDER,
  };
}
