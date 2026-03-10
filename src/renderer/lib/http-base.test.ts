import { describe, expect, test } from "bun:test";

import { resolveHttpBase, toApiUrl } from "./http-base";

describe("http base resolver", () => {
  test("falls back to default when no window-like object is provided", () => {
    expect(resolveHttpBase(undefined)).toBe("http://localhost:51283");
  });

  test("uses browser origin in non-electron HTTP contexts", () => {
    expect(
      resolveHttpBase({
        location: {
          protocol: "https:",
          origin: "https://nodex.example.com",
        },
      }),
    ).toBe("https://nodex.example.com");
  });

  test("keeps Vite browser dev mode pointed at default API port", () => {
    expect(
      resolveHttpBase({
        location: {
          protocol: "http:",
          origin: "http://localhost:51284",
        },
      }),
    ).toBe("http://localhost:51283");
  });

  test("uses injected electron server URL when present", () => {
    expect(
      resolveHttpBase({
        api: {
          serverUrl: "http://127.0.0.1:61234/",
        },
      }),
    ).toBe("http://127.0.0.1:61234");
  });

  test("keeps electron fallback on default when server URL is missing", () => {
    expect(
      resolveHttpBase({
        api: {},
        location: {
          protocol: "http:",
          origin: "http://localhost:51284",
        },
      }),
    ).toBe("http://localhost:51283");
  });

  test("builds API URLs from resolved base", () => {
    expect(
      toApiUrl("api/projects", {
        location: {
          protocol: "http:",
          origin: "http://localhost:7000",
        },
      }),
    ).toBe("http://localhost:7000/api/projects");
  });
});
