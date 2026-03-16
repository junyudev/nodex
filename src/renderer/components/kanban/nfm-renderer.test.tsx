import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NfmRenderer } from "./nfm-renderer";

describe("NfmRenderer", () => {
  test("renders code blocks through Streamdown's code block renderer", () => {
    const markup = renderToStaticMarkup(
      createElement(NfmRenderer, {
        content: "```ts\nconst answer = 42\n```",
      }),
    );

    expect(markup.includes('data-streamdown="code-block"')).toBeTrue();
    expect(markup.includes('data-language="ts"')).toBeTrue();
    expect(markup.includes("const")).toBeTrue();
  });

  test("falls back to plain code rendering for unknown languages without custom shiki HTML", () => {
    const markup = renderToStaticMarkup(
      createElement(NfmRenderer, {
        content: "```madeuplang\nhello()\n```",
      }),
    );

    expect(markup.includes('data-streamdown="code-block"')).toBeTrue();
    expect(markup.includes("hello()")).toBeTrue();
  });
});
