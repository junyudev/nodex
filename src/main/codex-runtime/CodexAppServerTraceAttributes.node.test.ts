import { describe, expect, test } from "vite-plus/test";
import { codexAppServerResponseErrorTraceAttributes } from "./CodexAppServerTraceAttributes";

describe("codexAppServerResponseErrorTraceAttributes", () => {
  test("classifies known JSON-RPC failures", () => {
    expect(
      codexAppServerResponseErrorTraceAttributes({
        code: -32001,
        message: "thread not found: abc",
      }),
    ).toEqual({
      "app_server.error_code": -32001,
      "app_server.failure_reason": "thread_not_found",
    });
    expect(
      codexAppServerResponseErrorTraceAttributes({
        code: -32603,
        message: "Connection for host ID remote-1 not found",
      }),
    ).toEqual({
      "app_server.error_code": -32603,
      "app_server.failure_reason": "remote_unavailable",
    });
  });

  test("does not tag non JSON-RPC error codes", () => {
    expect(
      codexAppServerResponseErrorTraceAttributes({ code: 500, message: "Unauthorized" }),
    ).toEqual({});
  });
});
