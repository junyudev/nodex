// The harness asserts raw JSON-RPC wire strings, mirroring the bridge's
// schema-free passthrough.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import * as NodeStream from "node:stream";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { desktopFixtureResult, startDesktopMcpFixture } from "./AcpMcpStdioBridge.testkit.ts";
import { AcpMcpBridgeError, callAcpMcpTool, runAcpMcpStdioBridge } from "./AcpMcpStdioBridge.ts";

function makeHarness(responder: (request: Request) => Promise<Response> | Response) {
  const input = new NodeStream.PassThrough();
  const written: Array<string> = [];
  const requests: Array<{ readonly headers: Headers; readonly body: string }> = [];
  const bridge = runAcpMcpStdioBridge({
    endpoint: "http://127.0.0.1:1/mcp",
    authorization: "Bearer bridge-test",
    input,
    output: {
      write: (chunk: string) => {
        written.push(chunk);
      },
    },
    fetchImplementation: async (_url, init) => {
      const request = new Request("http://127.0.0.1:1/mcp", init);
      requests.push({ headers: request.headers, body: String(init?.body ?? "") });
      return responder(request);
    },
  });
  return { input, written, requests, bridge };
}

describe("AcpMcpStdioBridge", () => {
  it.effect("preserves the original transport failure as the typed error cause", () =>
    Effect.gen(function* () {
      const source = new Error("fetch failed");
      const failure = yield* callAcpMcpTool({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        tool: "orchestrator_capabilities",
        arguments: {},
        fetchImplementation: () => Promise.reject(source),
      }).pipe(Effect.asVoid, Effect.flip);

      expect(failure).toBeInstanceOf(AcpMcpBridgeError);
      expect(failure.cause).toBe(source);
    }),
  );

  it.effect("calls one tool through a fresh authenticated MCP session", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly body: unknown; readonly headers: Headers }> = [];
      const result = yield* callAcpMcpTool({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        tool: "orchestrator_capabilities",
        arguments: {},
        fetchImplementation: async (_url, init) => {
          const headers = new Headers(init?.headers);
          const body: unknown = JSON.parse(String(init?.body ?? "{}"));
          requests.push({ body, headers });
          const request = body as { readonly id?: unknown; readonly method?: unknown };
          if (request.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result:
                request.method === "initialize"
                  ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} }
                  : { structuredContent: { providers: ["codex"] } },
            }),
            {
              headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
            },
          );
        },
      });

      expect(result).toEqual({ structuredContent: { providers: ["codex"] } });
      expect(requests).toHaveLength(3);
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
      expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
      expect(requests[2]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(requests[2]?.body).toMatchObject({
        method: "tools/call",
        params: { name: "orchestrator_capabilities", arguments: {} },
      });
    }),
  );

  it.effect("forwards requests and replays the session id and protocol version", () =>
    Effect.gen(function* () {
      const { input, written, requests, bridge } = makeHarness((request) => {
        const body = JSON.parse(String(requests.at(-1)?.body ?? "{}")) as { id?: number };
        void request;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: body.id === 1 ? { protocolVersion: "2025-06-18" } : { ok: true },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
          },
        );
      });
      const fiber = yield* Effect.forkChild(bridge);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      yield* Effect.promise(() => vi.waitFor(() => expect(written).toHaveLength(2)));
      input.end();
      yield* Fiber.join(fiber);

      expect(written).toHaveLength(2);
      expect(JSON.parse(written[0]!)).toMatchObject({ id: 1 });
      expect(JSON.parse(written[1]!)).toMatchObject({ id: 2, result: { ok: true } });
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
      expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
      expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    }),
  );

  it.effect("acknowledges notifications silently and synthesizes errors for failed requests", () =>
    Effect.gen(function* () {
      let call = 0;
      const { input, written, bridge } = makeHarness(() => {
        call += 1;
        return call === 1
          ? new Response(null, { status: 202 })
          : new Response("upstream broke", { status: 500 });
      });
      const fiber = yield* Effect.forkChild(bridge);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
      yield* Effect.promise(() => vi.waitFor(() => expect(written).toHaveLength(1)));
      input.end();
      yield* Fiber.join(fiber);

      expect(written).toHaveLength(1);
      expect(JSON.parse(written[0]!)).toMatchObject({
        id: 3,
        error: { code: -32603 },
      });
    }),
  );

  it.effect("emits parse errors for malformed JSON-RPC input", () =>
    Effect.gen(function* () {
      const { input, written, requests, bridge } = makeHarness(
        () => new Response(null, { status: 202 }),
      );
      const fiber = yield* Effect.forkChild(bridge);

      input.end("{not-json}\n");
      yield* Fiber.join(fiber);

      expect(requests).toHaveLength(0);
      expect(JSON.parse(written[0]!)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }),
  );

  it.effect("forwards SSE messages before the HTTP response closes", () =>
    Effect.gen(function* () {
      let resolveResponseController!: (
        controller: ReadableStreamDefaultController<Uint8Array>,
      ) => void;
      const responseControllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>(
        (resolve) => {
          resolveResponseController = resolve;
        },
      );
      let firstWrite: (() => void) | undefined;
      const firstWritten = new Promise<void>((resolve) => {
        firstWrite = resolve;
      });
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: {
            write: (chunk) => {
              written.push(chunk);
              firstWrite?.();
            },
          },
          fetchImplementation: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => {
                  resolveResponseController(controller);
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      const responseController = yield* Effect.promise(() => responseControllerReady);
      responseController.enqueue(
        new TextEncoder().encode(
          'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
        ),
      );
      yield* Effect.promise(() => firstWritten);
      expect(JSON.parse(written[0]!)).toMatchObject({ method: "notifications/progress" });

      responseController.enqueue(
        new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
      );
      responseController.close();
      yield* Effect.promise(() => vi.waitFor(() => expect(written).toHaveLength(2)));
      input.end();
      yield* Fiber.join(fiber);
      expect(written).toHaveLength(2);
    }),
  );

  it.effect("forwards client responses while an SSE request is still open", () =>
    Effect.gen(function* () {
      let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let serverRequestWritten: (() => void) | undefined;
      const serverRequestReachedClient = new Promise<void>((resolve) => {
        serverRequestWritten = resolve;
      });
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: {
            write: (chunk) => {
              written.push(chunk);
              if (JSON.parse(chunk).id === "server-request-1") serverRequestWritten?.();
            },
          },
          fetchImplementation: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              readonly id?: unknown;
              readonly method?: unknown;
              readonly result?: unknown;
            };
            if (body.method === "tools/call") {
              return new Response(
                new ReadableStream<Uint8Array>({
                  start: (controller) => {
                    responseController = controller;
                    controller.enqueue(
                      new TextEncoder().encode(
                        'data: {"jsonrpc":"2.0","id":"server-request-1","method":"elicitation/create","params":{}}\n\n',
                      ),
                    );
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            expect(body).toMatchObject({ id: "server-request-1", result: { action: "accept" } });
            responseController?.enqueue(
              new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
            );
            responseController?.close();
            return new Response(null, { status: 202 });
          },
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      yield* Effect.promise(() => serverRequestReachedClient);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: "server-request-1", result: { action: "accept" } })}\n`,
      );
      yield* Effect.promise(() => vi.waitFor(() => expect(written).toHaveLength(2)));
      input.end();
      yield* Fiber.join(fiber);

      expect(written.map((line) => JSON.parse(line).id)).toEqual(["server-request-1", 7]);
    }),
  );

  it.effect("forwards cancellation while a tool SSE response is still open", () =>
    Effect.gen(function* () {
      let resolveResponseController!: (
        controller: ReadableStreamDefaultController<Uint8Array>,
      ) => void;
      const responseControllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>(
        (resolve) => {
          resolveResponseController = resolve;
        },
      );
      const methods: Array<string> = [];
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: { write: (chunk) => written.push(chunk) },
          fetchImplementation: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              readonly method?: string;
            };
            methods.push(body.method ?? "");
            if (body.method === "tools/call") {
              return new Response(
                new ReadableStream<Uint8Array>({
                  start: resolveResponseController,
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            const controller = await responseControllerReady;
            controller.enqueue(
              new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
            );
            controller.close();
            return new Response(null, { status: 202 });
          },
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      yield* Effect.promise(() => responseControllerReady);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })}\n`,
      );
      yield* Effect.promise(() => vi.waitFor(() => expect(written).toHaveLength(1)));
      input.end();
      yield* Fiber.join(fiber);

      expect(methods).toEqual(["tools/call", "notifications/cancelled"]);
      expect(JSON.parse(written[0]!)).toMatchObject({ id: 7, result: {} });
    }),
  );
});

