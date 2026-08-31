import { describe, expect, test } from "vite-plus/test";
import {
  buildCodexMcpElicitationFormModel,
  buildCodexMcpServerElicitationResponse,
  createInitialCodexMcpElicitationFormValues,
  isRenderableMcpServerElicitationRequest,
  normalizeCodexMcpServerElicitationMode,
  normalizeCodexMcpServerElicitationResponse,
  validateCodexMcpElicitationFormValues,
} from "./codex-mcp-elicitation";
import type { CodexMcpServerElicitationRequest } from "./types";

describe("isRenderableMcpServerElicitationRequest", () => {
  test("canonicalizes the legacy OpenAI form spelling at state boundaries", () => {
    expect(normalizeCodexMcpServerElicitationMode("openaiForm")).toBe("openai/form");
    expect(normalizeCodexMcpServerElicitationMode("openai/form")).toBe("openai/form");
    expect(normalizeCodexMcpServerElicitationMode("form")).toBe("form");
    expect(normalizeCodexMcpServerElicitationMode("url")).toBe("url");
  });

  test("declines invalid url-mode elicitations before they enter the request plane", () => {
    expect(
      isRenderableMcpServerElicitationRequest({
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "browser",
        mode: "url",
        _meta: null,
        message: "Open this URL?",
        url: "http://example.test",
        elicitationId: "elicitation-1",
      }),
    ).toBe(false);
  });

  test("accepts ordinary https url-mode elicitations", () => {
    expect(
      isRenderableMcpServerElicitationRequest({
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "browser",
        mode: "url",
        _meta: null,
        message: "Open this URL?",
        url: "https://example.test/path",
        elicitationId: "elicitation-1",
      }),
    ).toBe(true);
  });

  test("requires Codex Apps auth failure metadata on ChatGPT hosts", () => {
    const base = {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "codex_apps",
      mode: "url" as const,
      message: "Connect the app?",
      url: "https://chatgpt.com/connect",
      elicitationId: "elicitation-1",
    };

    expect(
      isRenderableMcpServerElicitationRequest({
        ...base,
        _meta: null,
      }),
    ).toBe(false);
    expect(
      isRenderableMcpServerElicitationRequest({
        ...base,
        _meta: {
          _codex_apps: {
            connector_auth_failure: {
              is_auth_failure: true,
              connector_id: "gmail",
              connector_name: "Gmail",
              install_url: "https://chatgpt.com/connect/gmail",
              requested_scopes: ["mail.read"],
            },
          },
        },
      }),
    ).toBe(true);
  });

  test("normalizes action-only and contentful MCP elicitation responses", () => {
    expect(JSON.stringify(normalizeCodexMcpServerElicitationResponse("decline"))).toBe(
      JSON.stringify({
        action: "decline",
        content: null,
        _meta: null,
      }),
    );
    expect(JSON.stringify(normalizeCodexMcpServerElicitationResponse("accept"))).toBe(
      JSON.stringify({
        action: "accept",
        content: {},
        _meta: null,
      }),
    );
    expect(
      JSON.stringify(
        buildCodexMcpServerElicitationResponse("accept", {
          library: "react",
        }),
      ),
    ).toBe(
      JSON.stringify({
        action: "accept",
        content: {
          library: "react",
        },
        _meta: null,
      }),
    );
    expect(
      JSON.stringify(
        buildCodexMcpServerElicitationResponse("decline", {
          ignored: true,
        }),
      ),
    ).toBe(
      JSON.stringify({
        action: "decline",
        content: null,
        _meta: null,
      }),
    );
    expect(
      JSON.stringify(
        buildCodexMcpServerElicitationResponse("cancel", {
          ignored: true,
        }),
      ),
    ).toBe(
      JSON.stringify({
        action: "cancel",
        content: null,
        _meta: null,
      }),
    );
  });

  test("builds and validates typed form elicitation content", () => {
    const request: CodexMcpServerElicitationRequest = {
      type: "mcpServerElicitation",
      requestId: "mcp-1",
      projectId: "project-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      kind: "generic",
      mode: "form",
      serverName: "Context7",
      message: "Choose docs",
      requestedSchema: {
        type: "object",
        required: ["library"],
        properties: {
          library: {
            type: "string",
            title: "Library",
            minLength: 1,
          },
          includeExamples: {
            type: "boolean",
            title: "Include examples",
            default: true,
          },
          depth: {
            type: "integer",
            title: "Depth",
            default: 2,
            minimum: 1,
            maximum: 5,
          },
          sections: {
            type: "array",
            title: "Sections",
            items: {
              type: "string",
              enum: ["api", "guides"],
            },
            default: ["api"],
          },
        },
      },
      createdAt: 1,
    };

    const model = buildCodexMcpElicitationFormModel(request);
    expect(model?.kind).toBe("supported");
    if (model?.kind !== "supported") throw new Error("expected supported form model");

    const initial = createInitialCodexMcpElicitationFormValues(model.fields);
    expect(JSON.stringify(initial)).toBe(
      JSON.stringify({
        library: "",
        includeExamples: true,
        depth: "2",
        sections: ["api"],
      }),
    );

    const invalid = validateCodexMcpElicitationFormValues(model.fields, initial);
    expect(JSON.stringify(invalid.invalidFieldNames)).toBe(JSON.stringify(["library"]));
    expect(invalid.content).toBe(null);

    const valid = validateCodexMcpElicitationFormValues(model.fields, {
      ...initial,
      library: "react",
      depth: "3",
      sections: ["guides"],
    });
    expect(JSON.stringify(valid.content)).toBe(
      JSON.stringify({
        library: "react",
        includeExamples: true,
        depth: 3,
        sections: ["guides"],
      }),
    );
  });

  test("marks unsupported OpenAI forms instead of pretending JSON is approvable content", () => {
    const model = buildCodexMcpElicitationFormModel({
      type: "mcpServerElicitation",
      requestId: "mcp-1",
      projectId: "project-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      kind: "generic",
      mode: "openai/form",
      serverName: "Context7",
      message: "Unsupported",
      requestedSchema: {
        type: "object",
        properties: {
          nested: {
            type: "object",
          },
        },
      },
      createdAt: 1,
    });

    expect(model?.kind).toBe("unsupported");
  });
});
