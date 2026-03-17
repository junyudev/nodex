import { describe, expect, test } from "bun:test";
import {
  render,
  settleAsyncRender,
  textContent,
  waitForStreamdownCodeHighlight,
} from "../../test/dom";
import { NfmRenderer } from "./nfm-renderer";

describe("NfmRenderer", () => {
  test("renders code blocks through Streamdown's code block renderer", async () => {
    const { container } = render(
      <NfmRenderer content={"```ts\nconst answer = 42\n```"} />,
    );
    await waitForStreamdownCodeHighlight(container);

    expect(container.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
    expect(container.querySelector('[data-language="ts"]')).not.toBeNull();
    expect(container.querySelector('pre[style*="--shiki-dark-bg"]')).not.toBeNull();
    expect(textContent(container).includes("const")).toBeTrue();
  });

  test("falls back to plain code rendering for unknown languages without custom shiki HTML", async () => {
    const { container } = render(
      <NfmRenderer content={"```madeuplang\nhello()\n```"} />,
    );
    await settleAsyncRender();

    expect(container.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
    expect(container.querySelector('pre[style*="--shiki-dark-bg"]') === null).toBeTrue();
    expect(textContent(container).includes("hello()")).toBeTrue();
  });
});
