import { describe, expect, test, vi } from "vitest";
import type { CodexHttpFetchRequest, CodexHttpFetchResult } from "../../shared/codex-http-fetch";
import type { CodexHttpFetchPort } from "./codex-http-fetch";
import { CodexHttpFetchError, fetchCodexHttp } from "./codex-http-fetch";

describe("fetchCodexHttp", () => {
  test("reconstructs successful native HTTP responses", async () => {
    const fetchMock = vi.fn(
      async (request: CodexHttpFetchRequest): Promise<CodexHttpFetchResult> => ({
        responseType: "success",
        requestId: request.requestId,
        status: 201,
        statusText: "Created",
        headers: { "content-type": "text/plain", "x-test": "yes" },
        body: new TextEncoder().encode("created"),
      }),
    );
    const cancelMock = vi.fn(async (_requestId: string) => {});
    const port: CodexHttpFetchPort = {
      fetch: fetchMock,
      cancel: cancelMock,
    };

    const response = await fetchCodexHttp(
      "https://example.test/resource",
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "payload",
        keepalive: true,
      },
      port,
    );

    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-test")).toBe("yes");
    await expect(response.text()).resolves.toBe("created");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0];
    expect(request?.url).toBe("https://example.test/resource");
    expect(request?.method).toBe("POST");
    expect(request?.body).toBe("payload");
    expect(request?.keepalive).toBe(true);
  });

  test.each([204, 205, 304])(
    "reconstructs bodyless HTTP status %i without a Response constructor error",
    async (status) => {
      const port: CodexHttpFetchPort = {
        fetch: async (request) => ({
          responseType: "success",
          requestId: request.requestId,
          status,
          statusText: "",
          headers: {},
          body: new Uint8Array(),
        }),
        cancel: async () => {},
      };

      const response = await fetchCodexHttp("https://example.test/bodyless", {}, port);

      expect(response.status).toBe(status);
      await expect(response.text()).resolves.toBe("");
    },
  );

  test("raises native HTTP failures with their service status", async () => {
    const fetchMock = vi.fn(
      async (request: CodexHttpFetchRequest): Promise<CodexHttpFetchResult> => ({
        responseType: "error",
        requestId: request.requestId,
        status: 503,
        error: "service unavailable",
        errorCode: "upstream_unavailable",
        responseStatus: 503,
        errorKind: "network",
      }),
    );
    const port: CodexHttpFetchPort = {
      fetch: fetchMock,
      cancel: async () => {},
    };

    const error = await fetchCodexHttp("https://example.test", {}, port).catch((cause) => cause);
    expect(error).toBeInstanceOf(CodexHttpFetchError);
    expect(error).toMatchObject({
      message: "service unavailable",
      status: 503,
      errorCode: "upstream_unavailable",
      responseStatus: 503,
      errorKind: "network",
    });
  });

  test("cancels the matching native request when its AbortSignal fires", async () => {
    const fetchMock = vi.fn(
      (request: CodexHttpFetchRequest): Promise<CodexHttpFetchResult> =>
        new Promise((resolve) => {
          void resolve;
          void request;
        }),
    );
    const cancelMock = vi.fn(async (_requestId: string) => {});
    const port: CodexHttpFetchPort = {
      fetch: fetchMock,
      cancel: cancelMock,
    };
    const controller = new AbortController();
    const pending = fetchCodexHttp(
      "https://example.test/slow",
      { signal: controller.signal },
      port,
    );
    await Promise.resolve();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });
    expect(cancelMock).toHaveBeenCalledTimes(1);
    const requestId = fetchMock.mock.calls[0]?.[0].requestId;
    expect(cancelMock).toHaveBeenCalledWith(requestId);
  });
});
