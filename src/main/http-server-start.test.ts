import { describe, expect, test } from "bun:test";
import { getHttpServerOptions } from "./http-server";

describe("http server startup options", () => {
  test("binds to loopback host", () => {
    const options = getHttpServerOptions(51283);

    expect(options.port).toBe(51283);
    expect(options.hostname).toBe("127.0.0.1");
    expect(typeof options.fetch).toBe("function");
  });

  test("emits CORS headers for trusted local dev origins only", async () => {
    const options = getHttpServerOptions(51283);
    const trustedResponse = await options.fetch(
      new Request("http://127.0.0.1:51283/api/not-found", {
        headers: {
          Origin: "http://localhost:51284",
        },
      }),
    );
    const untrustedResponse = await options.fetch(
      new Request("http://127.0.0.1:51283/api/not-found", {
        headers: {
          Origin: "https://evil.example",
        },
      }),
    );

    expect(trustedResponse.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:51284");
    expect(untrustedResponse.headers.get("Access-Control-Allow-Origin")).toBe(null);
  });

  test("rejects mutating requests from untrusted browser origins", async () => {
    const options = getHttpServerOptions(51283);
    const blocked = await options.fetch(
      new Request("http://127.0.0.1:51283/api/not-found", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
        },
      }),
    );

    expect(blocked.status).toBe(403);
    const payload = await blocked.json() as { error?: string };
    expect(payload.error).toBe("Forbidden origin");
  });

  test("allows mutating requests from trusted local dev origins", async () => {
    const options = getHttpServerOptions(51283);
    const allowed = await options.fetch(
      new Request("http://127.0.0.1:51283/api/not-found", {
        method: "POST",
        headers: {
          Origin: "http://localhost:51284",
        },
      }),
    );

    expect(allowed.status).toBe(404);
  });
});
