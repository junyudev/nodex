import { describe, expect, test } from "vite-plus/test";
import { resolveUserMessageCollapsedHeightPx } from "./user-message-collapse-layout";

describe("collapsed user message geometry", () => {
  test("rounds the line cutoff up without cutting a subpixel text line", () => {
    expect(
      resolveUserMessageCollapsedHeightPx({
        lineHeightPx: 19.5,
        visibleLineCount: 19,
        rootTopPx: 0,
        physicalScale: 1,
        codeBlocks: [],
      }),
    ).toBe(371);
  });
  test("preserves a complete code block only when it crosses the cutoff", () => {
    const base = { lineHeightPx: 20, visibleLineCount: 4, rootTopPx: 100, physicalScale: 1 };
    expect(
      resolveUserMessageCollapsedHeightPx({ ...base, codeBlocks: [{ top: 150, bottom: 230.25 }] }),
    ).toBe(131);
    expect(
      resolveUserMessageCollapsedHeightPx({ ...base, codeBlocks: [{ top: 180, bottom: 250 }] }),
    ).toBe(80);
    expect(
      resolveUserMessageCollapsedHeightPx({ ...base, codeBlocks: [{ top: 100, bottom: 180 }] }),
    ).toBe(80);
  });
  test("uses the physical zoom ratio for embedded code blocks", () => {
    expect(
      resolveUserMessageCollapsedHeightPx({
        lineHeightPx: 20,
        visibleLineCount: 4,
        rootTopPx: 100,
        physicalScale: 2,
        codeBlocks: [{ top: 200, bottom: 400 }],
      }),
    ).toBe(150);
  });
});
