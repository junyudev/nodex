import { expect, test } from "vite-plus/test";
import { parseMcpAppLinkRequest } from "./mcp-app-navigation";

test.each([
  "https://example.com/",
  "nodex://pages/page-1",
  "nodex://sessions/session-1",
  "nodex://views/view-1",
])("admits guest destination %s with an explicit popup mode", (href) => {
  expect(parseMcpAppLinkRequest({ href, openMode: "popup" })).toEqual({ href, openMode: "popup" });
});
test.each([
  null,
  {},
  { href: "https://example.com", openMode: "window" },
  { href: "http://localhost:3000" },
  { href: "file:///tmp/report.html" },
  { href: "nodex://unknown/id" },
  { href: "codex://pages/id" },
  { href: "https://user:pass@example.com/" },
])("rejects malformed or unsupported guest destination %j", (value) => {
  expect(() => parseMcpAppLinkRequest(value)).toThrow();
});
