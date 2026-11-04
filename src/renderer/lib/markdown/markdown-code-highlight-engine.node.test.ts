import { code } from "@streamdown/code";
import { expect, test } from "vite-plus/test";
import { CODE_BLOCK_SYNTAX_THEME_NAME } from "../code-block-syntax-theme";
import { highlightCode } from "./markdown-code-highlight-engine";
import { CODE_HIGHLIGHT_LANGUAGES } from "./markdown-code-highlight-languages";

test("the engine-free admission catalog matches the supported snippet grammars and aliases", () => {
  expect(new Set(CODE_HIGHLIGHT_LANGUAGES)).toEqual(new Set(code.getSupportedLanguages()));
});

test("appended multiline code keeps its grammar and absolute token offsets across the worker port", async () => {
  const source = "const value = 3;\n/* multiline comment\n";
  const suffix = '  still a comment */\nconst last = "value";';
  const options = { language: "typescript", theme: CODE_BLOCK_SYNTAX_THEME_NAME } as const;
  const incomplete = await highlightCode({ ...options, code: source, incomplete: true });
  const complete = await highlightCode({ ...options, code: source + suffix, incomplete: false });
  expect(incomplete?.tokens[0]).toEqual(complete?.tokens[0]);
  expect(
    complete?.tokens.map((line) => line.map((token) => token.content).join("")).join("\n"),
  ).toBe(source + suffix);
  expect(complete?.tokens[2]?.[0]?.offset).toBe(source.length);
  const comment = complete?.tokens[2]?.[0];
  expect(comment?.htmlStyle?.color ?? comment?.color).toBe("var(--color-codex-syntax-comment)");
  expect(structuredClone(complete)).toEqual(complete);
});
