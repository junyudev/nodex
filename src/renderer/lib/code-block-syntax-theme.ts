import { registerCustomTheme, type ThemeRegistration, type ThemesType } from "@pierre/diffs";

const CODE_BLOCK_SYNTAX_THEME_NAME = "nodex-code-block";
const registeredSymbol = Symbol.for("nodex.codeBlockSyntaxThemeRegistered");

const syntax = (role: string) => `var(--color-codex-syntax-${role})`;
const FOREGROUND = "var(--color-token-editor-foreground)";

/**
 * Code blocks read with the Codex syntax palette. Its light and dark values live in the theme
 * contract, so one registration follows the app theme. TextMate scopes are grouped by the roles
 * the palette names; identifiers, operators and punctuation keep the editor foreground.
 */
const CODE_BLOCK_SYNTAX_THEME: ThemeRegistration = {
  name: CODE_BLOCK_SYNTAX_THEME_NAME,
  type: "light",
  fg: FOREGROUND,
  bg: "transparent",
  colors: { "editor.foreground": FOREGROUND, "editor.background": "transparent" },
  tokenColors: [
    { settings: { foreground: FOREGROUND } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: syntax("comment"), fontStyle: "italic" },
    },
    {
      scope: ["keyword", "storage.type", "storage.modifier"],
      settings: { foreground: syntax("keyword") },
    },
    {
      scope: ["keyword.operator", "storage.type.function.arrow", "punctuation"],
      settings: { foreground: FOREGROUND },
    },
    {
      scope: ["keyword.operator.new", "keyword.operator.expression", "keyword.operator.word"],
      settings: { foreground: syntax("keyword") },
    },
    {
      scope: [
        "constant.numeric",
        "constant.language",
        "support.constant",
        "support.class.builtin",
        "support.function.builtin",
        "support.type.primitive",
        "support.type.builtin",
      ],
      settings: { foreground: syntax("literal") },
    },
    {
      scope: [
        "string",
        "punctuation.definition.string",
        "string constant.character.escape",
        "string.regexp",
        "markup.inserted",
      ],
      settings: { foreground: syntax("string") },
    },
    { scope: ["meta.template.expression"], settings: { foreground: FOREGROUND } },
    {
      scope: [
        "variable.language",
        "variable.other.normal",
        "variable.other.special",
        "variable.other.positional",
        "punctuation.definition.variable",
        "entity.name.function",
        "entity.name.type",
        "entity.name.class",
        "entity.other.inherited-class",
        "entity.other.attribute-name.class",
        "entity.other.attribute-name.pseudo-class",
      ],
      settings: { foreground: syntax("variable") },
    },
    {
      scope: [
        "support.type.property-name",
        "punctuation.support.type.property-name",
        "entity.other.attribute-name",
        "entity.name.section",
        "markup.heading",
        "punctuation.definition.heading",
        "entity.name.tag.yaml",
      ],
      settings: { foreground: syntax("attribute") },
    },
    {
      scope: [
        "entity.name.tag",
        "entity.other.attribute-name.id",
        "meta.preprocessor",
        "keyword.control.directive",
        "constant.other.symbol",
        "punctuation.definition.list",
        "markup.underline.link",
      ],
      settings: { foreground: syntax("name") },
    },
    { scope: ["markup.deleted", "invalid"], settings: { foreground: syntax("error") } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
  ],
};

/** Registers the code-block theme on first use and names it for both color schemes. */
export function codeBlockSyntaxThemes(): ThemesType {
  const registry = globalThis as typeof globalThis & { [registeredSymbol]?: true };
  if (!registry[registeredSymbol]) {
    registerCustomTheme(CODE_BLOCK_SYNTAX_THEME_NAME, () =>
      Promise.resolve(CODE_BLOCK_SYNTAX_THEME),
    );
    registry[registeredSymbol] = true;
  }
  return { light: CODE_BLOCK_SYNTAX_THEME_NAME, dark: CODE_BLOCK_SYNTAX_THEME_NAME };
}
