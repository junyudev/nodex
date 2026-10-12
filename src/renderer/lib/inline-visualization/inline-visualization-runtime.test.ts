import { describe, expect, test, vi } from "vite-plus/test";
import { createInlineVisualizationHostHandlers } from "./inline-visualization-runtime";
import { parseInlineVisualizationHeight } from "./inline-visualization-document";

describe("inline visualization host boundary", () => {
  test("clamps valid heights and rejects non-finite or invalid dimensions", () => {
    expect(parseInlineVisualizationHeight({ height: 10_000.5, width: 800 })).toBe(10_000);
    expect(parseInlineVisualizationHeight(0)).toBe(0);
    expect(parseInlineVisualizationHeight({ height: 120.25, width: 500.5 })).toBe(121);
    for (const value of [NaN, Infinity, -1, { height: 20, width: -1 }, { height: "20" }])
      expect(parseInlineVisualizationHeight(value)).toBeNull();
  });
  test("accepts only reserved presentation notifications and fences tools and follow-ups", async () => {
    const callbacks = {
      ready: vi.fn(),
      fail: vi.fn(),
      height: vi.fn(),
      interact: vi.fn(),
      mode: vi.fn((mode: "inline" | "fullscreen") => mode),
      openExternal: vi.fn(async () => {}),
    };
    const handlers = createInlineVisualizationHostHandlers(callbacks);
    expect(() => handlers.callMcp({ method: "tools/call" })).toThrow("cannot call tools");
    expect(() => handlers.callTool("arbitrary_tool", {})).toThrow("cannot call tools");
    expect(() => handlers.sendFollowUpMessage({ prompt: "Unauthorized" })).toThrow();
    handlers.notifyIntrinsicHeight(123);
    expect(() =>
      handlers.callTool("__codex_inline_visualization_height__", { height: 900 }),
    ).toThrow();
    handlers.notifyIntrinsicHeight(124);
    handlers.callTool("__codex_inline_visualization_height__", { height: 250, width: 700 });
    handlers.notifyIntrinsicHeight(500);
    expect(callbacks.height.mock.calls).toEqual([[123], [124], [{ height: 250, width: 700 }]]);
    handlers.callTool("__codex_inline_visualization_ready__", {});
    expect(callbacks.ready).toHaveBeenCalledOnce();
    expect(() => handlers.callTool("__codex_inline_visualization_click__", {})).toThrow();
    handlers.callTool("__codex_inline_visualization_click__", { isInteractive: true });
    handlers.requestDisplayMode({ mode: "fullscreen" });
    await handlers.openExternal({ href: "https://example.com" });
    expect(callbacks.interact).toHaveBeenCalledTimes(3);
    expect(callbacks.mode).toHaveBeenCalledWith("fullscreen");
    expect(callbacks.openExternal).toHaveBeenCalledWith("https://example.com");
  });
});
