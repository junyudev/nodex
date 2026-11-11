import { createServer } from "node:http";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { HostTurnIdentity } from "@nodex/provider-core/server/ExecutionHost";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type RuntimeMode,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import { nodeReplServerDefinition } from "../../../../src/main/codex/desktop-tool-environment.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Registry from "../mcp/McpSessionRegistry.ts";
import {
  RuntimeApprovals,
  type RuntimeApprovalRequest,
} from "../orchestration-v2/RuntimeApprovals.ts";
import { DesktopTools, makeDesktopTools } from "./DesktopTools.ts";
import * as Http from "./Http.ts";

const instance = ProviderInstanceId.make("test");
const threadA = ThreadId.make("thread:a");
const threadB = ThreadId.make("thread:b");
const identity = (threadId: ThreadId): HostTurnIdentity => ({
  threadId,
  providerInstanceId: instance,
  nativeThreadRef: null,
  cwd: null,
  projectId: ProjectId.make("project:test"),
  runId: RunId.make("run:test"),
  attemptId: RunAttemptId.make("attempt:test"),
  nativeGeneration: 1,
  providerSessionId: ProviderSessionId.make("session:test"),
  providerThreadId: ProviderThreadId.make("provider-thread:test"),
});

const fixture = (
  run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  realRoot?: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "ndx-desktop-tools-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
      );
      // oxlint-disable-next-line nodex/no-manual-effect-runtime-in-tests -- The scoped test runtime is already live; MCP SDK callbacks need a Promise adapter to its services.
      const execute = Effect.runPromiseWith(yield* Effect.context());
      const context = yield* Effect.promise(() => setup(home, execute, realRoot));
      yield* Effect.addFinalizer(() => Effect.promise(context.tools.close));
      const http = HttpRouter.serve(Http.layer, { disableLogger: true }).pipe(
        Layer.provide(Layer.succeed(DesktopTools, context.tools)),
        Layer.provideMerge(Registry.layer),
        Layer.provide(
          Layer.succeed(ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
          }),
        ),
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, {
            host: "127.0.0.1",
            port: 0,
            gracefulShutdownTimeout: 0,
          }),
        ),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const registry = yield* Registry.McpSessionRegistry;
        context.issue = (threadId: ThreadId) =>
          execute(registry.issue({ threadId, providerInstanceId: instance }));
        yield* Effect.promise(() => run(context));
      }).pipe(Effect.provide(http));
    }),
  );

