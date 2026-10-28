import type { Options, Plugin } from "prettier";
import {
  type CodeFormatterKind,
  resolveCodeLanguage,
} from "../../../shared/code-languages/code-language-catalog";

export type CodeFormatResult =
  | { readonly status: "formatted"; readonly code: string }
  | { readonly status: "unchanged" }
  | { readonly status: "unsupported" }
  | { readonly status: "failed"; readonly error: Error };

interface LoadedCodeFormatter {
  format(source: string): Promise<string>;
}

export type LoadCodeFormatter = (kind: CodeFormatterKind) => Promise<LoadedCodeFormatter>;

const withoutTrailingLineBreak = (source: string) => source.replace(/\r?\n$/u, "");

async function loadCodeFormatter(kind: CodeFormatterKind): Promise<LoadedCodeFormatter> {
  const prettier = await import("prettier/standalone");
  const baseOptions = {
    printWidth: 80,
    tabWidth: 2,
    useTabs: false,
  } satisfies Options;

  if (kind === "css" || kind === "scss") {
    const postcss = await import("prettier/plugins/postcss");
    return {
      format: (source) =>
        prettier.format(source, {
          ...baseOptions,
          parser: kind,
          plugins: [postcss.default as Plugin],
        }),
    };
  }

  if (kind === "graphql") {
    const graphql = await import("prettier/plugins/graphql");
    return {
      format: (source) =>
        prettier.format(source, {
          ...baseOptions,
          parser: "graphql",
          plugins: [graphql.default as Plugin],
        }),
    };
  }

  if (kind === "html") {
    const html = await import("prettier/plugins/html");
    return {
      format: (source) =>
        prettier.format(source, {
          ...baseOptions,
          parser: "html",
          plugins: [html.default as Plugin],
        }),
    };
  }

  if (kind === "xml") {
    const xml = await import("@prettier/plugin-xml");
    return {
      format: (source) =>
        prettier.format(source, {
          ...baseOptions,
          parser: "xml",
          plugins: [xml.default as Plugin],
          xmlWhitespaceSensitivity: "ignore",
        } as Options),
    };
  }

  const [estree, language] = await Promise.all([
    import("prettier/plugins/estree"),
    kind === "typescript"
      ? import("prettier/plugins/typescript")
      : import("prettier/plugins/babel"),
  ]);
  const parser = kind === "typescript" ? "typescript" : kind === "json" ? "json" : "babel";
  return {
    format: (source) =>
      prettier.format(source, {
        ...baseOptions,
        parser,
        plugins: [language.default as Plugin, estree.default as Plugin],
      }),
  };
}

/**
 * Builds the formatter boundary separately from its lazy chunk loader so failures remain
 * recoverable and behavior can be tested without loading editor-only dependencies.
 */
export function createFormatCode(loadFormatter: LoadCodeFormatter = loadCodeFormatter) {
  return async (languageId: string, source: string): Promise<CodeFormatResult> => {
    const formatterKind = resolveCodeLanguage(languageId).formatterKind;
    if (!formatterKind) return { status: "unsupported" };

    try {
      const formatter = await loadFormatter(formatterKind);
      const formatted = withoutTrailingLineBreak(await formatter.format(source));
      if (formatted === source) return { status: "unchanged" };
      return { status: "formatted", code: formatted };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  };
}

export const formatCode = createFormatCode();
