import { describe, expect, test } from "vite-plus/test";
import {
  canFormatCodeLanguage,
  getCodeBlockPlainText,
  getCodeBlockActionBarMode,
  searchCodeLanguages,
} from "./code-block-model";
import { createCodeLanguagePreference } from "./code-language-preference";

describe("Code block UI model", () => {
  test("projects the measured capacity boundaries", () => {
    expect(getCodeBlockActionBarMode(230)).toBe("more_only");
    expect(getCodeBlockActionBarMode(231)).toBe("minimal");
    expect(getCodeBlockActionBarMode(350)).toBe("minimal");
    expect(getCodeBlockActionBarMode(351)).toBe("all");
    expect(getCodeBlockActionBarMode(800, 1 / 3)).toBe("more_only");
    expect(getCodeBlockActionBarMode(800, 0.49)).toBe("minimal");
    expect(getCodeBlockActionBarMode(800, 0.5)).toBe("all");
  });

  test("searches labels, aliases, extensions, and fuzzy terms", () => {
    expect(searchCodeLanguages("tsx", "en").map(({ label }) => label)).toEqual(["TypeScript"]);
    expect(searchCodeLanguages("coq", "en").map(({ label }) => label)).toEqual(["Rocq"]);
    expect(searchCodeLanguages("backus", "en").map(({ label }) => label)).toEqual(["BNF", "EBNF"]);
  });

  test("uses explicit formatter capability", () => {
    expect(canFormatCodeLanguage("typescript")).toBe(true);
    expect(canFormatCodeLanguage("rust")).toBe(false);
    expect(canFormatCodeLanguage("vue")).toBe(false);
  });

  test("extracts complete code text without fences", () => {
    expect(
      getCodeBlockPlainText({
        content: [
          { type: "text", text: "const " },
          { type: "text", text: "answer = 42;" },
        ],
      }),
    ).toBe("const answer = 42;");
    expect(getCodeBlockPlainText({ content: "plain" })).toBe("plain");
  });
});

describe("Code language creation preference", () => {
  test("persists only catalog languages and survives unavailable storage", () => {
    const values = new Map<string, string>();
    const preference = createCodeLanguagePreference({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    });

    expect(preference.get()).toBe("text");
    preference.set("tsx");
    expect(preference.get()).toBe("typescript");

    const restored = createCodeLanguagePreference({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    });
    expect(restored.get()).toBe("typescript");

    restored.set("vue");
    expect(restored.get()).toBe("text");

    const unavailable = createCodeLanguagePreference({
      getItem: () => {
        throw new Error("disabled");
      },
      setItem: () => {
        throw new Error("disabled");
      },
    });
    unavailable.set("python");
    expect(unavailable.get()).toBe("python");
  });
});
