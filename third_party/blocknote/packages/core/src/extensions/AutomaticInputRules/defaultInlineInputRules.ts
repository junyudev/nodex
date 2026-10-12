import {
  starInputRegex as boldStarInputRegex,
  underscoreInputRegex as boldUnderscoreInputRegex,
} from "@tiptap/extension-bold";
import {
  starInputRegex as italicStarInputRegex,
  underscoreInputRegex as italicUnderscoreInputRegex,
} from "@tiptap/extension-italic";
import { inputRegex as strikeInputRegex } from "@tiptap/extension-strike";
import { getMarksBetween } from "@tiptap/core";
import type { MarkType, Schema } from "prosemirror-model";
import { findInlineCodeInputRuleMatch } from "../tiptap-extensions/InlineCode/InlineCode.js";
import type {
  AutomaticInputRule,
  AutomaticInputRuleFinder,
} from "./AutomaticInputRules.js";

const fullWidthBoldStarInputRegex =
  /(?:^|\s)(＊＊(?!\s+＊＊)((?:[^＊]+))＊＊(?!\s+＊＊))$/u;
const fullWidthBoldUnderscoreInputRegex =
  /(?:^|\s)(＿＿(?!\s+＿＿)((?:[^＿]+))＿＿(?!\s+＿＿))$/u;
const fullWidthItalicStarInputRegex =
  /(?:^|\s)(＊(?!\s+＊)((?:[^＊]+))＊(?!\s+＊))$/u;
const fullWidthItalicUnderscoreInputRegex =
  /(?:^|\s)(＿(?!\s+＿)((?:[^＿]+))＿(?!\s+＿))$/u;

function createMarkInputRule(options: {
  readonly find: AutomaticInputRuleFinder;
  readonly type: MarkType;
}): AutomaticInputRule {
  return {
    find: options.find,
    inCodeMark: false,
    transform: ({ state, range, match }) => {
      const content = match[match.length - 1];
      if (!content) return null;

      const fullMatch = match[0];
      const leadingWhitespace = fullMatch.search(/\S/u);
      const contentStart = range.from + fullMatch.indexOf(content);
      const contentEnd = contentStart + content.length;
      const excludedMarks = getMarksBetween(range.from, range.to, state.doc)
        .filter(({ mark }) => {
          return mark.type !== options.type && mark.type.excludes(options.type);
        })
        .some(({ to }) => to > contentStart);
      if (excludedMarks) return null;

      const transaction = state.tr;
      if (contentEnd < range.to) transaction.delete(contentEnd, range.to);
      if (contentStart > range.from) {
        transaction.delete(range.from + leadingWhitespace, contentStart);
      }

      const markEnd = range.from + leadingWhitespace + content.length;
      transaction.addMark(
        range.from + leadingWhitespace,
        markEnd,
        options.type.create(),
      );
      transaction.removeStoredMark(options.type);
      return transaction;
    },
  };
}

function characterAfterRange(
  state: Parameters<AutomaticInputRule["transform"]>[0]["state"],
  range: Parameters<AutomaticInputRule["transform"]>[0]["range"],
): string | undefined {
  if (range.to >= state.doc.content.size) return undefined;
  return state.doc.textBetween(
    range.to,
    Math.min(range.to + 1, state.doc.content.size),
    "",
    "\uFFFC",
  )[0];
}

function isClosingBoundary(character: string | undefined): boolean {
  return character === undefined || character === ")" || /\s/u.test(character);
}

export function createDefaultInlineInputRules(
  schema: Schema,
): AutomaticInputRule[] {
  const rules: AutomaticInputRule[] = [];
  const bold = schema.marks.bold;
  if (bold) {
    rules.push(
      createMarkInputRule({ find: boldStarInputRegex, type: bold }),
      createMarkInputRule({ find: boldUnderscoreInputRegex, type: bold }),
      createMarkInputRule({ find: fullWidthBoldStarInputRegex, type: bold }),
      createMarkInputRule({
        find: fullWidthBoldUnderscoreInputRegex,
        type: bold,
      }),
    );
  }

  const italic = schema.marks.italic;
  if (italic) {
    rules.push(
      createMarkInputRule({ find: italicStarInputRegex, type: italic }),
      createMarkInputRule({ find: italicUnderscoreInputRegex, type: italic }),
      createMarkInputRule({ find: fullWidthItalicStarInputRegex, type: italic }),
      createMarkInputRule({
        find: fullWidthItalicUnderscoreInputRegex,
        type: italic,
      }),
    );
  }

  const strike = schema.marks.strike;
  if (strike) {
    rules.push(createMarkInputRule({ find: strikeInputRegex, type: strike }));
  }

  const code = schema.marks.code;
  if (code) {
    for (const delimiter of ["`", "´", "｀"] as const) {
      const find = (textBeforeCursor: string) =>
        findInlineCodeInputRuleMatch(textBeforeCursor, delimiter);
      const markRule = createMarkInputRule({ find, type: code });
      rules.push({
        ...markRule,
        transform: (context) => {
          if (!isClosingBoundary(characterAfterRange(context.state, context.range))) {
            return null;
          }
          return markRule.transform(context);
        },
      });
    }
  }

  return rules;
}
