import { describe, expect, it } from "vite-plus/test";
import { inboxModelGuideEntry } from "./inbox-model-guide";

const familyOf = (slug: string, name = slug) => inboxModelGuideEntry({ slug, name })?.family;

describe("inboxModelGuideEntry", () => {
  it("finds each family by its catalog id or name", () => {
    expect(familyOf("gpt-6.2-sol", "GPT-6.2-Sol")).toBe("GPT-6.2 Sol");
    expect(familyOf("custom-alias", "GPT-6.2 Sol")).toBe("GPT-6.2 Sol");
    expect(familyOf("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(familyOf("custom-alias", "Opus 5.5")).toBe("Claude Opus 5.5");
    expect(familyOf("gemini-4-neon", "Gemini 4 Neon")).toBe("Gemini 4 Neon");
    // The guide speaks for one model, not its siblings, predecessors or tools built on it.
    expect(familyOf("gpt-6.2-astra", "GPT-6.2-Astra")).toBeUndefined();
    expect(familyOf("gpt-6.1-sol", "GPT-6.1-Sol")).toBeUndefined();
    expect(familyOf("claude-opus-5")).toBeUndefined();
    expect(familyOf("gemini-4-argon", "Gemini 4 Argon")).toBeUndefined();
    expect(familyOf("gemini-pro-orchestrator-neon", "Orchestrator (Neon)")).toBeUndefined();
  });
});