async function setup(
  home: string,
  execute: <A>(effect: Effect.Effect<A>) => Promise<A>,
  realRoot?: string,
) {
  let running = true;
  let mode: RuntimeMode = "full-access";
  let decision: ProviderApprovalDecision = "accept";
  let grant = false;
  let waitForAnswer = false;
  const approvals: RuntimeApprovalRequest[] = [];
  const observed: string[] = [];
  const trace = join(home, "fixture.jsonl");
  const codexHome = join(home, "codex");
  await mkdir(codexHome);
  const server = realRoot
    ? nodeReplServerDefinition({
        codexCliPath: join(realRoot, "codex-cli/bin/codex"),
        nodePath: join(realRoot, "bin/node"),
        nodeReplPath: join(realRoot, "bin/node_repl"),
        env: {
          HOME: home,
          CODEX_HOME: codexHome,
          NODE_REPL_DISABLE_ANALYTICS: "1",
          NODE_REPL_NODE_PATH: join(realRoot, "bin/node"),
        },
      })
    : {
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/repl.mjs", import.meta.url)), trace],
        env: {},
      };
  const double: RuntimeApprovals["Service"] = {
    ask: (request) =>
      Effect.promise(async () => {
        approvals.push(request);
        if (waitForAnswer && request.kind === "mcp-elicitation") {
          if (!request.signal?.aborted)
            await new Promise<void>((resolve) =>
              request.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
          return "cancel";
        }
        if (decision === "acceptForSession" && request.chatGrant !== undefined) grant = true;
        return decision;
      }),
    isAllowedForChat: () => Effect.sync(() => grant),
    allowForChat: () =>
      Effect.sync(() => {
        grant = true;
      }),
  };
  const tools = makeDesktopTools(home, {
    environment: { HOME: home, CODEX_HOME: codexHome, PATH: process.env.PATH },
    admit: async ({ threadId }) =>
      running ? { identity: identity(threadId), runtimeMode: mode } : undefined,
    observe: async ({ phase }) => {
      if (phase === "started" && !realRoot) await appendFile(trace, '{"event":"main-started"}\n');
      observed.push(phase);
    },
    ask: (request) => execute(double.ask(request)),
    isAllowedForChat: (threadId) =>
      execute(double.isAllowedForChat({ threadId, grant: "desktop-tools-javascript" })),
  });
  return {
    tools,
    home,
    trace,
    codexHome,
    server,
    approvals,
    observed,
    setRunning: (value: boolean) => {
      running = value;
    },
    setMode: (value: RuntimeMode) => {
      mode = value;
      grant = false;
    },
    setDecision: (value: ProviderApprovalDecision) => {
      decision = value;
    },
    waitForAnswer: () => {
      waitForAnswer = true;
    },
    issue: (_threadId: ThreadId): Promise<Registry.McpIssuedCredential> =>
      Promise.reject(new Error("Missing registry")),
  };
}

type TestContext = Awaited<ReturnType<typeof setup>>;

async function provision(
  context: TestContext,
  threadId = threadA,
  pluginRoots: string[] = [],
  cwd = context.home,
) {
  const { config } = await context.issue(threadId);
  const descriptor = await context.tools.prepare(config, config.endpoint, {
    tools: { server: context.server, pluginRoots },
    cwd,
  });
  return {
    config,
    descriptor: descriptor!,
    endpoint: descriptor!.endpoint,
    headers: { authorization: config.authorizationHeader },
  };
}

async function connect(info: Awaited<ReturnType<typeof provision>>) {
  const transport = new StreamableHTTPClientTransport(new URL(info.endpoint), {
    requestInit: { headers: info.headers },
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  const js = (code: string, onprogress?: () => void) =>
    client.request(
      { method: "tools/call", params: { name: "js", arguments: { code } } },
      CallToolResultSchema,
      { ...(onprogress ? { onprogress } : {}), timeout: 12_000 },
    );
  return { client, transport, js };
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("Desktop Tools", () => {
  it.live(
    "authenticates each exchange, shapes discovery, stamps identity, and retains the REPL across HTTP sessions",
    () =>
      fixture(async (context) => {
        const a = await provision(context);
        const b = await provision(context, threadB);
        const first = await connect(a);
        expect(first.client.getServerVersion()?.name).toBe("node_repl");
        expect(first.client.getInstructions()).toBe("fixture instructions");
        const sessionId = first.transport.sessionId!;
        for (const headers of [{ authorization: "Bearer bad" }, b.headers]) {
          for (const method of ["GET", "POST", "DELETE"]) {
            const response = await fetch(a.endpoint, {
              method,
              headers: { ...headers, "mcp-session-id": sessionId },
            });
            expect(response.status).toBe(401);
          }
        }
        expect(
          (
            await fetch(a.endpoint, {
              headers: {
                ...a.headers,
                origin: "https://example.test",
                "mcp-session-id": sessionId,
              },
            })
          ).status,
        ).toBe(403);
        const tools = (await first.client.listTools()).tools;
        expect(tools.map((tool) => tool.name)).toEqual([
          "js",
          "js_reset",
          "js_add_node_module_dir",
        ]);
        expect(
          tools.every((tool) => !tool.annotations && tool._meta?.["anthropic/alwaysLoad"]),
        ).toBe(true);
        for (const name of ["turn_ended", "another_hidden"]) {
          expect((await first.client.callTool({ name })).isError).toBe(true);
        }
        context.setRunning(false);
        expect((await first.js("ok")).isError).toBe(true);
        context.setRunning(true);
        const result = await first.js("ok");
        const metadata = result.structuredContent?.meta;
        expect(metadata).toMatchObject({
          callId: expect.any(String),
          "x-codex-turn-metadata": {
            session_id: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
            turn_id: "attempt:test",
          },
        });
        expect(result.content[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
        expect(result._meta).toEqual({
          "codex/toolSurface": { kind: "browserUse", backend: "iab" },
        });
        expect(context.observed).toEqual(["started"]);
        const trace = await readFile(context.trace, "utf8");
        expect(trace.indexOf('"event":"main-started"')).toBeGreaterThanOrEqual(0);
        expect(trace.indexOf('"event":"main-started"')).toBeLessThan(trace.indexOf('"event":"js"'));
        const pid = Number(result.structuredContent?.pid);
        await first.transport.terminateSession();
        await first.client.close();
        const replacement = await connect(a);
        expect((await replacement.js("ok")).structuredContent?.pid).toBe(pid);
        const fork = await connect(b);
        const forkResult = await fork.js("ok");
        expect(forkResult.structuredContent?.pid).not.toBe(pid);
        expect(forkResult.structuredContent?.meta).not.toEqual(metadata);
        await context.tools.closeThread(threadA);
        await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
        expect(isAlive(Number(forkResult.structuredContent?.pid))).toBe(true);
        await Promise.all([replacement.client.close(), fork.client.close()]);
      }),
  );

  it.live(
    "applies current code permission and correlates elicitations with their originating call",
    () =>
      fixture(async (context) => {
        const { js, client } = await connect(await provision(context));
        expect((await js("elicit")).structuredContent?.reply).toEqual({
          action: "accept",
          content: {},
        });
        for (const code of [
          "elicit-required",
          "elicit-strict",
          "elicit-foreign",
          "elicit-other-turn",
        ])
          expect((await js(code)).structuredContent?.reply).toEqual({ action: "decline" });
        expect(context.approvals).toHaveLength(0);
        context.setMode("approval-required");
        context.setDecision("decline");
        expect((await js("return 1")).isError).toBe(true);
        expect(context.approvals.at(-1)).toMatchObject({
          kind: "command",
          prompt: "return 1",
          attemptId: "attempt:test",
        });
        expect((await client.callTool({ name: "js_reset" })).isError).toBeUndefined();
        expect(context.approvals).toHaveLength(1);
        context.setMode("auto");
        context.setDecision("acceptForSession");
        expect((await js("elicit")).structuredContent?.reply).toEqual({
          action: "accept",
          content: {},
          _meta: { persist: "session" },
        });
        expect(context.approvals.map(({ kind }) => kind)).toEqual([
          "command",
          "command",
          "mcp-elicitation",
        ]);
        expect((await js("no new code card")).isError).toBeUndefined();
        expect(context.approvals).toHaveLength(3);
        context.setMode("approval-required");
        expect((await js("changed mode")).isError).toBeUndefined();
        expect(context.approvals).toHaveLength(4);
        await client.close();
      }),
  );

  it.live("cancels an elicitation with reverse request id zero", () =>
    fixture(async (context) => {
      context.setMode("auto");
      context.waitForAnswer();
      const { client, js } = await connect(await provision(context));
      expect((await js("elicit-cancel")).structuredContent?.reply).toEqual({ action: "cancel" });
      await client.close();
    }),
  );

  it.live.each(["socket", "notification", "DELETE", "attempt"] as const)(
    "cancels upstream on %s",
    (reason) =>
      fixture(async (context) => {
        const info = await provision(context);
        const { client, transport } = await connect(info);
        const controller = new AbortController();
        const headers = {
          ...info.headers,
          "mcp-session-id": transport.sessionId!,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        };
        const result = await fetch(info.endpoint, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "long",
            method: "tools/call",
            params: {
              name: "js",
              arguments: { code: "long" },
              _meta: { progressToken: "progress" },
            },
          }),
        });
        const reader = result.body!.getReader();
        const chunk = await reader.read();
        expect(Buffer.from(chunk.value!).toString()).toContain('"progressToken":"progress"');
        if (reason === "socket") controller.abort();
        if (reason === "notification") {
          expect(
            (
              await fetch(info.endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/cancelled",
                  params: { requestId: "long" },
                }),
              })
            ).status,
          ).toBe(202);
        }
        if (reason === "DELETE") await transport.terminateSession();
        if (reason === "attempt") {
          context.setRunning(false);
          for (let i = 0; i < 2; i++) context.tools.retire(threadA, () => true, "interrupted");
          await vi.waitFor(() => expect(context.observed).toEqual(["started", "ended"]));
          const log = await readFile(context.trace, "utf8");
          expect(log.match(/"event":"turn_ended"/g)).toHaveLength(1);
          expect(log).toContain('"hook_event_name":"Interrupt"');
        }
        await vi.waitFor(async () =>
          expect(await readFile(context.trace, "utf8")).toContain('"event":"cancelled"'),
        );
        await reader.cancel().catch(() => {});
        await client.close();
      }),
  );

  it.live("restarts a crashed child on the next call and replaces the child when cwd changes", () =>
    fixture(async (context) => {
      const info = await provision(context);
      const { client, js } = await connect(info);
      const first = await js("ok");
      expect((await js("crash")).isError).toBe(true);
      const second = await js("ok");
      expect(second.structuredContent?.pid).not.toBe(first.structuredContent?.pid);
      const cwd = join(context.home, "new");
      await mkdir(cwd);
      await context.tools.prepare(info.config, info.config.endpoint, {
        tools: { server: context.server, pluginRoots: [] },
        cwd,
      });
      const third = await js("ok");
      expect(third.structuredContent?.cwd).toBe(await realpath(cwd));
      expect(isAlive(Number(second.structuredContent?.pid))).toBe(false);
      await client.close();
    }),
  );

  it.live("qualifies skill frontmatter and claims matching captures in order", () =>
    fixture(async (context) => {
      const plugin = join(context.home, "plugin");
      await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
      await mkdir(join(plugin, "skills/browser"), { recursive: true });
      await mkdir(join(plugin, ".codex-plugin"));
      await writeFile(join(plugin, ".claude-plugin/plugin.json"), '{"name":"desktop"}');
      await writeFile(
        join(plugin, ".codex-plugin/plugin.json"),
        JSON.stringify({
          interface: {
            displayName: "Browser",
            composerIcon: "./assets/browser.png",
            brandColor: "#123456",
          },
        }),
      );
      const path = join(plugin, "skills/browser/SKILL.md");
      await writeFile(path, "---\nname: browser\ndescription: >-\n  Browse\n  the web.\n---\n");
      const info = await provision(context, threadA, [plugin]);
      expect(info.descriptor.skills).toEqual([
        {
          name: "desktop:browser",
          description: "Browse the web.",
          path,
          displayName: "Browser",
          iconPath: join(plugin, "assets/browser.png"),
          brandColor: "#123456",
        },
      ]);
      const { client, js } = await connect(info);
      await js("same");
      await js("same");
      const now = DateTime.makeUnsafe(0);
      const item: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> = {
        type: "dynamic_tool",
        id: TurnItemId.make("item:test"),
        threadId: threadA,
        runId: identity(threadA).runId,
        nodeId: NodeId.make("node:test"),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        title: null,
        status: "completed",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        toolName: "node_repl_thread_js",
        input: { code: "same", __nodexExecutionCall: "internal" },
      };
      const attemptId = identity(threadA).attemptId;
      const unmatched = { ...item, input: { code: "unmatched" } };
      expect(context.tools.enrich(unmatched, attemptId)).toBe(unmatched);
      const first = context.tools.enrich(item, attemptId);
      expect(first.mcpToolCall).toMatchObject({
        server: "node_repl",
        tool: "js",
        result: { _meta: { "codex/toolSurface": { kind: "browserUse", backend: "iab" } } },
      });
      expect(context.tools.enrich(first, attemptId)).toBe(first);
      expect(context.tools.enrich(item, attemptId)).toEqual(first);
      const second = context.tools.enrich(
        { ...item, id: TurnItemId.make("item:second") },
        attemptId,
      );
      expect(second.mcpToolCall?.result?.structuredContent).not.toEqual(
        first.mcpToolCall?.result?.structuredContent,
      );
      const third = { ...item, id: TurnItemId.make("item:third") };
      expect(context.tools.enrich(third, attemptId)).toBe(third);
      expect(await context.tools.prepare(info.config, info.config.endpoint)).toBeUndefined();
      await client.close();
    }),
  );
});

