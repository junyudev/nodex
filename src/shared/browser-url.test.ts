import { describe, expect, test } from "vite-plus/test";
import { isBlankBrowserUrl, resolveBrowserTabTitle } from "./browser-url";

describe("Browser tab labels", () => {
  test("distinguishes blank tabs from untitled pages", () => {
    expect(isBlankBrowserUrl("about:blank")).toBe(true);
    expect(resolveBrowserTabTitle("about:blank", "Ignored")).toBe("New tab");
    expect(resolveBrowserTabTitle("file:///tmp/index.html", "")).toBe("Browser");
    expect(resolveBrowserTabTitle("data:text/html,Hello", "Hello")).toBe("Hello");
  });
});
