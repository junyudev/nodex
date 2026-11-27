import { describe, expect, it } from "vitest";
import { commentPreviewText } from "./comment-preview";

describe("commentPreviewText", () => {
  it("keeps the words and drops Markdown syntax", () => {
    expect(commentPreviewText("**@Ann** is this [true](https://x.y)?\n\n- `W6` jump")).toBe(
      "@Ann is this true? W6 jump",
    );
  });
});
