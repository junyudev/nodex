import { describe, expect, test } from "vite-plus/test";
import { allowsBrowserSessionRequest } from "./browser-session-request-policy";

const restricted = {
  enabled: true,
  domains: { "allowed.example": "allow", "denied.example": "deny" },
} as const;

describe("Browser application network policy", () => {
  test.each([
    "http://localhost:3000/",
    "file:///tmp/index.html",
    "data:text/html,Hello",
    "blob:https://example.com/id",
    "about:blank",
    "chrome://flags",
    "https://user:secret@example.com/",
  ])("leaves unmanaged requests unrestricted: %s", (url) => {
    expect(allowsBrowserSessionRequest({ url, network: null })).toBe(true);
  });
  test.each([
    "app://-/index.html",
    "nodex://assets/file.png",
    "nodex-page-file://capability/index.html",
    "nodex-mcp-sandbox://frame/index.html",
    "file:///tmp/",
    "about:srcdoc",
    "data:text/html,Hello",
    "blob:https://example.com/id",
    "http://localhost:5173/vite",
    "ws://localhost:5173/socket",
    "https://allowed.example/path",
    "wss://allowed.example./socket",
  ])("admits internal, exact development and managed domains: %s", (url) => {
    expect(
      allowsBrowserSessionRequest({
        url,
        network: restricted,
        developmentOrigin: "http://localhost:5173/app",
      }),
    ).toBe(true);
  });
  test.each([
    "http://allowed.example/",
    "ws://allowed.example/socket",
    "https://child.allowed.example/",
    "https://denied.example/",
    "http://localhost:3000/",
    "http://localhost:5174/",
    "chrome://flags",
    "invalid",
  ])("applies managed network restrictions: %s", (url) => {
    expect(
      allowsBrowserSessionRequest({
        url,
        network: restricted,
        developmentOrigin: "http://localhost:5173/app",
      }),
    ).toBe(false);
  });
});
