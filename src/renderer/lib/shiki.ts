/**
 * Shared Shiki highlighter singleton for syntax highlighting in read-only views.
 * Uses the same Shiki packages that @blocknote/code-block depends on.
 */
import { createdBundledHighlighter } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import type {
  DynamicImportLanguageRegistration,
  DynamicImportThemeRegistration,
  HighlighterGeneric,
} from "@shikijs/types";

type BundledTheme = "github-light" | "github-dark";

const bundledLanguages: Record<string, DynamicImportLanguageRegistration> = {
  c: () => import("@shikijs/langs-precompiled/c"),
  cpp: () => import("@shikijs/langs-precompiled/cpp"),
  css: () => import("@shikijs/langs-precompiled/css"),
  html: () => import("@shikijs/langs-precompiled/html"),
  java: () => import("@shikijs/langs-precompiled/java"),
  javascript: () => import("@shikijs/langs-precompiled/javascript"),
  js: () => import("@shikijs/langs-precompiled/javascript"),
  json: () => import("@shikijs/langs-precompiled/json"),
  jsx: () => import("@shikijs/langs-precompiled/jsx"),
  markdown: () => import("@shikijs/langs-precompiled/markdown"),
  md: () => import("@shikijs/langs-precompiled/markdown"),
  python: () => import("@shikijs/langs-precompiled/python"),
  py: () => import("@shikijs/langs-precompiled/python"),
  ruby: () => import("@shikijs/langs-precompiled/ruby"),
  rb: () => import("@shikijs/langs-precompiled/ruby"),
  rust: () => import("@shikijs/langs-precompiled/rust"),
  rs: () => import("@shikijs/langs-precompiled/rust"),
  scss: () => import("@shikijs/langs-precompiled/scss"),
  shellscript: () => import("@shikijs/langs-precompiled/shellscript"),
  bash: () => import("@shikijs/langs-precompiled/shellscript"),
  sh: () => import("@shikijs/langs-precompiled/shellscript"),
  shell: () => import("@shikijs/langs-precompiled/shellscript"),
  zsh: () => import("@shikijs/langs-precompiled/shellscript"),
  sql: () => import("@shikijs/langs-precompiled/sql"),
  typescript: () => import("@shikijs/langs-precompiled/typescript"),
  ts: () => import("@shikijs/langs-precompiled/typescript"),
  tsx: () => import("@shikijs/langs-precompiled/tsx"),
  xml: () => import("@shikijs/langs-precompiled/xml"),
  yaml: () => import("@shikijs/langs-precompiled/yaml"),
  yml: () => import("@shikijs/langs-precompiled/yaml"),
  go: () => import("@shikijs/langs-precompiled/go"),
  kotlin: () => import("@shikijs/langs-precompiled/kotlin"),
  kt: () => import("@shikijs/langs-precompiled/kotlin"),
  lua: () => import("@shikijs/langs-precompiled/lua"),
  swift: () => import("@shikijs/langs/swift"),
  csharp: () => import("@shikijs/langs-precompiled/csharp"),
  cs: () => import("@shikijs/langs-precompiled/csharp"),
  scala: () => import("@shikijs/langs-precompiled/scala"),
  haskell: () => import("@shikijs/langs-precompiled/haskell"),
  hs: () => import("@shikijs/langs-precompiled/haskell"),
  php: () => import("@shikijs/langs-precompiled/php"),
  graphql: () => import("@shikijs/langs-precompiled/graphql"),
  gql: () => import("@shikijs/langs-precompiled/graphql"),
  svelte: () => import("@shikijs/langs-precompiled/svelte"),
  vue: () => import("@shikijs/langs-precompiled/vue"),
  latex: () => import("@shikijs/langs-precompiled/latex"),
};

const bundledThemes = {
  "github-dark": () => import("@shikijs/themes/github-dark"),
  "github-light": () => import("@shikijs/themes/github-light"),
} as Record<BundledTheme, DynamicImportThemeRegistration>;

type Highlighter = HighlighterGeneric<string, BundledTheme>;

const createHighlighter = createdBundledHighlighter<string, BundledTheme>({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: () => createJavaScriptRegexEngine(),
});

let highlighterPromise: Promise<Highlighter> | null = null;

/** Returns (or creates) the singleton Shiki highlighter. */
export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: [],
    });
  }
  return highlighterPromise;
}

const supportedLangs = new Set(Object.keys(bundledLanguages));

/** Check whether a language identifier is loadable by the bundled highlighter. */
export function isSupportedLanguage(lang: string): boolean {
  return supportedLangs.has(lang.toLowerCase());
}
