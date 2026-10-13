import { createCodePlugin } from "@streamdown/code";
import { NFM_CODE_THEME_PAIR } from "../syntax-highlighting";

const baseStreamdownCodePlugin = createCodePlugin({
  themes: [NFM_CODE_THEME_PAIR[0], NFM_CODE_THEME_PAIR[1]],
});

type StreamdownHighlightOptions = Parameters<typeof baseStreamdownCodePlugin.highlight>[0];
type StreamdownHighlightResult = Exclude<
  ReturnType<typeof baseStreamdownCodePlugin.highlight>,
  null
>;

function createPlainTextHighlightResult(code: string): StreamdownHighlightResult {
  return {
    bg: "transparent",
    fg: "inherit",
    tokens: code.split("\n").map((line) => [
      {
        content: line,
        color: "inherit",
        bgColor: "transparent",
        htmlStyle: {},
        offset: 0,
      },
    ]),
  };
}

export const streamdownCodePlugin = {
  ...baseStreamdownCodePlugin,
  highlight(
    options: StreamdownHighlightOptions,
    callback?: Parameters<typeof baseStreamdownCodePlugin.highlight>[1],
  ) {
    if (!baseStreamdownCodePlugin.supportsLanguage(options.language)) {
      return createPlainTextHighlightResult(options.code);
    }
    return baseStreamdownCodePlugin.highlight(options, callback);
  },
};
