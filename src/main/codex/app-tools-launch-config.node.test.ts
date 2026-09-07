import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listenAppToolsPipe } from "@nodex/app-tools-mcp/pipe";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  appToolsEntrypoint,
  appToolsServerConfig,
  appToolsLaunchArgs,
} from "./app-tools-launch-config";

it("launches the packaged MCP layout through its private generation descriptor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nx-launch-"));
  const entrypoint = appToolsEntrypoint({
    isPackaged: true,
    projectRootPath: "/unavailable-development-checkout",
    resourcesPath: join(directory, "Resources with spaces"),
  });
  const pipe = {
    path: join(directory, "host.sock"),
    instanceId: randomUUID(),
    token: randomUUID(),
  };
  const host = await listenAppToolsPipe(pipe, {
    listTools: async () => [{ name: "context", inputSchema: { type: "object" } }],
    callTool: async () => ({ content: [{ type: "text", text: "connected" }] }),
  });
  const client = new Client({ name: "launch-test", version: "1" });
  try {
    await mkdir(dirname(entrypoint), { recursive: true });
    await build({
      entryPoints: [resolve("packages/nodex-app-tools-mcp/src/main.ts")],
      outfile: entrypoint,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
    });
    const input = { runtime: { paths: { node: process.execPath } }, entrypoint, pipe };
    const launchArgs = appToolsLaunchArgs(input);
    expect(launchArgs).toHaveLength(2);
    expect(launchArgs[0]).toBe("-c");
    const parsed = parseToml(launchArgs[1]!);
    expect(parsed).toEqual({ mcp_servers: { nodex_app: appToolsServerConfig(input) } });
    expect(appToolsServerConfig(input)).toMatchObject({
      cwd: dirname(entrypoint),
      command: process.execPath,
      args: [entrypoint],
      enabled: true,
      default_tools_approval_mode: "approve",
      tools: {
        automation_update: { approval_mode: "prompt" },
        create_session: { approval_mode: "prompt" },
        send_message_to_session: { approval_mode: "prompt" },
        fork_session: { approval_mode: "prompt" },
        handoff_session: { approval_mode: "prompt" },
      },
    });
    await client.connect(
      new StdioClientTransport({
        ...appToolsServerConfig(input),
        env: { ...appToolsServerConfig(input).env, ELECTRON_RUN_AS_NODE: "1" },
        stderr: "pipe",
      }),
    );
    expect((await client.callTool({ name: "context" })).content).toEqual([
      { type: "text", text: "connected" },
    ]);
  } finally {
    await client.close();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