const cliEntry = fileURLToPath(new URL("../nodex/entry.ts", import.meta.url));
const fixtureAuthorization = "Bearer desktop-fixture";
const desktopCall = { code: "console.log(42)", title: "Fixture", timeout_ms: 1_000 };

it.live.each(["stdin EOF", "SIGKILL"])("closes the Desktop HTTP socket on %s", (exit) =>
  Effect.gen(function* () {
    const fixture = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startDesktopMcpFixture({
          authorization: () => fixtureAuthorization,
          block: true,
        }),
      ),
      (fixture) => Effect.promise(fixture.close),
    );
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [cliEntry, "acp-mcp-bridge"], {
          env: {
            NODEX_ACP_MCP_ENDPOINT: fixture.endpoint,
            NODEX_ACP_MCP_AUTHORIZATION: fixtureAuthorization,
          },
        }),
      ),
      (child) =>
        Effect.sync(() => {
          child.kill("SIGKILL");
        }),
    );
    const exited = once(child, "exit");
    const progress = once(child.stdout, "data");
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "js", arguments: desktopCall, _meta: { progressToken: "socket-test" } },
      }) + "\n",
    );
    expect(yield* Effect.promise(() => fixture.callStarted)).toEqual(desktopCall);
    const [notification] = yield* Effect.promise(() => progress);
    expect(JSON.parse(String(notification))).toMatchObject({
      method: "notifications/progress",
      params: { progressToken: "socket-test", progress: 1 },
    });
    if (exit === "stdin EOF") child.stdin.end();
    else child.kill("SIGKILL");
    yield* Effect.promise(() => fixture.callClosed);
    expect(yield* Effect.promise(() => exited)).toEqual(
      exit === "stdin EOF" ? [0, null] : [null, "SIGKILL"],
    );
  }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
);

