import { request as httpRequest } from "node:http";
import { zstdCompressSync } from "node:zlib";
import { WebSocket } from "ws";

import { describe, expect, test } from "vite-plus/test";

import {
  responses,
  ScriptedModelRequest,
  ScriptedModelServer,
  scriptedModelResponse,
  withScriptedModelServer,
} from "./scripted-model-server";

const postJson = async (
  url: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly body: string; readonly status: number }> => {
  const target = new URL(url);
  const encoded =
    headers["content-encoding"] === "zstd"
      ? zstdCompressSync(Buffer.from(JSON.stringify(body)))
      : Buffer.from(JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      target,
      {
        method: "POST",
        headers: {
          "content-length": String(encoded.byteLength),
          "content-type": "application/json",
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(encoded);
  });
};

const sendWebSocketRequest = async (
  webSocket: WebSocket,
  body: unknown,
): Promise<readonly Record<string, unknown>[]> =>
  await new Promise((resolve, reject) => {
    const expectedStreamId =
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      typeof (body as Record<string, unknown>).stream_id === "string"
        ? (body as Record<string, unknown>).stream_id
        : null;
    const events: Record<string, unknown>[] = [];
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: Buffer): void => {
      const parsed: unknown = JSON.parse(data.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      const event = parsed as Record<string, unknown>;
      if (expectedStreamId !== null && event.stream_id !== expectedStreamId) return;
      events.push(event);
      if (event.type !== "response.completed") return;
      cleanup();
      resolve(events);
    };
    const cleanup = (): void => {
      webSocket.off("error", onError);
      webSocket.off("message", onMessage);
    };
    webSocket.on("error", onError);
    webSocket.on("message", onMessage);
    webSocket.send(JSON.stringify(body));
  });

const openWebSocket = async (url: string): Promise<WebSocket> =>
  await new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url);
    webSocket.once("open", () => resolve(webSocket));
    webSocket.once("error", reject);
  });

