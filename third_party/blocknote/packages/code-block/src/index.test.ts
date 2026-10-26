import { describe, expect, it } from "vitest";
import { createCodeBlockHighlighter } from "./index.js";

describe("@blocknote/code-block", () => {
  it("exposes the generated highlighter factory", async () => {
    const highlighter = await createCodeBlockHighlighter({
      themes: [{ name: "plain", type: "light", fg: "#000000", bg: "#ffffff", settings: [] }],
      langs: [],
    });

    await expect(highlighter.loadLanguage("typescript")).resolves.toBeUndefined();
    await expect(highlighter.loadLanguage("arduino")).resolves.toBeUndefined();
    await expect(highlighter.loadLanguage("python")).resolves.toBeUndefined();
    await expect(highlighter.loadLanguage("visual-basic")).resolves.toBeUndefined();
    expect(highlighter.getLoadedLanguages()).toContain("tsx");
    expect(highlighter.getLoadedLanguages()).toEqual(
      expect.arrayContaining(["cpp", "python", "vb"]),
    );
  });
});