it.live.each(["default", "nodex_app", "node_repl"] as const)(
  "calls the intended terminal endpoint with selector %s",
  (server) =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() => startDesktopMcpFixture({ authorization: () => fixtureAuthorization })),
        (fixture) => Effect.promise(fixture.close),
      );
      const selector = server === "default" ? [] : ["--server", server];
      const unusedEndpoint = "http://127.0.0.1:1/mcp";
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spawn(
            process.execPath,
            [cliEntry, "acp-mcp-call", ...selector, "js", JSON.stringify(desktopCall)],
            {
              env: {
                NODEX_ACP_MCP_ENDPOINT: server === "node_repl" ? unusedEndpoint : fixture.endpoint,
                NODEX_ACP_DESKTOP_MCP_ENDPOINT:
                  server === "node_repl" ? fixture.endpoint : unusedEndpoint,
                NODEX_ACP_MCP_AUTHORIZATION: fixtureAuthorization,
              },
            },
          ),
        ),
        (child) =>
          Effect.sync(() => {
            child.kill("SIGKILL");
          }),
      );
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      expect(yield* Effect.promise(() => once(child, "close"))).toEqual([0, null]);
      expect(JSON.parse(stdout)).toEqual({
        content: [{ type: "text", text: desktopFixtureResult }],
      });
      expect(yield* Effect.promise(() => fixture.callStarted)).toEqual(desktopCall);
      expect(fixture.methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
);
