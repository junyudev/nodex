import { expect, test } from "vite-plus/test";
import { readMarkdown } from "../../../src/shared/nodex-markdown";
import {
  NFM_EQUATION_AND_MERMAID_NFM,
  NFM_VIEWPORT_CONTINUITY_NFM,
} from "./nfm-equation-and-mermaid";

test("the Equation scenario seeds inline math beside its display equations", () => {
  const blocks = readMarkdown(NFM_EQUATION_AND_MERMAID_NFM, "exact");
  expect(blocks[1]).toMatchObject({
    type: "paragraph",
    content: [
      { type: "text", text: "Inline energy is " },
      { type: "math", content: "E = mc^2" },
      { type: "text", text: "." },
    ],
  });
  expect(blocks.filter((block) => block.type === "mathBlock")).toHaveLength(3);
});

test("the viewport scenario keeps twelve separate paragraphs after its restoration anchor", () => {
  const blocks = readMarkdown(NFM_VIEWPORT_CONTINUITY_NFM, "exact");
  expect(blocks.slice(3)).toEqual([
    { type: "paragraph", content: [{ type: "text", text: "Viewport restoration anchor" }] },
    ...Array.from({ length: 12 }, (_, index) => ({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: `Viewport tail ${index + 1}: deterministic content after the restoration anchor.`,
        },
      ],
    })),
  ]);
});
