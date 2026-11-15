import { describe, expect, test } from "vite-plus/test";
import {
  isBlankBrowserUrl,
  resolveBrowserTabTitle,
  resolveLiveBrowserTabTitle,
} from "./browser-url";

describe("Browser tab labels", () => {
  test("distinguishes blank tabs from untitled pages", () => {
    expect(isBlankBrowserUrl("about:blank")).toBe(true);
    expect(resolveBrowserTabTitle("about:blank", "Ignored")).toBe("New tab");
    expect(resolveBrowserTabTitle("file:///tmp/index.html", "")).toBe("Browser");
    expect(resolveBrowserTabTitle("data:text/html,Hello", "Hello")).toBe("Hello");
  });

  test("a live page names its tab; a tab without one keeps its stored title", () => {
    const stored = "Browser";
    expect(resolveLiveBrowserTabTitle(undefined, stored)).toBe(stored);
    expect(
      resolveLiveBrowserTabTitle({ url: "https://example.com/", title: "Example" }, stored),
    ).toBe("Example");
    expect(resolveLiveBrowserTabTitle({ url: "about:blank", title: "Example" }, stored)).toBe(
      "New tab",
    );
  });
});
