/**
 * Custom code-block options that enable Shiki dual-theme highlighting.
 *
 * BlockNote's default parser uses a single Shiki theme (github-dark), which
 * bakes dark-mode colors into inline styles that CSS cannot override.
 *
 * By pre-seeding the global parser symbol with a dual-theme parser, tokens
 * get CSS variables (--shiki-light / --shiki-dark) instead of fixed colors.
 * A companion CSS rule in globals.css switches between them based on the
 * container's color scheme.
 */
import { codeBlockOptions } from "@blocknote/code-block";
import { createParser } from "prosemirror-highlight/shiki";
import type { CodeBlockOptions } from "@blocknote/core";
import { getHighlighter } from "@/lib/shiki";

const shikiParserSymbol = Symbol.for("blocknote.shikiParser");

export const dualThemeCodeBlockOptions: CodeBlockOptions = {
  ...codeBlockOptions,
  defaultLanguage: "text",
  createHighlighter: async () => {
    const hl = await getHighlighter();

    // Pre-seed the global parser with dual-theme support so BlockNote's
    // lazyShikiPlugin picks it up instead of creating a single-theme one.
    const parser = createParser(hl as never, {
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
    } as never);

    (globalThis as Record<symbol, unknown>)[shikiParserSymbol] = parser;

    return hl;
  },
};
