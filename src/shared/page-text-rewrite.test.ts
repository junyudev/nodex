import { expect, it } from "vite-plus/test";
import {
  PAGE_TEXT_REWRITE_LIMITS,
  PageTextRewriteInputSchema,
  PageTextRewriteStartSchema,
} from "./page-text-rewrite";

const input = { markdown: "**Selected** text", instruction: "Translate to English" };

it("accepts only bounded selection snapshots and rejects document authority or model overrides", () => {
  expect(PageTextRewriteInputSchema.parse(input)).toEqual(input);
  const cap = PAGE_TEXT_REWRITE_LIMITS;
  expect(
    PageTextRewriteInputSchema.safeParse({
      ...input,
      markdown: "a".repeat(cap.markdown),
      instruction: "a".repeat(cap.instruction),
      context: {
        before: "a".repeat(cap.surroundingText),
        after: "a".repeat(cap.surroundingText),
        pageTitle: "a".repeat(cap.pageTitle),
      },
    }).success,
  ).toBe(true);
  for (const invalid of [
    null,
    {},
    { ...input, markdown: " " },
    { ...input, instruction: "\n" },
    { ...input, markdown: "a".repeat(cap.markdown + 1) },
    { ...input, markdown: "界".repeat(Math.ceil(cap.markdown / 3)) },
    { ...input, context: { before: "a".repeat(cap.surroundingText + 1) } },
    { ...input, context: { after: 1 } },
    { ...input, context: { pageId: "page" } },
    { ...input, documentId: "document" },
    { ...input, model: "arbitrary" },
  ])
    expect(PageTextRewriteInputSchema.safeParse(invalid).success).toBe(false);
  expect(PageTextRewriteStartSchema.safeParse({ input, requestId: "not-an-id" }).success).toBe(
    false,
  );
});
