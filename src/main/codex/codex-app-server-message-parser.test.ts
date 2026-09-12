import { describe, expect, it } from "vite-plus/test";
import {
  generatedStringDiscriminatorValues,
  parseCodexAppServerMessage,
} from "./codex-app-server-message-parser";

describe("Codex app-server message parser", () => {
  it("preserves a valid generated notification as a discriminated object", () => {
    const result = parseCodexAppServerMessage({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: null,
        plan: [{ step: "Implement", status: "inProgress" }],
      },
    });

    expect(result).toEqual({
      success: true,
      data: {
        kind: "notification",
        notification: {
          method: "turn/plan/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            explanation: null,
            plan: [{ step: "Implement", status: "inProgress" }],
          },
        },
      },
    });
  });

  it("rejects known notifications and requests with mismatched params", () => {
    expect(
      parseCodexAppServerMessage({
        method: "turn/plan/updated",
        params: { threadId: "thread-1" },
      }),
    ).toEqual({
      success: false,
      error: "Invalid params for Codex server notification 'turn/plan/updated'.",
    });

    expect(
      parseCodexAppServerMessage({
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1" },
      }),
    ).toEqual({
      success: false,
      error: "Invalid params for Codex server request 'item/commandExecution/requestApproval'.",
    });
  });

  it("validates explicit private requests separately", () => {
    const valid = parseCodexAppServerMessage({
      id: "private-1",
      method: "item/tool/requestOptionPicker",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        question: "Choose",
        options: [{ label: "A" }],
      },
    });
    expect(valid.success && valid.data.kind).toBe("request");

    expect(
      parseCodexAppServerMessage({
        id: "private-2",
        method: "item/tool/requestOptionPicker",
        params: { threadId: "thread-1" },
      }),
    ).toEqual({
      success: false,
      error: "Invalid params for Codex server request 'item/tool/requestOptionPicker'.",
    });

    const userVerification = parseCodexAppServerMessage({
      id: "private-mcp-1",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "browser-use",
        mode: "openai/userVerification",
        _meta: { verificationUrl: "https://example.com" },
      },
    });
    expect(userVerification).toEqual({
      success: true,
      data: {
        kind: "request",
        request: {
          id: "private-mcp-1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            serverName: "browser-use",
            mode: "openai/userVerification",
            _meta: { verificationUrl: "https://example.com" },
          },
        },
      },
    });
  });

  it("classifies unknown server requests so the client can send method-not-found", () => {
    expect(
      parseCodexAppServerMessage({
        id: 99,
        method: "future/request",
        params: { value: true },
      }),
    ).toEqual({
      success: true,
      data: {
        kind: "unknownRequest",
        request: { id: 99, method: "future/request", params: { value: true } },
      },
    });
  });

  it("requires exactly one response payload", () => {
    expect(parseCodexAppServerMessage({ id: 1, result: { ok: true } }).success).toBe(true);
    expect(
      parseCodexAppServerMessage({
        id: 2,
        error: { code: -32000, message: "no" },
      }).success,
    ).toBe(true);
    expect(parseCodexAppServerMessage({ id: 3 })).toEqual({
      success: false,
      error: "Invalid JSON-RPC envelope from codex app-server.",
    });
    expect(
      parseCodexAppServerMessage({
        id: 4,
        result: {},
        error: { code: -32000, message: "ambiguous" },
      }),
    ).toEqual({
      success: false,
      error: "Codex JSON-RPC response must contain exactly one of result or error.",
    });
  });

  it("collects generated discriminator enums without a handwritten method list", () => {
    expect(
      generatedStringDiscriminatorValues(
        {
          anyOf: [
            { properties: { method: { enum: ["one"] } } },
            { properties: { method: { const: "two" } } },
          ],
        },
        "method",
      ),
    ).toEqual(new Set(["one", "two"]));
  });
});
