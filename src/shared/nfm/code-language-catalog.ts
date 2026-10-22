import catalogJson from "./code-language-catalog-v1.json";

export type CodeFormatterKind =
  | "css"
  | "graphql"
  | "html"
  | "javascript"
  | "json"
  | "scss"
  | "typescript"
  | "xml";

export interface CodeLanguage {
  readonly id: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly extensions: readonly string[];
  readonly searchTerms: readonly string[];
  readonly shikiLanguage: string | null;
  readonly formatterKind: CodeFormatterKind | null;
}

class CodeLanguageCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeLanguageCatalogError";
  }
}

const FORMATTER_KINDS = new Set<CodeFormatterKind>([
  "css",
  "graphql",
  "html",
  "javascript",
  "json",
  "scss",
  "typescript",
  "xml",
]);

const readStringList = (value: unknown, field: string): readonly string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CodeLanguageCatalogError(`Code language ${field} must be a string list`);
  }
  return Object.freeze([...value]);
};

const readLanguage = (value: unknown): CodeLanguage => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodeLanguageCatalogError("Code language entry must be an object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.id !== "string" || record.id.trim() !== record.id || !record.id) {
    throw new CodeLanguageCatalogError("Code language id must be a non-empty canonical string");
  }
  if (typeof record.label !== "string" || record.label.trim() !== record.label || !record.label) {
    throw new CodeLanguageCatalogError(`Code language ${record.id} has an invalid label`);
  }
  if (record.shikiLanguage !== null && typeof record.shikiLanguage !== "string") {
    throw new CodeLanguageCatalogError(`Code language ${record.id} has an invalid Shiki language`);
  }
  if (
    record.formatterKind !== null &&
    !FORMATTER_KINDS.has(record.formatterKind as CodeFormatterKind)
  ) {
    throw new CodeLanguageCatalogError(`Code language ${record.id} has an invalid formatter kind`);
  }

  return Object.freeze({
    id: record.id,
    label: record.label,
    aliases: readStringList(record.aliases, `${record.id}.aliases`),
    extensions: readStringList(record.extensions, `${record.id}.extensions`),
    searchTerms: readStringList(record.searchTerms, `${record.id}.searchTerms`),
    shikiLanguage: record.shikiLanguage,
    formatterKind: record.formatterKind as CodeFormatterKind | null,
  });
};

const readCatalog = (value: unknown): readonly CodeLanguage[] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodeLanguageCatalogError("Code language catalog must be an object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record.contractVersion !== 1) {
    throw new CodeLanguageCatalogError("Unsupported code language catalog version");
  }
  if (!Array.isArray(record.languages)) {
    throw new CodeLanguageCatalogError("Code language catalog is missing languages");
  }

  const languages = record.languages.map(readLanguage);
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const language of languages) {
    if (ids.has(language.id)) {
      throw new CodeLanguageCatalogError(`Duplicate code language id: ${language.id}`);
    }
    if (labels.has(language.label)) {
      throw new CodeLanguageCatalogError(`Duplicate code language label: ${language.label}`);
    }
    ids.add(language.id);
    labels.add(language.label);
  }
  if (languages.length !== 88) {
    throw new CodeLanguageCatalogError(
      `Code language catalog must contain exactly 88 entries; received ${languages.length}`,
    );
  }
  if (!ids.has("text")) {
    throw new CodeLanguageCatalogError("Code language catalog must contain Plain Text");
  }
  return Object.freeze(languages);
};

const normalizeLookupToken = (value: string): string =>
  value.normalize("NFKC").trim().replace(/^\./u, "").toLocaleLowerCase();

export const CODE_LANGUAGE_CATALOG = readCatalog(catalogJson);
export const CODE_LANGUAGE_LABELS = Object.freeze(
  CODE_LANGUAGE_CATALOG.map((language) => language.label),
);

const codeLanguageById = new Map(
  CODE_LANGUAGE_CATALOG.map((language) => [language.id, language] as const),
);
const codeLanguageIdByLookupToken = new Map<string, string>();

for (const language of CODE_LANGUAGE_CATALOG) {
  const lookupValues = [language.id, language.label, ...language.aliases, ...language.extensions];
  for (const value of lookupValues) {
    const token = normalizeLookupToken(value);
    if (!token || codeLanguageIdByLookupToken.has(token)) continue;
    codeLanguageIdByLookupToken.set(token, language.id);
  }
}

/** Matches an ID, label, alias, or extension; unlike normalization, a miss stays observable. */
export function findCodeLanguage(value: unknown): CodeLanguage | null {
  if (typeof value !== "string") return null;
  const id = codeLanguageIdByLookupToken.get(normalizeLookupToken(value));
  return id === undefined ? null : codeLanguageById.get(id)!;
}

export function normalizeCodeLanguageId(value: unknown): string {
  return findCodeLanguage(value)?.id ?? "text";
}

export function resolveCodeLanguage(value: unknown): CodeLanguage {
  return codeLanguageById.get(normalizeCodeLanguageId(value)) ?? codeLanguageById.get("text")!;
}

export function isSupportedCodeLanguageId(value: unknown): value is string {
  return typeof value === "string" && codeLanguageById.has(value);
}

export function getCodeLanguageSearchText(language: CodeLanguage): string {
  return [
    language.label,
    language.id,
    ...language.aliases,
    ...language.extensions,
    ...language.searchTerms,
  ].join(" ");
}
