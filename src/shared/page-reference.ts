import { z } from "zod";
import { buildPageDeepLink } from "./nodex-deeplink";

/** A reference to Library content, frozen when the user submits; never a content snapshot. */
export interface PageReference {
  readonly pageId: string;
  readonly titleSnapshot: string;
  readonly selectedBlockIds: readonly string[];
}

export const PageReferenceSchema = z.object({
  pageId: z
    .string()
    .min(1)
    .refine((id) => {
      try {
        buildPageDeepLink({ pageId: id });
        return true;
      } catch {
        return false;
      }
    }),
  titleSnapshot: z.string(),
  selectedBlockIds: z.array(z.string().min(1)),
});
export const PAGE_REFERENCE_CONTEXT_KIND = "nodex-page-reference";
export const PAGE_REFERENCES_ADDITIONAL_CONTEXT_KEY = "page-references";

export function pageReferencePayload(reference: PageReference) {
  return {
    pageId: reference.pageId,
    title: reference.titleSnapshot,
    url: buildPageDeepLink(reference),
    selectedBlockIds: [...reference.selectedBlockIds],
  };
}

export function serializePageReferences(references: readonly PageReference[]): string {
  return `# Page references:\n${JSON.stringify(references.map(pageReferencePayload))}`;
}

export function pageReferencesAdditionalContext(references: readonly PageReference[]) {
  if (references.length === 0) return undefined;
  return {
    [PAGE_REFERENCES_ADDITIONAL_CONTEXT_KEY]: {
      kind: "application" as const,
      value: JSON.stringify(references),
    },
  };
}

export function readPageReferencesAdditionalContext(context: unknown): readonly PageReference[] {
  if (!context || typeof context !== "object") return [];
  const entry: unknown = Reflect.get(context, PAGE_REFERENCES_ADDITIONAL_CONTEXT_KEY);
  if (!entry || typeof entry !== "object" || !("value" in entry) || typeof entry.value !== "string")
    return [];
  try {
    const parsed = z.array(PageReferenceSchema).safeParse(JSON.parse(entry.value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function readRuntimePageReferences(context: unknown): readonly PageReference[] {
  if (
    !context ||
    typeof context !== "object" ||
    !("records" in context) ||
    !Array.isArray(context.records)
  )
    return [];
  return context.records.flatMap((record: unknown) => {
    if (
      !record ||
      typeof record !== "object" ||
      !("kind" in record) ||
      record.kind !== PAGE_REFERENCE_CONTEXT_KIND ||
      !("payload" in record)
    )
      return [];
    const payload = record.payload;
    if (!payload || typeof payload !== "object") return [];
    const parsed = PageReferenceSchema.safeParse({
      ...payload,
      titleSnapshot: Reflect.get(payload, "title"),
    });
    return parsed.success ? [parsed.data] : [];
  });
}

/** Hide only the exact companion proven by typed display metadata. */
export function withoutPageReferenceInput<T extends { type: string; text?: string }>(
  items: readonly T[],
  references: readonly PageReference[],
): T[] {
  if (references.length === 0) return [...items];
  const companion = serializePageReferences(references);
  return items.filter((item) => item.type !== "text" || item.text !== companion);
}
