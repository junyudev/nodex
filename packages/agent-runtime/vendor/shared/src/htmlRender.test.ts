import { describe, expect, it } from "vite-plus/test";

import { readHtmlRenderReference } from "./htmlRender.ts";
import { htmlRenderFromToolItem } from "./toolOutput.ts";

const reference = { attachmentId: "thread-abc-123.html", title: "Chart", height: 420 };

describe("readHtmlRenderReference", () => {
  it("clamps height and rejects malformed references", () => {
    expect(readHtmlRenderReference({ ...reference, height: 99_999 })?.height).toBe(2000);
    expect(readHtmlRenderReference({ ...reference, title: "  " })?.title).toBe("HTML");
    expect(readHtmlRenderReference({ ...reference, attachmentId: 4 })).toBeUndefined();
    expect(readHtmlRenderReference({ ...reference, height: Number.NaN })).toBeUndefined();
  });
});

describe("htmlRenderFromToolItem", () => {
  const result = { htmlRender: reference, message: "Rendered above your reply." };

  it("reads the reference from each provider's result envelope", () => {
    for (const [toolName, output] of [
      ["mcp__nodex_app__html_render", [{ type: "text", text: JSON.stringify(result) }]],
      ["nodex_app.html_render", { structuredContent: result, content: [] }],
      ["nodex_app-thread_1_html_render", JSON.stringify(result)],
      ["html_render", result],
    ] as const) {
      expect(htmlRenderFromToolItem({ toolName, output })).toEqual(reference);
    }
  });

  it("ignores other tools and failed calls", () => {
    expect(
      htmlRenderFromToolItem({ toolName: "mcp__nodex_app__html_preview", output: result }),
    ).toBe(undefined);
    expect(htmlRenderFromToolItem({ toolName: "mcp__other__html_render", output: result })).toBe(
      undefined,
    );
    expect(
      htmlRenderFromToolItem({ toolName: "html_render", output: { ...result, isError: true } }),
    ).toBeUndefined();
  });
});
