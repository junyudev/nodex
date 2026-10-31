import { describe, expect, it } from "vite-plus/test";
import { inboxModelGuideEntry } from "./inbox-model-guide";

const familyOf = (slug: string, name = slug) => inboxModelGuideEntry({ slug, name })?.family;

describe("inboxModelGuideEntry", () => {
  it("finds each family by its catalog id or name", () => {
    expect(familyOf("gpt-6.1-sol")).toBe("GPT-6.1");
    expect(familyOf("gpt-6.1-terra")).toBe("GPT-6.1");
    expect(familyOf("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(familyOf("custom-alias", "Opus 5.5")).toBe("Claude Opus 5.5");
    expect(familyOf("gpt-6-sol")).toBeUndefined();
    expect(familyOf("claude-opus-5")).toBeUndefined();
  });

  it("marks only the models OpenCode offers for free as free", () => {
    const free = inboxModelGuideEntry({
      slug: "opencode/deepseek-v4.1-flash-free",
      name: "DeepSeek V4.1 Flash Free",
    });
    expect(free?.family).toBe("OpenCode free models");
    expect(free?.free).toBe(true);
    // A model is free only when OpenCode names it so; billed models through OpenCode are not.
    expect(familyOf("opencode/big-pickle", "Big Pickle")).toBeUndefined();
    expect(familyOf("google/gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview")).toBeUndefined();
    expect(familyOf("openrouter/some-model-free", "Some Model Free")).toBeUndefined();
  });
});
