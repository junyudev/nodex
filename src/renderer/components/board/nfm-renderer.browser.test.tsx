import { render } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";

import "../../globals.css";
import { NfmDocument } from "./nfm-renderer";
import { readMarkdown } from "../../../shared/nodex-markdown";

/** Nodex Markdown read and shown as a Page lays it out. */
function NfmRenderer({ content }: { readonly content: string }) {
  return <NfmDocument blocks={readMarkdown(content)} />;
}

describe("NfmRenderer quote geometry in Chromium", () => {
  test("keeps the rule and content on the same inherited color and rhythm", () => {
    const view = render(
      <div style={{ color: "rgb(24, 93, 161)", fontSize: 16 }}>
        <NfmRenderer content={"> quote-line1<br>quote-line2"} />
      </div>,
    );
    const quote = view.container.querySelector<HTMLElement>("blockquote")!;
    const style = getComputedStyle(quote);

    expect(style.marginBlockStart).toBe("8px");
    expect(style.marginInlineStart).toBe("8px");
    expect(style.borderInlineStartWidth).toBe("3px");
    expect(style.borderInlineStartColor).toBe(style.color);
    expect(style.paddingInlineStart).toBe("22px");
    expect(style.paddingInlineEnd).toBe("22px");
    expect(style.fontSize).toBe("16px");
    expect(style.lineHeight).toBe("24px");
  });
});
