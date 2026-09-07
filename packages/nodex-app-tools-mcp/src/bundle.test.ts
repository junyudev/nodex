import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { listenAppToolsPipe } from "./pipe";

it("runs the standalone MCP bundle outside the repository dependency tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nx-bundle-"));
  const entrypoint = join(directory, "server.mjs");
  const descriptor = {
    path: join(directory, "host.sock"),
    instanceId: randomUUID(),
    token: randomUUID(),
  };
  const host = await listenAppToolsPipe(descriptor, {
    listTools: async () => [{ name: "get_session_context", inputSchema: { type: "object" } }],
    callTool: async ({ metadata }) => ({
      content: [{ type: "text", text: "Context" }],
      structuredContent: { callId: metadata?.callId },
    }),
  });
  const client = new Client({ name: "bundle-test", version: "1" });
  try {
    await build({
      entryPoints: [resolve("packages/nodex-app-tools-mcp/src/main.ts")],
      outfile: entrypoint,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entrypoint],
        cwd: directory,
        env: {
          NODEX_APP_TOOLS_PIPE: descriptor.path,
          NODEX_APP_TOOLS_INSTANCE: descriptor.instanceId,
          NODEX_APP_TOOLS_TOKEN: descriptor.token,
        },
        stderr: "pipe",
      }),
    );
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "get_session_context",
    ]);
    const result = await client.callTool({
      name: "get_session_context",
      _meta: { callId: "call-1" },
    });
    expect(result.structuredContent).toEqual({ callId: "call-1" });
  } finally {
    await client.close();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
