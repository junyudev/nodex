import {
  CODE_LANGUAGE_CATALOG,
  getCodeLanguageSearchText,
  resolveCodeLanguage,
  type CodeLanguage,
} from "../../../shared/code-languages/code-language-catalog";

export type CodeBlockActionBarMode = "all" | "minimal" | "more_only";

export function getCodeBlockActionBarMode(
  availableWidth: number,
  columnRatio?: number,
  hasMermaidActions = false,
): CodeBlockActionBarMode {
  const moreOnlyWidth = hasMermaidActions ? 300 : 230;
  const minimalWidth = hasMermaidActions ? 560 : 350;
  if (availableWidth <= moreOnlyWidth || (columnRatio !== undefined && columnRatio <= 1 / 3)) {
    return "more_only";
  }
  if (availableWidth <= minimalWidth || (columnRatio !== undefined && columnRatio < 1 / 2)) {
    return "minimal";
  }
  return "all";
}

const normalizeSearchText = (value: string, locale: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase(locale);

export function searchCodeLanguages(query: string, locale: string): readonly CodeLanguage[] {
  const terms = normalizeSearchText(query, locale).split(/\s+/u).filter(Boolean);
  const collator = new Intl.Collator(locale, {
    sensitivity: "base",
    numeric: true,
  });
  const matches =
    terms.length === 0
      ? CODE_LANGUAGE_CATALOG
      : CODE_LANGUAGE_CATALOG.filter((language) => {
          const searchText = normalizeSearchText(getCodeLanguageSearchText(language), locale);
          return terms.every((term) => searchText.includes(term));
        });

  return [...matches].sort((left, right) => collator.compare(left.label, right.label));
}

export function canFormatCodeLanguage(languageId: unknown): boolean {
  return resolveCodeLanguage(languageId).formatterKind !== null;
}

export function getCodeBlockPlainText(block: { readonly content?: unknown }): string {
  if (typeof block.content === "string") return block.content;
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((item) => {
      if (typeof item !== "object" || item === null) return "";
      const text = (item as Readonly<Record<string, unknown>>).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}
