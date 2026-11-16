import { getIntl } from "@/lib/i18n";
import { PAGE_DESCRIPTION_PLACEHOLDER } from "@/lib/page-description-placeholder";
import { pageDescriptionPlaceholderMessage } from "../presentation-messages";

export function createNfmEditorPlaceholders(defaultPlaceholder = PAGE_DESCRIPTION_PLACEHOLDER) {
  const intl = getIntl();
  return {
    default:
      defaultPlaceholder === PAGE_DESCRIPTION_PLACEHOLDER
        ? intl.formatMessage(pageDescriptionPlaceholderMessage)
        : defaultPlaceholder,
    quote: intl.formatMessage({
      id: "editor.nfmEditorPlaceholders.quote",
      defaultMessage: "Empty quote",
    }),
    prompt: intl.formatMessage({
      id: "editor.nfmEditorPlaceholders.prompt",
      defaultMessage: "Write a prompt to send to a chat",
    }),
  };
}