describe("ScriptedModelServer", () => {
  test("distinguishes WebSocket prewarming from model generation", () => {
    const prewarm = new ScriptedModelRequest({
      body: { generate: false, model: "mock-model" },
      headers: {},
      method: "WEBSOCKET",
      path: "/v1/responses",
    });
    const generation = new ScriptedModelRequest({
      body: { model: "mock-model" },
      headers: {},
      method: "WEBSOCKET",
      path: "/v1/responses",
    });

    expect(prewarm.isGenerationRequest()).toBe(false);
    expect(generation.isGenerationRequest()).toBe(true);
  });

  test("matches concurrent semantic exchanges and captures tool outputs", async () => {
    await withScriptedModelServer(
      {
        exchanges: [
          {
            name: "alpha tool output",
            match: (request) => request.hasFunctionCallOutput("call-alpha"),
            respond: responses.stream([
              responses.created("resp-alpha"),
              responses.assistantMessage("message-alpha", "alpha complete"),
              responses.completed("resp-alpha"),
            ]),
          },
          {
            name: "beta prompt",
            match: (request) => request.hasInputText("beta prompt"),
            respond: async () =>
              responses.stream([
                responses.created("resp-beta"),
                responses.functionCall("call-beta", "exec_command", { cmd: "pwd" }),
                responses.completed("resp-beta"),
              ]),
          },
        ],
      },
      async (server) => {
        const observedBeta = server.waitForRequest((request) =>
          request.hasInputText("beta prompt"),
        );
        const beta = await postJson(`${server.baseUrl}/v1/responses`, {
          input: [{ type: "message", role: "user", content: "beta prompt" }],
        });
        expect(beta.status).toBe(200);
        expect(beta.body).toContain('"call_id":"call-beta"');
        expect((await observedBeta).path).toBe("/v1/responses");

        const alpha = await postJson(`${server.baseUrl}/v1/responses`, {
          input: [
            {
              type: "function_call_output",
              call_id: "call-alpha",
              output: "done",
            },
          ],
        });
        expect(alpha.status).toBe(200);
        expect(server.requests()).toHaveLength(2);
        expect(server.requests()[1]?.functionCallOutput("call-alpha")).toMatchObject({
          output: "done",
        });
        expect(server.providerConfig("mock")).toMatchObject({
          base_url: `${server.baseUrl}/v1`,
          request_max_retries: 0,
          stream_max_retries: 0,
          wire_api: "responses",
        });
      },
    );
  });

  test("resolves exact nested and flattened tool invocation addresses", () => {
    const nestedRequest = new ScriptedModelRequest({
      body: {
        tools: [
          {
            type: "namespace",
            name: "mcp__node_repl__",
            tools: [{ type: "function", name: "js" }],
          },
        ],
      },
      headers: {},
      method: "POST",
      path: "/v1/responses",
    });
    const flattenedRequest = new ScriptedModelRequest({
      body: { tools: [{ type: "function", name: "mcp__node_repl__js" }] },
      headers: {},
      method: "POST",
      path: "/v1/responses",
    });

    expect(nestedRequest.toolInvocation("mcp__node_repl__", "js")).toEqual({
      name: "js",
      namespace: "mcp__node_repl__",
    });
    expect(flattenedRequest.toolInvocation("mcp__node_repl__", "js")).toEqual({
      name: "mcp__node_repl__js",
    });

    const discoveredRequest = new ScriptedModelRequest({
      body: {
        input: [
          {
            type: "tool_search_output",
            call_id: "search-browser",
            status: "completed",
            execution: "client",
            tools: [
              {
                type: "namespace",
                name: "mcp__node_repl__",
                tools: [{ type: "function", name: "js" }],
              },
            ],
          },
        ],
        tools: [{ type: "tool_search" }],
      },
      headers: {},
      method: "POST",
      path: "/v1/responses",
    });
    expect(discoveredRequest.hasToolType("tool_search")).toBe(true);
    expect(discoveredRequest.toolSearchOutput("search-browser")).toMatchObject({
      status: "completed",
    });
    expect(discoveredRequest.toolInvocation("mcp__node_repl__", "js")).toEqual({
      name: "js",
      namespace: "mcp__node_repl__",
    });

    const liteRequest = new ScriptedModelRequest({
      body: {
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [
              {
                type: "namespace",
                name: "collaboration",
                tools: [{ type: "function", name: "spawn_agent" }],
              },
            ],
          },
        ],
      },
      headers: {},
      method: "POST",
      path: "/v1/responses",
    });
    expect(liteRequest.hasToolType("namespace")).toBe(true);
    expect(liteRequest.toolInvocation("collaboration", "spawn_agent")).toEqual({
      name: "spawn_agent",
      namespace: "collaboration",
    });
  });

  test("distinguishes subagent instructions from root user input and tool arguments", () => {
    const child = new ScriptedModelRequest({
      body: {
        client_metadata: { "x-openai-subagent": "collab_spawn" },
        instructions: "Complete CHILD_PROMPT",
        input: [
          { type: "message", role: "user", content: "parent context" },
          {
            type: "function_call",
            call_id: "spawn",
            name: "spawn_agent",
            arguments: JSON.stringify({ message: "CHILD_PROMPT" }),
          },
        ],
      },
      headers: {},
      method: "POST",
      path: "/v1/responses",
    });

    expect(child.isSubagentRequest()).toBe(true);
    expect(child.hasInstructionsText("CHILD_PROMPT")).toBe(true);
    expect(child.hasUserInputText("CHILD_PROMPT")).toBe(false);
  });

  test("renders namespaced custom tool calls for code-mode execution", () => {
    expect(responses.customToolCall("call-exec", "exec", "text('ok')", "functions")).toEqual({
      type: "response.output_item.done",
      item: {
        type: "custom_tool_call",
        call_id: "call-exec",
        name: "exec",
        input: "text('ok')",
        namespace: "functions",
      },
    });
  });

  test("decodes zstd requests and supports bounded repeating exchanges", async () => {
    await withScriptedModelServer(
      {
        exchanges: [
          {
            name: "compressed requests",
            expectedCalls: 2,
            maximumCalls: 3,
            match: (request) => request.hasInputText("compressed"),
            respond: scriptedModelResponse.http({ status: 200, body: { ok: true } }),
          },
        ],
      },
      async (server) => {
        const first = await postJson(
          `${server.baseUrl}/v1/responses`,
          { input: ["compressed one"] },
          { "content-encoding": "zstd" },
        );
        const second = await postJson(
          `${server.baseUrl}/v1/responses`,
          { input: ["compressed two"] },
          { "content-encoding": "zstd" },
        );
        expect([first.status, second.status]).toEqual([200, 200]);
      },
    );
  });

  test("supports reusable Responses WebSockets and automatic startup prewarm", async () => {
    await withScriptedModelServer(
      {
        exchanges: [
          {
            name: "websocket prompt",
            match: (request) => request.hasInputText("websocket prompt"),
            respond: responses.stream([
              responses.created("response-websocket"),
              responses.assistantMessage("message-websocket", "websocket complete"),
              responses.completed("response-websocket"),
            ]),
          },
        ],
      },
      async (server) => {
        const webSocket = await openWebSocket(
          `${server.baseUrl.replace(/^http/u, "ws")}/v1/responses`,
        );
        try {
          const warmup = await sendWebSocketRequest(webSocket, {
            type: "response.create",
            generate: false,
            input: [],
            tools: [
              {
                type: "namespace",
                name: "functions",
                tools: [{ type: "custom", name: "exec" }],
              },
            ],
          });
          expect(warmup.map((event) => event.type)).toEqual([
            "response.created",
            "response.completed",
          ]);
          expect(webSocket.readyState).toBe(WebSocket.OPEN);
          const warmupResponse = warmup[0]?.response;
          if (
            typeof warmupResponse !== "object" ||
            warmupResponse === null ||
            Array.isArray(warmupResponse) ||
            typeof warmupResponse.id !== "string"
          ) {
            throw new Error("Automatic prewarm did not return a response id");
          }

          const response = await sendWebSocketRequest(webSocket, {
            type: "response.create",
            previous_response_id: warmupResponse.id,
            input: [{ type: "message", role: "user", content: "websocket prompt" }],
          });
          expect(response.map((event) => event.type)).toEqual([
            "response.created",
            "response.output_item.done",
            "response.completed",
          ]);
          expect(server.requests().map((request) => request.method)).toEqual([
            "WEBSOCKET",
            "WEBSOCKET",
          ]);
          expect(server.requests()[1]?.toolInvocation("functions", "exec")).toEqual({
            name: "exec",
            namespace: "functions",
          });
          expect(server.requests()[1]?.diagnosticSummary()).toContain(
            '"toolsInheritedFromPreviousResponse":true',
          );
          expect(server.transcript()).toContain("automatic websocket prewarm");
          expect(server.loopbackEnvironment({ NO_PROXY: "example.test" })).toMatchObject({
            NO_PROXY: "example.test,127.0.0.1,localhost",
            no_proxy: "127.0.0.1,localhost",
          });
        } finally {
          webSocket.close();
        }
      },
    );
  });

  test("runs different WebSocket stream lanes concurrently while preserving stream identity", async () => {
    let releaseAlpha: () => void = () => undefined;
    const alphaGate = new Promise<void>((resolve) => {
      releaseAlpha = resolve;
    });
    await withScriptedModelServer(
      {
        exchanges: [
          {
            name: "gated alpha lane",
            match: (request) => request.hasInputText("alpha lane"),
            respond: async () => {
              await alphaGate;
              return responses.stream([
                responses.created("response-alpha"),
                responses.assistantMessage("message-alpha", "alpha complete"),
                responses.completed("response-alpha"),
              ]);
            },
          },
          {
            name: "independent beta lane",
            match: (request) => request.hasInputText("beta lane"),
            respond: responses.stream([
              responses.created("response-beta"),
              responses.assistantMessage("message-beta", "beta complete"),
              responses.completed("response-beta"),
            ]),
          },
        ],
      },
      async (server) => {
        const webSocket = await openWebSocket(
          `${server.baseUrl.replace(/^http/u, "ws")}/v1/responses`,
        );
        try {
          const alpha = sendWebSocketRequest(webSocket, {
            type: "response.create",
            stream_id: "alpha",
            input: [{ type: "message", role: "user", content: "alpha lane" }],
          });
          await server.waitForRequest((request) => request.hasInputText("alpha lane"));
          const beta = await sendWebSocketRequest(webSocket, {
            type: "response.create",
            stream_id: "beta",
            input: [{ type: "message", role: "user", content: "beta lane" }],
          });
          expect(beta.every((event) => event.stream_id === "beta")).toBe(true);
          releaseAlpha();
          expect((await alpha).every((event) => event.stream_id === "alpha")).toBe(true);
        } finally {
          releaseAlpha();
          webSocket.close();
        }
      },
    );
  });

  test("reports unexpected requests and unused exchanges with a bounded transcript", async () => {
    const server = await ScriptedModelServer.start({
      exchanges: [
        {
          name: "required request",
          match: (request) => request.hasInputText("required-marker"),
          respond: scriptedModelResponse.http({ status: 200, body: { ok: true } }),
        },
      ],
      maximumTranscriptCharacters: 2_000,
    });
    try {
      const response = await postJson(`${server.baseUrl}/v1/responses`, {
        input: ["unexpected"],
      });
      expect(response.status).toBe(500);
      expect(() => server.verify()).toThrow(/Unexpected model request.*required request/su);
      expect(server.transcript().length).toBeLessThanOrEqual(2_000);
    } finally {
      await server.close();
    }
  });
});
