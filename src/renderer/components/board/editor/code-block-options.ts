import type { CodeBlockOptions } from "@blocknote/core";
import { CODE_LANGUAGE_CATALOG } from "../../../../shared/code-languages/code-language-catalog";
import { codeLanguagePreference } from "@/lib/editor-model/code-language-preference";

export const editorCodeBlockOptions: CodeBlockOptions = {
  defaultLanguage: "text",
  getDefaultLanguage: () => codeLanguagePreference.get(),
  supportedLanguages: Object.fromEntries(
    CODE_LANGUAGE_CATALOG.map((language) => [
      language.id,
      {
        name: language.label,
        aliases: [...language.aliases, ...language.extensions],
      },
    ]),
  ),
};
