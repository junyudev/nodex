import { z } from "zod";

export const PAGE_TEXT_REWRITE_LIMITS = {
  markdown: 65_536,
  instruction: 4_096,
  pageTitle: 1_024,
  surroundingText: 4_096,
  output: 131_072,
  timeoutMs: 90_000,
} as const;

const boundedText = (bytes: number) =>
  z
    .string()
    .max(bytes)
    .refine((value) => new TextEncoder().encode(value).length <= bytes);
const nonemptyText = (bytes: number) =>
  boundedText(bytes).refine((value) => value.trim().length > 0);

/** Selection snapshots only: this capability has no Document identity or write intent. */
export const PageTextRewriteInputSchema = z
  .object({
    markdown: nonemptyText(PAGE_TEXT_REWRITE_LIMITS.markdown),
    instruction: nonemptyText(PAGE_TEXT_REWRITE_LIMITS.instruction),
    context: z
      .object({
        pageTitle: boundedText(PAGE_TEXT_REWRITE_LIMITS.pageTitle).optional(),
        before: boundedText(PAGE_TEXT_REWRITE_LIMITS.surroundingText).optional(),
        after: boundedText(PAGE_TEXT_REWRITE_LIMITS.surroundingText).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PageTextRewriteInput = z.infer<typeof PageTextRewriteInputSchema>;
export const PageTextRewriteRequestIdSchema = z.string().uuid();
export const PageTextRewriteStartSchema = z
  .object({
    requestId: PageTextRewriteRequestIdSchema,
    input: PageTextRewriteInputSchema,
  })
  .strict();
export type PageTextRewriteStart = z.infer<typeof PageTextRewriteStartSchema>;

export interface PageTextRewriteFailure {
  readonly code:
    | "invalid_input"
    | "unavailable"
    | "busy"
    | "timeout"
    | "auth"
    | "rate_limit"
    | "invalid_output"
    | "generation_failed";
  readonly message: string;
}
export type PageTextRewriteStartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: PageTextRewriteFailure };
export type PageTextRewriteResult =
  | { readonly kind: "done"; readonly markdown: string }
  | { readonly kind: "error"; readonly error: PageTextRewriteFailure }
  | { readonly kind: "cancelled" };
export type PageTextRewriteEvent = PageTextRewriteResult & { readonly requestId: string };
