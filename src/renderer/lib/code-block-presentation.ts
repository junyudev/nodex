import { findCodeLanguage, resolveCodeLanguage } from "../../shared/nfm/code-language-catalog";

export interface ReadonlyCodeLanguage {
  /** Catalog ID, or the authored token when the catalog has no entry for it. */
  readonly id: string;
  readonly label: string;
  /** Shiki grammar to request; unsupported grammars fall back to plain text in the highlighter. */
  readonly highlightLanguage: string;
}

/**
 * Catalog languages show their canonical label. Agent and file Markdown may name grammars outside
 * the durable NFM catalog (`sh`, `zsh`, `console`), so those keep their authored name and still
 * reach Shiki's own alias table.
 */
export function resolveReadonlyCodeLanguage(authored: string): ReadonlyCodeLanguage {
  const token = authored.trim();
  const language = token ? findCodeLanguage(token) : resolveCodeLanguage("text");
  if (language) {
    return {
      id: language.id,
      label: language.label,
      highlightLanguage: language.shikiLanguage ?? "text",
    };
  }
  return { id: token, label: token, highlightLanguage: token };
}

export interface CodeTokenPaint {
  readonly color?: string;
  readonly bgColor?: string;
  readonly htmlStyle?: Readonly<Record<string, string>>;
}

const LIGHT_PREFIX = "--shiki-light";

const lightVariable = (property: string): `--${string}` =>
  property === "color"
    ? LIGHT_PREFIX
    : property === "background-color"
      ? `${LIGHT_PREFIX}-bg`
      : `${LIGHT_PREFIX}-${property}`;

/**
 * Shiki inlines the light theme as ordinary paint properties beside `--shiki-dark*` variables.
 * Inline paint would beat any dark-scheme rule, so both schemes become variables and
 * `CODE_TOKEN_CLASS_NAME` selects one from the document color scheme.
 */
export function projectCodeTokenStyle(token: CodeTokenPaint): Record<`--${string}`, string> {
  const style: Record<`--${string}`, string> = {};
  if (token.color) style[lightVariable("color")] = token.color;
  if (token.bgColor) style[lightVariable("background-color")] = token.bgColor;
  for (const [property, value] of Object.entries(token.htmlStyle ?? {})) {
    style[property.startsWith("--") ? (property as `--${string}`) : lightVariable(property)] =
      value;
  }
  return style;
}

export const CODE_TOKEN_CLASS_NAME = [
  "[color:var(--shiki-light,inherit)]",
  "[background-color:var(--shiki-light-bg,transparent)]",
  "[font-style:var(--shiki-light-font-style,inherit)]",
  "[font-weight:var(--shiki-light-font-weight,inherit)]",
  "[text-decoration:var(--shiki-light-text-decoration,inherit)]",
  "dark:[color:var(--shiki-dark,inherit)]",
  "dark:[background-color:var(--shiki-dark-bg,transparent)]",
  "dark:[font-style:var(--shiki-dark-font-style,inherit)]",
  "dark:[font-weight:var(--shiki-dark-font-weight,inherit)]",
  "dark:[text-decoration:var(--shiki-dark-text-decoration,inherit)]",
].join(" ");
