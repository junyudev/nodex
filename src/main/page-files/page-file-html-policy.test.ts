import { describe, expect, test } from "vite-plus/test";
import {
  decodePageFileHtmlPath,
  isAllowedPageFileHtmlRequest,
  pageFileHtmlMimeType,
  pageFileHtmlRequestPath,
  pageFileHtmlResponse,
  PAGE_FILE_HTML_CSP,
} from "./page-file-html-policy";

describe("Page File request policy", () => {
  test.each([
    "/",
    "/a//b",
    "/../secret",
    "/a/./b",
    "/%2e%2e/secret",
    "/a%2fb",
    "/a%5cb",
    "/a\\b",
    "/%FF",
    "/%00",
    `/${"x".repeat(256)}`,
    `/${Array.from({ length: 33 }, () => "a").join("/")}`,
  ])("rejects ambiguous or unbounded paths: %s", (path) => {
    expect(decodePageFileHtmlPath(path)).toBeNull();
  });
  test("decodes once and preserves Page-root URL resolution", () => {
    expect(decodePageFileHtmlPath("/profile/%E6%8A%A5%E5%91%8A.html")).toBe("profile/报告.html");
    expect(decodePageFileHtmlPath("/a%252fb")).toBe("a%2fb");
    expect(
      pageFileHtmlRequestPath("nodex-page-file://grant/a/../secret", "nodex-page-file://grant"),
    ).toBeNull();
    expect(new URL("trace.json", "nodex-page-file://grant/profile/report.html").pathname).toBe(
      "/profile/trace.json",
    );
  });
  test("admits only its own origin and local data/blob resources", () => {
    const origin = "nodex-page-file://grant";
    for (const url of [origin + "/trace.json", "data:image/png;base64,AA==", `blob:${origin}/id`])
      expect(isAllowedPageFileHtmlRequest(url, origin)).toBe(true);
    for (const url of [
      "https://example.com",
      "http://localhost:80",
      "ws://localhost",
      "wss://example.com",
      "file:///etc/passwd",
      "app://renderer",
      "nodex://files/id",
      "nodex-page-file://other/a",
      "nodex-page-file://user@grant/a",
      "nodex-page-file://grant:3/a",
      "blob:nodex-page-file://other/id",
    ])
      expect(isAllowedPageFileHtmlRequest(url, origin)).toBe(false);
  });
  test("sets immutable policy headers without inferring executable MIME", async () => {
    const response = pageFileHtmlResponse(
      200,
      new TextEncoder().encode("<script>1</script>"),
      pageFileHtmlMimeType("text/plain"),
    );
    expect(response.headers.get("content-security-policy")).toBe(PAGE_FILE_HTML_CSP);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(pageFileHtmlMimeType("text/plain\r\nX-Injected: yes")).toBe("application/octet-stream");
  });
});
