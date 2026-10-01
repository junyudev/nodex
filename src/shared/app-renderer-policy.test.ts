import { describe, expect, test } from "vite-plus/test";
import {
  APP_RENDERER_ORIGIN,
  APP_RENDERER_URL,
  buildTopLevelRendererCsp,
} from "./app-renderer-policy";

describe("top-level renderer CSP", () => {
  test("uses the privileged packaged app origin", () => {
    expect(APP_RENDERER_ORIGIN).toBe("app://-");
    expect(APP_RENDERER_URL).toBe("app://-/index.html");
  });

  test("denies inline and JavaScript eval while allowing the bundled WASM kernel", () => {
    const csp = buildTopLevelRendererCsp({ mode: "production" });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("https://api.statsigcdn.com");
    expect(csp).toContain("https://cloudflare-dns.com");
    expect(csp).toContain("https://prodregistryv2.org");
    expect(csp).toContain("img-src 'self' app: blob: data: https:");
    expect(csp).toContain("media-src 'self' app: blob: data:");
    expect(csp).not.toContain("file:");
    expect(csp).not.toContain("nodex-asset:");
  });

  test("keeps authenticated WebSocket connections in Main", () => {
    const csp = buildTopLevelRendererCsp({ mode: "production" });
    const connections = csp
      .split("; ")
      .find((directive) => directive.startsWith("connect-src "))!
      .split(" ")
      .slice(1);
    expect(
      connections.some((source) => source.startsWith("ws:") || source.startsWith("wss:")),
    ).toBe(false);
  });

  test("limits development connections to the Vite origin", () => {
    const csp = buildTopLevelRendererCsp({ mode: "development" });
    expect(csp).toContain("http://localhost:*");
    expect(csp).toContain("ws://localhost:*");
    expect(csp).toContain("http://127.0.0.1:*");
    expect(csp).toContain("sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk=");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("connect-src *");
  });

  test("narrows development connections to the resolved local Vite origin", () => {
    const csp = buildTopLevelRendererCsp({
      mode: "development",
      developmentOrigin: "http://localhost:51285/",
    });

    expect(csp).toContain("http://localhost:51285");
    expect(csp).toContain("ws://localhost:51285");
    expect(csp).not.toContain("51284");
    expect(csp).not.toContain("localhost:*");
  });

  test("does not trust a non-local development origin", () => {
    const csp = buildTopLevelRendererCsp({
      mode: "development",
      developmentOrigin: "https://example.com:51285/",
    });

    expect(csp).not.toContain("example.com");
    expect(csp).toContain("http://localhost:*");
  });
});
