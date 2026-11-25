import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vite-plus/test";
import { createAppToolsMcpServer, type AppToolsHost } from "./server";
import {
  APP_TOOLS_CALL_TIMEOUT_MS,
  APP_TOOLS_PIPE_REPLY_GRACE_MS,
  APP_TOOLS_PROVIDER_TIMEOUT_MS,
  appToolsHostCallTimeoutMs,
  appToolsManifest,
} from "./manifest";

const withClient = async (host: AppToolsHost, use: (client: Client) => Promise<void>) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAppToolsMcpServer(host);
  const client = new Client({ name: "nodex-test", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await use(client);
  } finally {
    await client.close();
    await server.close();
  }
};

const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

describe("Nodex MCP transport", () => {
  it("preserves caller metadata and structured domain errors through MCP", async () => {
    const metadata = {
      callId: "call-1",
      "x-codex-turn-metadata": { thread_id: "task-1", turn_id: "turn-1" },
    };
    const data = { ok: false, error: { code: "permission_denied" } };
    await withClient(
      {
        listTools: async () => [{ name: "read_page", inputSchema: { type: "object" } }],
        callTool: async (input) => {
          expect(input.name).toBe("read_page");
          expect(input.arguments).toEqual({ pageId: "page-1" });
          expect(input.metadata).toEqual(metadata);
          return {
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data,
            isError: true,
          };
        },
      },
      async (client) => {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["read_page"]);
        const result = await client.callTool({
          name: "read_page",
          arguments: { pageId: "page-1" },
          _meta: metadata,
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual(data);
      },
    );
  });

  it("propagates MCP cancellation to the host's active call", async () => {
    const admitted = barrier();
    const cancelled = barrier();
    await withClient(
      {
        listTools: async () => [],
        callTool: async ({ signal }) => {
          admitted.resolve();
          signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
          await cancelled.promise;
          return { content: [] };
        },
      },
      async (client) => {
        const controller = new AbortController();
        const pending = client.callTool({ name: "wait_sessions" }, undefined, {
          signal: controller.signal,
        });
        const rejected = expect(pending).rejects.toBeDefined();
        await admitted.promise;
        controller.abort();
        await cancelled.promise;
        await rejected;
      },
    );
  });
});

it("derives wait call deadlines while preserving ordinary tool lifetimes", () => {
  const targets = [{ sessionId: "one" }];
  expect(appToolsHostCallTimeoutMs("wait_sessions", { targets })).toBe(660_000);
  expect(appToolsHostCallTimeoutMs("wait_sessions", { targets, timeoutMs: 3_600_000 })).toBe(
    3_660_000,
  );
  expect(appToolsHostCallTimeoutMs("read_session", { timeoutMs: 3_600_000 })).toBe(
    APP_TOOLS_CALL_TIMEOUT_MS,
  );
  expect(
    appToolsHostCallTimeoutMs("wait_sessions", { targets: [...targets, { sessionId: "two" }] }),
  ).toBe(APP_TOOLS_CALL_TIMEOUT_MS);
  expect(appToolsHostCallTimeoutMs("wait_sessions", {})).toBe(APP_TOOLS_CALL_TIMEOUT_MS);
});

it("leaves reply time at every transport boundary beyond the maximum semantic wait", () => {
  const host = appToolsHostCallTimeoutMs("wait_sessions", {
    targets: [{ sessionId: "one" }],
    timeoutMs: 3_600_000,
  });
  const pipeClient = host + APP_TOOLS_PIPE_REPLY_GRACE_MS;
  expect(pipeClient).toBeGreaterThan(host);
  expect(APP_TOOLS_PROVIDER_TIMEOUT_MS).toBeGreaterThan(pipeClient);
  expect(appToolsManifest.mcpServers.nodex_app.tool_timeout_sec * 1000).toBeGreaterThanOrEqual(
    APP_TOOLS_PROVIDER_TIMEOUT_MS,
  );
});