const realRoot = process.env.NODEX_TEST_DESKTOP_TOOLS_RUNTIME;
it.live.skipIf(!realRoot)(
  "runs the signed REPL without a provider and resets its kernel on socket close",
  () =>
    fixture(async (context) => {
      const info = await provision(context);
      const { client, js } = await connect(info);
      const stamped = await js("nodeRepl.write(JSON.stringify(nodeRepl.requestMeta))");
      expect(stamped.isError).not.toBe(true);
      expect(stamped.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringMatching(
              /"x-codex-turn-metadata":\{"session_id":"[a-f0-9]+","thread_id":"[a-f0-9]+","turn_id":"attempt:test"\}/u,
            ),
          }),
        ]),
      );

      const controller = new AbortController();
      // This transport aborts only fetch. The client never sends notifications/cancelled.
      const { client: dropping, transport } = await connect(info);
      const request = fetch(info.endpoint, {
        method: "POST",
        headers: {
          ...info.headers,
          "mcp-session-id": transport.sessionId!,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "long",
          method: "tools/call",
          params: {
            name: "js",
            arguments: { code: "await new Promise(resolve => setTimeout(resolve, 60000))" },
          },
        }),
      }).catch(() => undefined);
      const directory = join(context.codexHome, "node_repl/active_execs");
      const records = async () =>
        (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json"));
      await vi.waitFor(async () => expect(await records()).toHaveLength(1));
      const active = JSON.parse(await readFile(join(directory, (await records())[0]!), "utf8")) as {
        kernelPid: number;
        nodeReplPid: number;
      };
      const parent = (pid: number) =>
        Number(execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim());
      const codex = parent(active.nodeReplPid);
      const launcher = parent(codex);
      for (const pid of [active.kernelPid, active.nodeReplPid, codex, launcher])
        expect(isAlive(pid)).toBe(true);
      controller.abort();
      await request;
      await vi.waitFor(async () => {
        expect(await records()).toEqual([]);
        expect(isAlive(active.kernelPid)).toBe(false);
      });
      expect(isAlive(active.nodeReplPid)).toBe(true);
      await context.tools.close();
      await vi.waitFor(() => {
        for (const pid of [active.nodeReplPid, codex, launcher]) expect(isAlive(pid)).toBe(false);
      });
      await Promise.all([client.close(), dropping.close()]);
    }, realRoot),
);
