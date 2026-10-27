export const CODE_BLOCK_SYNTAX_THEME_NAME = "nodex-code-block";

const syntax = (role: string) => `var(--color-codex-syntax-${role})`;
const FOREGROUND = "var(--foreground)";

/**
 * Every code block (editor, previews, conversation and raw tool inspection) reads with the Codex
 * syntax palette. Its light and dark values live in the theme contract, so one theme follows the
 * color scheme wherever it is declared. TextMate scopes are grouped by the roles the palette
 * names; identifiers, operators and punctuation keep the code foreground.
 */
export const CODE_BLOCK_SYNTAX_THEME = {
  name: CODE_BLOCK_SYNTAX_THEME_NAME,
  type: "light" as const,
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
    // Template substitutions and bare shell words are code, not string content.
    {
      scope: ["meta.template.expression", "string.unquoted.argument", "constant.other.option"],
      settings: { foreground: FOREGROUND },
    },
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
        "meta.decorator",
        "entity.name.function.decorator",
        "punctuation.definition.decorator",
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
