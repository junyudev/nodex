import { describe, expect, test, vi } from "vite-plus/test";
import {
  canFormatCodeLanguage,
  getCodeBlockPlainText,
  getCodeBlockActionBarMode,
  searchCodeLanguages,
} from "./code-block-model";
import { createCodeLanguagePreference } from "./code-language-preference";
import {
  codeWrapStateStorageKey,
  createCodeBlockViewStateStore,
  mermaidPreviewModeStorageKey,
} from "./code-block-view-state";

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

describe("code block view state", () => {
  function createStorage(initial: Readonly<Record<string, string>> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
  }

  describe("Code block renderer view state", () => {
    test("defaults to nowrap and restores a valid value for the same block id", () => {
      const storage = createStorage();
      const first = createCodeBlockViewStateStore(storage);
      expect(first.getWrapped("code-1")).toBe(false);

      first.setWrapped("code-1", true);
      expect(first.getWrapped("code-1")).toBe(true);
      expect(createCodeBlockViewStateStore(storage).getWrapped("code-1")).toBe(true);
      expect(createCodeBlockViewStateStore(storage).getWrapped("code-2")).toBe(false);
    });

    test("treats malformed storage as nowrap", () => {
      const storage = createStorage({
        [codeWrapStateStorageKey("bad")]: "yes",
        [codeWrapStateStorageKey("false")]: "false",
      });

      expect(createCodeBlockViewStateStore(storage).getWrapped("bad")).toBe(false);
      expect(createCodeBlockViewStateStore(storage).getWrapped("false")).toBe(false);
    });

    test("defaults Mermaid code to split and restores view mode only for the same block id", () => {
      const storage = createStorage();
      const first = createCodeBlockViewStateStore(storage);
      expect(first.getMermaidPreviewMode("diagram-1")).toBe("split");

      first.setMermaidPreviewMode("diagram-1", "preview");
      expect(createCodeBlockViewStateStore(storage).getMermaidPreviewMode("diagram-1")).toBe(
        "preview",
      );
      expect(createCodeBlockViewStateStore(storage).getMermaidPreviewMode("duplicate-id")).toBe(
        "split",
      );
    });

    test("ignores malformed Mermaid mode storage", () => {
      const storage = createStorage({ [mermaidPreviewModeStorageKey("bad")]: "side-by-side" });
      expect(createCodeBlockViewStateStore(storage).getMermaidPreviewMode("bad")).toBe("split");
    });

    test("notifies only the changed block subscribers", () => {
      const store = createCodeBlockViewStateStore(createStorage());
      const code1 = vi.fn();
      const code2 = vi.fn();
      const unsubscribe = store.subscribe("code-1", code1);
      store.subscribe("code-2", code2);

      store.setWrapped("code-1", true);
      store.setWrapped("code-1", true);
      store.setMermaidPreviewMode("code-1", "preview");
      store.setMermaidPreviewMode("code-1", "preview");
      unsubscribe();
      store.setWrapped("code-1", false);

      expect(code1).toHaveBeenCalledTimes(2);
      expect(code2).not.toHaveBeenCalled();
    });

    test("keeps the current session responsive when storage throws", () => {
      const listener = vi.fn();
      const store = createCodeBlockViewStateStore({
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      });
      store.subscribe("code-1", listener);

      expect(store.getWrapped("code-1")).toBe(false);
      store.setWrapped("code-1", true);
      store.setMermaidPreviewMode("code-1", "code");

      expect(store.getWrapped("code-1")).toBe(true);
      expect(store.getMermaidPreviewMode("code-1")).toBe("code");
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });
});
