import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  HostTurnIdentity,
  HostTurnIdentityReport,
} from "@nodex/provider-core/server/ExecutionHost";
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
  options?: Parameters<typeof makeDesktopTools>[2],
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "ndx-desktop-tools-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
      );
      // oxlint-disable-next-line nodex/no-manual-effect-runtime-in-tests -- The scoped test runtime is already live; MCP SDK callbacks need a Promise adapter to its services.
      const execute = Effect.runPromiseWith(yield* Effect.context());
      const context = yield* Effect.promise(() => setup(home, execute, realRoot, options));
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
  options?: Parameters<typeof makeDesktopTools>[2],
) {
  let running = true;
  let automaticPolicy = true;
  let attemptId = "attempt:test";
  const executionCwds = new Map<ThreadId, string>();
  const attachmentsDir = join(home, "attachments");
  await mkdir(attachmentsDir);
  let mode: RuntimeMode = "full-access";
  let decision: ProviderApprovalDecision = "accept";
  let grant = false;
  let waitForAnswer = false;
  let heldCodeApproval:
    | { reached: () => void; result: Promise<ProviderApprovalDecision> }
    | undefined;
  const approvals: RuntimeApprovalRequest[] = [];
  const observed: string[] = [];
  const reports: HostTurnIdentityReport[] = [];
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
          CODEX_CLI_PATH: join(realRoot, "codex-cli/bin/codex"),
          ...(process.platform === "darwin" ? { TMPDIR: "" } : {}),
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
        if (heldCodeApproval && request.kind === "command") {
          heldCodeApproval.reached();
          return await heldCodeApproval.result;
        }
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
  const tools = makeDesktopTools(
    home,
    {
      environment: { HOME: home, CODEX_HOME: codexHome, PATH: process.env.PATH },
      attachmentsDir,
      admit: async ({ threadId }) => {
        if (!running) return undefined;
        const current = { ...identity(threadId), attemptId: RunAttemptId.make(attemptId) };
        if (automaticPolicy)
          tools.prepareRun({ ...current, cwd: executionCwds.get(threadId) ?? null }, mode, []);
        return { identity: current, runtimeMode: mode };
      },
      observe: async (report) => {
        const { phase } = report;
        if (phase === "activity") reports.push(report);
        if (phase === "started" && !realRoot) await appendFile(trace, '{"event":"main-started"}\n');
        observed.push(phase);
      },
      ask: (request) => execute(double.ask(request)),
      isAllowedForChat: (threadId) =>
        execute(double.isAllowedForChat({ threadId, grant: "desktop-tools-javascript" })),
    },
    options,
  );
  return {
    tools,
    home,
    trace,
    codexHome,
    attachmentsDir,
    setCwd: (threadId: ThreadId, cwd: string) => executionCwds.set(threadId, cwd),
    setAttempt: (id: string) => {
      attemptId = id;
    },
    manualPolicy: () => {
      automaticPolicy = false;
    },
    server,
    approvals,
    observed,
    reports,
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
    holdCodeApproval: () => {
      const reached = Promise.withResolvers<void>();
      const result = Promise.withResolvers<ProviderApprovalDecision>();
      heldCodeApproval = { reached: reached.resolve, result: result.promise };
      return { reached: reached.promise, answer: result.resolve };
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
  context.setCwd(threadId, cwd);
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
  it.live.skipIf(process.platform !== "darwin")(
    "uses the admitted attempt’s sandbox and ignores provider-supplied sandbox metadata",
    () =>
      fixture(async (context) => {
        context.manualPolicy();
        const sourceRoot = join(context.home, "sources");
        const workspace = join(context.home, "workspace");
        await mkdir(sourceRoot);
        await mkdir(workspace);
        const { client, js } = await connect(await provision(context));
        const firstIdentity = { ...identity(threadA), cwd: workspace };
        const secondIdentity = { ...firstIdentity, attemptId: RunAttemptId.make("attempt:next") };
        context.tools.prepareRun(secondIdentity, "full-access", []);
        expect(await js("wrong attempt")).toMatchObject({
          isError: true,
          content: [{ text: "Desktop tool execution policy is unavailable" }],
        });

        context.tools.prepareRun(firstIdentity, "approval-required", [sourceRoot]);
        const forged = { permissionProfile: { type: "disabled" } };
        const first = await client.request(
          {
            method: "tools/call",
            params: {
              name: "js",
              arguments: { code: "use host metadata" },
              _meta: {
                "codex/sandbox-state": forged,
                "codex/sandbox-state-meta": forged,
                "codex/sandbox-launcher": { codexExecutable: "/foreign/codex" },
              },
            },
          },
          CallToolResultSchema,
        );
        const metadata = first.structuredContent?.meta as Record<string, unknown>;
        const state = metadata["codex/sandbox-state"];
        expect(metadata["codex/sandbox-state-meta"]).toEqual(state);
        expect(metadata["codex/sandbox-launcher"]).toBeUndefined();
        expect(state).toMatchObject({
          sandboxCwd: pathToFileURL(workspace).href,
          permissionProfile: {
            type: "managed",
            network: "restricted",
            file_system: {
              entries: expect.arrayContaining(
                [workspace, sourceRoot, context.attachmentsDir].map((path) => ({
                  path: { type: "path", path },
                  access: "write",
                })),
              ),
            },
          },
        });
        expect(await realpath(String(first.structuredContent?.cwd))).toBe(
          await realpath(workspace),
        );

        context.tools.prepareRun(firstIdentity, "full-access", []);
        const sameTurn = await js("same turn");
        expect(sameTurn.structuredContent).toMatchObject({
          pid: first.structuredContent?.pid,
          meta: { "codex/sandbox-state": state },
        });

        context.tools.retire(threadA, () => true, "completed");
        context.setAttempt("attempt:next");
        context.tools.prepareRun(secondIdentity, "full-access", []);
        const next = await js("next turn");
        expect(next.structuredContent?.pid).not.toBe(first.structuredContent?.pid);
        expect(next.structuredContent?.meta).toMatchObject({
          "codex/sandbox-state": { permissionProfile: { type: "disabled" } },
        });
        await client.close();
      }),
  );

  it.live.skipIf(process.platform !== "darwin")(
    "refuses to dispatch an approved call once a replacement attempt owns the kernel",
    () =>
      fixture(async (context) => {
        context.manualPolicy();
        context.setMode("approval-required");
        const firstIdentity = { ...identity(threadA), cwd: context.home };
        context.tools.prepareRun(firstIdentity, "full-access", []);
        const { client, js } = await connect(await provision(context));
        const held = context.holdCodeApproval();
        const oldCall = js("retired call");
        await held.reached;

        context.setAttempt("attempt:next");
        const nextIdentity = { ...firstIdentity, attemptId: RunAttemptId.make("attempt:next") };
        context.tools.prepareRun(nextIdentity, "approval-required", []);
        held.answer("accept");
        expect((await oldCall).isError).toBe(true);
        const result = await js("new owner");
        expect(result.structuredContent?.meta).toMatchObject({
          "codex/sandbox-state": { permissionProfile: { type: "managed" } },
        });
        const trace = await readFile(context.trace, "utf8");
        expect(trace.match(/"event":"js"/gu)).toHaveLength(1);
        await client.close();
      }),
  );

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
        expect(context.reports).toEqual([]);
        await first.js("browser-surface");
        await first.js("computer-surface");
        expect(context.reports).toEqual([
          {
            phase: "activity",
            identity: identity(threadA),
            nativeThreadId: expect.stringMatching(/^[a-f0-9]{64}$/u),
            nativeTurnId: "attempt:test",
            activity: {
              kind: "browser-use",
              surface: { backend: "iab", browserId: "fixture-browser", openTabIds: ["1"] },
            },
          },
          {
            phase: "activity",
            identity: identity(threadA),
            nativeThreadId: expect.stringMatching(/^[a-f0-9]{64}$/u),
            nativeTurnId: "attempt:test",
            activity: { kind: "computer-use", active: true, itemId: expect.any(String) },
          },
        ]);
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

  /** Starts a call over a raw request, so the test can stop waiting for it in each way. */
  async function startCall(info: Awaited<ReturnType<typeof provision>>, code: "long" | "slow") {
    const { client, transport, js } = await connect(info);
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
        id: "call",
        method: "tools/call",
        params: { name: "js", arguments: { code }, _meta: { progressToken: "progress" } },
      }),
    });
    const reader = result.body!.getReader();
    const chunk = await reader.read();
    expect(Buffer.from(chunk.value!).toString()).toContain('"progressToken":"progress"');
    const stopWaiting = async (reason: "socket" | "notification" | "DELETE") => {
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
                params: { requestId: "call" },
              }),
            })
          ).status,
        ).toBe(202);
      }
      if (reason === "DELETE") await transport.terminateSession();
    };
    const close = async () => {
      await reader.cancel().catch(() => {});
      await client.close();
    };
    return { js, stopWaiting, close };
  }
  const kernelEvents = async (context: TestContext) =>
    (await readFile(context.trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { event: string }).event)
      .filter((event) => ["js", "finished", "cancelled"].includes(event));

  // Cancelling upstream resets the kernel and every binding in it. A provider stops waiting
  // whenever a new message redirects its turn, which must not cost the Agent its script state.
  it.live.each(["socket", "notification", "DELETE"] as const)(
    "lets a call finish when its caller stops waiting (%s), and runs the next call after it",
    (reason) =>
      fixture(async (context) => {
        const info = await provision(context);
        const call = await startCall(info, "slow");
        await call.stopWaiting(reason);
        // A terminated MCP session cannot carry the next call.
        const reconnected = reason === "DELETE" ? await connect(info) : undefined;
        expect((await (reconnected ?? call).js("after")).isError).not.toBe(true);
        expect(await kernelEvents(context)).toEqual(["js", "finished", "js"]);
        await call.close();
        await reconnected?.client.close();
      }),
  );

  it.live.each([false, true])(
    "cancels upstream when the attempt ends (caller stopped waiting first: %s)",
    (abandoned) =>
      fixture(async (context) => {
        const call = await startCall(await provision(context), "long");
        if (abandoned) await call.stopWaiting("socket");
        context.setRunning(false);
        for (let i = 0; i < 2; i++) context.tools.retire(threadA, () => true, "interrupted");
        await vi.waitFor(() => expect(context.observed).toEqual(["started", "ended"]));
        const log = await readFile(context.trace, "utf8");
        expect(log.match(/"event":"turn_ended"/g)).toHaveLength(1);
        expect(log).toContain('"hook_event_name":"Interrupt"');
        await vi.waitFor(async () =>
          expect(await kernelEvents(context)).toEqual(["js", "cancelled"]),
        );
        await call.close();
      }),
  );

  it.live("releases an idle chat's kernel and starts a fresh one on its next call", () =>
    fixture(
      async (context) => {
        const { client, js } = await connect(await provision(context));
        const first = await js("ok");
        const pid = Number(first.structuredContent?.pid);
        // A running turn keeps its kernel between calls, however long it waits.
        expect((await js("ok")).structuredContent?.pid).toBe(pid);
        context.tools.retire(threadA, () => true, "completed");
        await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
        expect((await js("ok")).structuredContent?.pid).not.toBe(pid);
        await client.close();
      },
      undefined,
      { replIdleReleaseMs: 0 },
    ),
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
      context.tools.retire(threadA, () => true, "completed");
      context.setAttempt("attempt:different-cwd");
      context.setCwd(threadA, cwd);
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
it.live.skipIf(!realRoot || process.platform !== "darwin")(
  "enforces the admitted filesystem and network policy for Node and its children",
  () =>
    fixture(async (context) => {
      context.manualPolicy();
      context.setMode("approval-required");
      const workspace = join(context.home, "workspace");
      const sourceRoot = join(context.home, "sources");
      const outside = join(context.home, "outside");
      await Promise.all([workspace, sourceRoot, outside].map((dir) => mkdir(dir)));
      const marker = join(outside, "marker");
      await writeFile(marker, "readable");

      const { client, js } = await connect(await provision(context, threadA, [], workspace));
      const secret = randomUUID();
      const prefix = createHash("sha256").update(secret).digest("hex").slice(0, 12);
      const loopback = createServer((_request, response) => response.end(secret));
      await new Promise<void>((resolve) => loopback.listen(0, "127.0.0.1", resolve));
      const { port } = loopback.address() as { port: number };
      const url = `http://127.0.0.1:${port}`;
      const trace: unknown[] = [];
      const firstIdentity = { ...identity(threadA), cwd: workspace };
      const invoke = async (code: string) => {
        const result = await js(code);
        trace.push(code, result);
        expect(result.isError).not.toBe(true);
        const output = result.content.find((item) => item.type === "text");
        return JSON.parse(output?.type === "text" ? output.text : "");
      };

      try {
        context.tools.prepareRun(firstIdentity, "approval-required", [sourceRoot]);
        const restricted = await invoke(`
          const fs = await import("node:fs/promises");
          const cp = await import("node:child_process");
          const attempt = async (fn) => { try { return await fn(); } catch (error) { return error.code ?? error.cause?.code ?? error.name; } };
          const write = (path) => attempt(async () => { await fs.writeFile(path, "fixture"); return "ok"; });
          nodeRepl.write(JSON.stringify({
            cwd: await fs.realpath(nodeRepl.cwd),
            scratch: nodeRepl.tmpDir,
            read: await fs.readFile(${JSON.stringify(marker)}, "utf8"),
            writes: await Promise.all([
              write(nodeRepl.cwd + "/probe"),
              write(nodeRepl.tmpDir + "/probe"),
              write(${JSON.stringify(join(sourceRoot, "probe"))}),
              write(${JSON.stringify(join(context.attachmentsDir, "probe"))}),
              write(${JSON.stringify(marker)}),
            ]),
            fetch: await attempt(async () => (await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(1000) })).status),
            childWrite: cp.spawnSync("/usr/bin/touch", [${JSON.stringify(join(outside, "child"))}], { stdio: "ignore" }).status,
            childNetwork: cp.spawnSync("/usr/bin/curl", ["-fsS", "--max-time", "1", ${JSON.stringify(url)}], { stdio: "ignore" }).status,
          }));
        `);
        expect(restricted).toMatchObject({
          cwd: await realpath(workspace),
          read: "readable",
          writes: ["ok", "ok", "ok", "ok", "EPERM"],
          fetch: "EPERM",
          childWrite: 1,
          childNetwork: 7,
        });
        expect((await stat(restricted.scratch)).mode & 0o777).toBe(0o700);

        context.tools.retire(threadA, () => true, "completed");
        context.setAttempt("attempt:full");
        context.setMode("full-access");
        context.tools.prepareRun(
          { ...firstIdentity, attemptId: RunAttemptId.make("attempt:full") },
          "full-access",
          [],
        );
        const full = await invoke(`
          const value = await (await fetch(${JSON.stringify(url)})).text();
          const { spawn } = await import("node:child_process");
          const child = spawn("/usr/bin/shasum", ["-a", "256"], { stdio: ["pipe", "pipe", "ignore"] });
          const output = await new Promise((resolve, reject) => {
            let digest = "";
            child.once("error", reject);
            child.stdin.once("error", reject);
            child.stdout.on("data", (chunk) => { digest += chunk; });
            child.once("close", (status) => resolve({ status, match: digest.startsWith(${JSON.stringify(prefix)}) }));
            child.stdin.end(value);
          });
          const fs = await import("node:fs/promises");
          await fs.writeFile(${JSON.stringify(marker)}, "updated");
          nodeRepl.write(JSON.stringify({ ...output, scratch: nodeRepl.tmpDir }));
        `);
        expect(full).toMatchObject({ status: 0, match: true });
        expect(await readFile(marker, "utf8")).toBe("updated");
        expect(full.scratch).not.toBe(restricted.scratch);
        await expect(access(restricted.scratch)).rejects.toMatchObject({ code: "ENOENT" });
        expect(JSON.stringify(trace)).not.toContain(secret);
      } finally {
        await client.close();
        await new Promise<void>((resolve, reject) =>
          loopback.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }, realRoot),
);

it.live.skipIf(!realRoot)(
  "runs the signed REPL without a provider, keeps its kernel when a caller stops waiting, and resets it when the attempt ends",
  () =>
    fixture(async (context) => {
      const info = await provision(context);
      const { client, js } = await connect(info);
      const text = (result: Awaited<ReturnType<typeof js>>) =>
        result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("");
      const stamped = await js("nodeRepl.write(JSON.stringify(nodeRepl.requestMeta))");
      expect(stamped.isError).not.toBe(true);
      expect(text(stamped)).toMatch(
        /"x-codex-turn-metadata":\{"session_id":"[a-f0-9]+","thread_id":"[a-f0-9]+","turn_id":"attempt:test"\}/u,
      );
      expect((await js("globalThis.steps = ['bound']")).isError).not.toBe(true);

      // This transport aborts only fetch. The client never sends notifications/cancelled.
      const { client: dropping, transport } = await connect(info);
      const start = (code: string, signal: AbortSignal) =>
        fetch(info.endpoint, {
          method: "POST",
          headers: {
            ...info.headers,
            "mcp-session-id": transport.sessionId!,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          signal,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: code,
            method: "tools/call",
            params: { name: "js", arguments: { code } },
          }),
        }).catch(() => undefined);
      const directory = join(context.codexHome, "node_repl/active_execs");
      const records = async () =>
        (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json"));
      const activeExecution = async () => {
        await vi.waitFor(async () => expect(await records()).toHaveLength(1));
        return JSON.parse(await readFile(join(directory, (await records())[0]!), "utf8")) as {
          kernelPid: number;
          nodeReplPid: number;
        };
      };

      // The caller's socket closes mid-call: the call finishes, and the next one runs after it
      // in the same kernel with every binding intact.
      const abandoned = new AbortController();
      const abandonedRequest = start(
        "await new Promise(resolve => setTimeout(resolve, 1500)); globalThis.steps.push('finished')",
        abandoned.signal,
      );
      const first = await activeExecution();
      abandoned.abort();
      await abandonedRequest;
      expect(text(await js("nodeRepl.write(JSON.stringify(globalThis.steps))"))).toContain(
        '["bound","finished"]',
      );
      expect(isAlive(first.kernelPid)).toBe(true);

      // Ending the attempt is what stops running JavaScript, by resetting the kernel.
      const stopped = start(
        "await new Promise(resolve => setTimeout(resolve, 60000))",
        new AbortController().signal,
      );
      const active = await activeExecution();
      expect(active.kernelPid).toBe(first.kernelPid);
      const parent = (pid: number) =>
        Number(execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim());
      const codex = parent(active.nodeReplPid);
      const launcher = parent(codex);
      for (const pid of [active.kernelPid, active.nodeReplPid, codex, launcher])
        expect(isAlive(pid)).toBe(true);
      context.setRunning(false);
      context.tools.retire(threadA, () => true, "interrupted");
      await stopped;
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
