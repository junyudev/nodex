import { describe, expect, test } from "bun:test";
import { render, textContent } from "../../test/dom";
import { NfmRenderer } from "./nfm-renderer";

describe("NfmRenderer", () => {
  test("renders code blocks through Streamdown's code block renderer", () => {
    const { container } = render(
      <NfmRenderer content={"```ts\nconst answer = 42\n```"} />,
    );

    expect(container.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
    expect(container.querySelector('[data-language="ts"]')).not.toBeNull();
    expect(textContent(container).includes("const")).toBeTrue();
  });

  test("falls back to plain code rendering for unknown languages without custom shiki HTML", () => {
    const { container } = render(
      <NfmRenderer content={"```madeuplang\nhello()\n```"} />,
    );

    expect(container.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
    expect(textContent(container).includes("hello()")).toBeTrue();
  });
});
