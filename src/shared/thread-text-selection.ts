import { z } from "zod";

/** App-owned references to transcript text, independent of provider wire shapes. */
export const ThreadTextSelectionSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1),
});

export const ResponseTextAnnotationSchema = ThreadTextSelectionSchema.extend({
  annotation: z.string().optional(),
  source: z
    .object({
      threadId: z.string().min(1),
      messageId: z.string().min(1),
      startOffset: z.number().int().nonnegative(),
      endOffset: z.number().int().nonnegative(),
      rangeText: z.string(),
    })
    .refine((source) => source.endOffset > source.startOffset),
});

export type ThreadTextSelection = z.infer<typeof ThreadTextSelectionSchema>;
export type ResponseTextAnnotation = z.infer<typeof ResponseTextAnnotationSchema>;

export const ThreadTextSelectionContextSchema = z.object({
  responseTextAnnotations: z.array(ResponseTextAnnotationSchema),
  selectedTextAttachments: z.array(ThreadTextSelectionSchema),
});
export type ThreadTextSelectionContext = z.infer<typeof ThreadTextSelectionContextSchema>;

export const EMPTY_THREAD_TEXT_SELECTION_CONTEXT: ThreadTextSelectionContext = {
  responseTextAnnotations: [],
  selectedTextAttachments: [],
};
export const THREAD_TEXT_SELECTION_CONTEXT_KIND = "nodex-thread-selection";
export const THREAD_TEXT_SELECTION_ADDITIONAL_CONTEXT_KEY = "thread-text-selection";

export function hasThreadTextSelections(input: Partial<ThreadTextSelectionContext>): boolean {
  return Boolean(input.responseTextAnnotations?.length || input.selectedTextAttachments?.length);
}

export function parseThreadTextSelectionContext(input: unknown): ThreadTextSelectionContext {
  const parsed = ThreadTextSelectionContextSchema.safeParse(input);
  return parsed.success ? parsed.data : EMPTY_THREAD_TEXT_SELECTION_CONTEXT;
}

export function serializeThreadTextSelections(input: ThreadTextSelectionContext): string {
  const { responseTextAnnotations, selectedTextAttachments } =
    ThreadTextSelectionContextSchema.parse(input);
  const annotations =
    responseTextAnnotations.length === 0
      ? ""
      : [
          "# Response annotations:",
          'Each item contains text selected from an earlier response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. For every annotation you address, include its inline directive `:codex-annotation{index="N"}`, where N is its one-based array position (for example, `:codex-annotation{index="1"}`). Do not use unstructured annotation labels.',
          "<response-annotations>",
          JSON.stringify(
            responseTextAnnotations.map(({ text, annotation, source }) => ({
              text,
              annotation,
              source: {
                messageId: source.messageId,
                startOffset: source.startOffset,
                endOffset: source.endOffset,
              },
            })),
          ),
          "</response-annotations>",
        ].join("\n");
  const selections =
    selectedTextAttachments.length === 0
      ? ""
      : [
          "# Selected text:",
          ...selectedTextAttachments.map(
            ({ text }, index) => `\n## Selection ${index + 1}\n${text}\n`,
          ),
        ].join("\n");
  return [annotations, selections].filter(Boolean).join("\n\n");
}

/** Runtime context records retain the authored references beside the user's own words. */
export function readRuntimeThreadTextSelections(context: unknown): ThreadTextSelectionContext {
  if (
    !context ||
    typeof context !== "object" ||
    !("records" in context) ||
    !Array.isArray(context.records)
  )
    return EMPTY_THREAD_TEXT_SELECTION_CONTEXT;
  return context.records.reduce<ThreadTextSelectionContext>((result, record: unknown) => {
    if (
      !record ||
      typeof record !== "object" ||
      !("kind" in record) ||
      record.kind !== THREAD_TEXT_SELECTION_CONTEXT_KIND ||
      !("payload" in record)
    )
      return result;
    const parsed = parseThreadTextSelectionContext(record.payload);
    return {
      responseTextAnnotations: [
        ...result.responseTextAnnotations,
        ...parsed.responseTextAnnotations,
      ],
      selectedTextAttachments: [
        ...result.selectedTextAttachments,
        ...parsed.selectedTextAttachments,
      ],
    };
  }, EMPTY_THREAD_TEXT_SELECTION_CONTEXT);
}

export function readThreadTextSelectionAdditionalContext(
  context: unknown,
): ThreadTextSelectionContext {
  if (!context || typeof context !== "object") return EMPTY_THREAD_TEXT_SELECTION_CONTEXT;
  const entry: unknown = Reflect.get(context, THREAD_TEXT_SELECTION_ADDITIONAL_CONTEXT_KEY);
  if (!entry || typeof entry !== "object" || !("value" in entry) || typeof entry.value !== "string")
    return EMPTY_THREAD_TEXT_SELECTION_CONTEXT;
  try {
    return parseThreadTextSelectionContext(JSON.parse(entry.value));
  } catch {
    return EMPTY_THREAD_TEXT_SELECTION_CONTEXT;
  }
}

export function threadTextSelectionAdditionalContext(context: ThreadTextSelectionContext) {
  if (!hasThreadTextSelections(context)) return undefined;
  return {
    [THREAD_TEXT_SELECTION_ADDITIONAL_CONTEXT_KEY]: {
      kind: "application" as const,
      value: JSON.stringify(context),
    },
  };
}

/** Remove only the companion input proven by this Turn's typed metadata. */
export function withoutThreadTextSelectionInput<T extends { type: string; text?: string }>(
  items: readonly T[],
  context: ThreadTextSelectionContext,
): T[] {
  if (!hasThreadTextSelections(context)) return [...items];
  const companion = serializeThreadTextSelections(context);
  return items.filter((item) => item.type !== "text" || item.text !== companion);
}
