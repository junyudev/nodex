import { describe, expect, test } from "vite-plus/test";
import { buildSessionTitlePrompt, parseGeneratedSessionTitle } from "./session-title-prompt";

describe("session title prompt", () => {
  test("carries the opening prompt, bounded, and nothing for an empty one", () => {
    const prompt = buildSessionTitlePrompt("x".repeat(2_500));
    expect(prompt.split("User prompt:\n")[1]).toHaveLength(2_000);
    expect(buildSessionTitlePrompt("   ")).toBe("");
  });
});

describe("generated session title", () => {
  test("cleans what the model wrote", () => {
    expect(parseGeneratedSessionTitle({ title: 'title: "Fix flaky test."' })).toBe(
      "Fix flaky test",
    );
  });

  test("shortens a title from a model only its prompt could hold to the limit", () => {
    const title = parseGeneratedSessionTitle({
      title: "This title is definitely longer than thirty six chars",
    });
    expect(title).toHaveLength(36);
    expect(title?.endsWith("…")).toBe(true);
  });

  test("ignores fields the schema does not ask for", () => {
    expect(parseGeneratedSessionTitle({ title: "Fix login", description: "Extra" })).toBe(
      "Fix login",
    );
  });

  test.each([{ title: "" }, { title: "   " }, { name: "Fix login" }, "Fix login", null])(
    "finds no title in %j",
    (output) => {
      expect(parseGeneratedSessionTitle(output)).toBeNull();
    },
  );
});
