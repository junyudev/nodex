import { describe, expect, test } from "vite-plus/test";
import { projectCodeTokenStyle, resolveReadonlyCodeLanguage } from "./code-block-presentation";

describe("read-only code language", () => {
  test("uses the catalog label and grammar for catalog aliases", () => {
    expect(resolveReadonlyCodeLanguage("ts")).toEqual({
      id: "typescript",
      label: "TypeScript",
      highlightLanguage: "tsx",
    });
    expect(resolveReadonlyCodeLanguage("coq").label).toBe("Rocq");
  });

  test("keeps grammars outside the catalog under their authored name", () => {
    expect(resolveReadonlyCodeLanguage("zsh")).toEqual({
      id: "zsh",
      label: "zsh",
      highlightLanguage: "zsh",
    });
  });

  test("presents an empty info string as plain text", () => {
    expect(resolveReadonlyCodeLanguage("  ")).toEqual({
      id: "text",
      label: resolveReadonlyCodeLanguage("text").label,
      highlightLanguage: "text",
    });
  });
});

describe("code token paint", () => {
  test("never emits the light theme as inline paint that would mask the dark theme", () => {
    const style = projectCodeTokenStyle({
      htmlStyle: {
        color: "#6F42C1",
        "font-style": "italic",
        "--shiki-dark": "#B392F0",
        "--shiki-dark-font-style": "italic",
      },
    });

    expect(style).toEqual({
      "--shiki-light": "#6F42C1",
      "--shiki-light-font-style": "italic",
      "--shiki-dark": "#B392F0",
      "--shiki-dark-font-style": "italic",
    });
    expect(Object.keys(style).every((property) => property.startsWith("--"))).toBe(true);
  });

  test("projects single-theme token colors into the same light variables", () => {
    expect(projectCodeTokenStyle({ color: "#24292E", bgColor: "#FFFBDD" })).toEqual({
      "--shiki-light": "#24292E",
      "--shiki-light-bg": "#FFFBDD",
    });
  });
});
