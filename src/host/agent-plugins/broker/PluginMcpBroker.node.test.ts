import { Agent, request } from "node:http";
import { text } from "node:stream/consumers";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  copyFile,
  symlink,
  realpath,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vitest";
import type { PluginMcpFailureCode } from "../../../shared/agent-plugins/mcp-lease";
import {
  makePluginMcpBroker,
  PluginMcpFailure,
  type PluginMcpBrokerOptions,
  type PluginMcpInstallation,
  type PluginMcpLease,
  type PluginMcpLeaseScope,
} from "./index";
import { httpFixture } from "./fixtures/http-server.testkit";

afterEach(() => vi.unstubAllEnvs());

const scope = {
  installationId: "installed",
  generation: "v1",
  serverKey: "fixture",
  project: { spaceId: "space-1", projectId: "project-a" },
  principal: { kind: "agent-session", id: "session-1" },
} satisfies PluginMcpLeaseScope;
const otherProject = { ...scope, project: { ...scope.project, projectId: "project-b" } };
const otherSpace = { ...scope, project: { ...scope.project, spaceId: "space-2" } };
const allow = () => Effect.succeed("allow" as const);

const make = (options: Partial<PluginMcpBrokerOptions> = {}) =>
  makePluginMcpBroker({
    executableSearchPath: [dirname(process.execPath)],
    resolveHeaders: () => Effect.succeed({ Authorization: "Bearer from-host-secret-port" }),
    ...options,
  });

const setupStdio = Effect.fnUntraced(function* (mode: string, cwd = "./sub") {
  const base = yield* Effect.acquireRelease(
    Effect.promise(async () => realpath(await mkdtemp(join(tmpdir(), "nodex-plugin-")))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const root = join(base, "package");
  const data = join(base, "data");
  yield* Effect.promise(async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await copyFile(
      fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url)),
      join(root, "server.mjs"),
    );
  });
  const installation: PluginMcpInstallation = {
    generation: scope.generation,
    packageRoot: root,
    dataRoot: data,
    servers: [
      {
        key: scope.serverKey,
        variables: [],
        transport: {
          type: "stdio",
          command: basename(process.execPath),
          args: ["${PLUGIN_ROOT}/server.mjs", mode, "${PLUGIN_DATA}/value ${UNSET}"],
          cwd,
          env: { DECLARED: "${PLUGIN_ROOT}" },
        },
      },
    ],
  };
  return { base, root, data, installation };
});

function httpInstallation(url: string): PluginMcpInstallation {
  return {
    generation: scope.generation,
    packageRoot: "/unused",
    dataRoot: "/unused",
    servers: [
      {
        key: scope.serverKey,
        variables: [],
        transport: {
          type: "streamable-http",
          url,
          headers: { Authorization: "untrusted-package-literal" },
        },
      },
    ],
  };
}

// A leased client owns one HTTP connection across MCP requests.
const connectionFetch =
  (
    agent: Agent,
  ): NonNullable<ConstructorParameters<typeof StreamableHTTPClientTransport>[1]>["fetch"] =>
  (url, init) =>
    new Promise((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(init?.headers));
      const outgoing = request(
        url,
        { agent, method: init?.method, headers, signal: init?.signal ?? undefined },
        (incoming) => {
          const status = incoming.statusCode ?? 500;
          const responseHeaders = new Headers();
          for (const [key, values] of Object.entries(incoming.headersDistinct)) {
            for (const value of values ?? []) responseHeaders.append(key, value);
          }
          void text(incoming).then(
            (body) => resolve(new Response(body || null, { status, headers: responseHeaders })),
            reject,
          );
        },
      );
      outgoing.on("error", reject);
      if (typeof init?.body === "string") outgoing.end(init.body);
      else outgoing.end();
    });

const attach = Effect.fnUntraced(function* (lease: PluginMcpLease, pooled = false) {
  const agent = yield* Effect.acquireRelease(
    Effect.sync(() => new Agent({ keepAlive: true, maxSockets: 1 })),
    (agent) => Effect.sync(() => agent.destroy()),
  );
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new Client({ name: "test", version: "1" })),
    (client) => Effect.promise(() => client.close()),
  );
  const transport = new StreamableHTTPClientTransport(new URL(lease.url), {
    fetch: connectionFetch(agent),
    requestInit: { headers: { Authorization: "Bearer " + lease.bearerToken } },
  });
  yield* Effect.promise(() => client.connect(transport));
  expect(transport.sessionId !== undefined).toBe(pooled);
  return client;
});

function expectFailure<A, E extends { code: PluginMcpFailureCode }>(
  operation: Effect.Effect<A, E>,
  code: PluginMcpFailureCode,
) {
  return Effect.flip(operation).pipe(
    Effect.tap((failure) => Effect.sync(() => expect(failure.code).toBe(code))),
  );
}

it.live(
  "starts stdio lazily, confines the launch environment and kills the child at Scope shutdown",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("NODEX_BROKER_TEST_SECRET", "only-in-the-host");
      vi.stubEnv("NODE_V8_COVERAGE", "only-in-the-host");
      const pid = yield* Effect.scoped(
        Effect.gen(function* () {
          const { root, data, installation } = yield* setupStdio("serve");
          const broker = yield* make();

          const lease = yield* broker.openLease(scope, installation, { approval: allow });
          const view = {
            ...scope,
            principal: { kind: "interface-view", id: scope.principal.id },
          } as const;
          const viewLease = yield* broker.openLease(view, installation, { approval: allow });
          expect(
            yield* Effect.promise(() => readFile(join(data, "starts"), "utf8").catch(() => null)),
          ).toBeNull();

          expect((yield* broker.listTools(scope, lease)).map(({ name }) => name)).toEqual([
            "inspect",
          ]);
          const { structuredContent } = yield* broker.callTool(scope, lease, "inspect");
          expect(structuredContent).toMatchObject({
            cwd: join(root, "sub"),
            env: { PLUGIN_ROOT: root, PLUGIN_DATA: data, DECLARED: root },
            argument: data + "/value ${UNSET}",
          });
          expect(structuredContent?.envNames).toEqual([
            "DECLARED",
            "PLUGIN_DATA",
            "PLUGIN_ROOT",
            // CoreFoundation generates this in the child even for an empty launch environment.
            ...(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : []),
          ]);
          const viewResult = yield* broker.callTool(view, viewLease, "inspect");
          expect(viewResult.structuredContent?.pid).not.toBe(structuredContent?.pid);
          return Number(structuredContent?.pid);
        }),
      );
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    }),
);

it.live.each(["../outside", "./link"])(
  "refuses a working directory outside the staged package (%s)",
  (cwd) =>
    Effect.gen(function* () {
      const { root, base, installation } = yield* setupStdio("serve", cwd);
      const outside = join(base, "outside");
      yield* Effect.promise(async () => {
        await mkdir(outside);
        await symlink(outside, join(root, "link"), "junction");
      });
      const broker = yield* make();

      const lease = yield* broker.openLease(scope, installation, { approval: allow });
      yield* expectFailure(broker.listTools(scope, lease), "invalid_configuration");
    }),
);

it.live(
  "serves tools over loopback MCP with host-provided upstream auth and Project-scoped credentials",
  () =>
    Effect.gen(function* () {
      const fixture = yield* httpFixture;
      const resolveHeaders = vi.fn(
        (request: Parameters<PluginMcpBrokerOptions["resolveHeaders"]>[0]) =>
          Effect.succeed({
            Authorization: "Bearer from-host-secret-port",
            "x-project": request.scope.project.projectId,
          }),
      );
      const broker = yield* make({ resolveHeaders });
      const installation = httpInstallation(fixture.url);

      const lease = yield* broker.openLease(scope, installation, { approval: allow });
      yield* expectFailure(broker.listTools(otherProject, lease), "invalid_lease");
      yield* expectFailure(broker.listTools(otherSpace, lease), "invalid_lease");
      const client = yield* attach(lease);
      expect(
        (yield* Effect.promise(() => client.listTools())).tools.map(({ name }) => name),
      ).toEqual(["inspect", "hang"]);
      const result = yield* Effect.promise(() => client.callTool({ name: "inspect" }));
      expect(result).toEqual({ content: [{ type: "text", text: "from HTTP" }] });
      expect(resolveHeaders).toHaveBeenCalledExactlyOnceWith({
        scope,
        origin: new URL(fixture.url).origin,
        url: fixture.url,
        declaredHeaderNames: ["Authorization"],
        declaredHeaders: { Authorization: "untrusted-package-literal" },
      });
      expect(fixture.seen[0]).toMatchObject({
        authorization: "Bearer from-host-secret-port",
        "x-project": scope.project.projectId,
      });
      expect(
        fixture.seen.some((headers) => headers.authorization?.includes(lease.bearerToken)),
      ).toBe(false);

      const otherLease = yield* broker.openLease(otherProject, installation, { approval: allow });
      const mismatched = yield* Effect.promise(() =>
        fetch(otherLease.url, {
          method: "POST",
          headers: { Authorization: "Bearer " + lease.bearerToken },
        }),
      );
      expect(mismatched.status).toBe(401);
      expect(yield* Effect.promise(() => mismatched.json())).toMatchObject({
        error: { data: { reason: "invalid_lease" } },
      });
      const otherClient = yield* attach(otherLease);
      yield* Effect.promise(() => otherClient.listTools());
      expect(
        fixture.seen.some((headers) => headers["x-project"] === otherProject.project.projectId),
      ).toBe(true);
    }),
);

it.live("rejects replay of a bound bearer on a different HTTP connection", () =>
  Effect.gen(function* () {
    const fixture = yield* httpFixture;
    const broker = yield* make();
    const installation = httpInstallation(fixture.url);
    const lease = yield* broker.openLease(scope, installation);
    const client = yield* attach(lease);
    const replay = yield* Effect.promise(() =>
      fetch(lease.url, {
        method: "POST",
        headers: { Authorization: "Bearer " + lease.bearerToken },
      }),
    );
    expect(replay.status).toBe(401);
    yield* Effect.promise(() => replay.text());
    expect((yield* Effect.promise(() => client.listTools())).tools).toHaveLength(2);
  }),
);

it.live("binds a pooled HTTP client to its issued MCP session across sockets", () =>
  Effect.gen(function* () {
    const fixture = yield* httpFixture;
    const broker = yield* make();
    const installation = httpInstallation(fixture.url);
    const lease = yield* broker.openLease(scope, installation, { httpBinding: "mcp-session" });
    const post = (method: string, sessionId?: string, params?: unknown) =>
      Effect.promise(() =>
        fetch(lease.url, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + lease.bearerToken,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            Connection: "close",
            ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
      );

    const initialized = yield* post("initialize", undefined, {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get("Mcp-Session-Id");
    if (!sessionId) return yield* Effect.die("The initialized lease must issue an MCP session ID.");
    yield* Effect.promise(() => initialized.text());

    for (const replay of [undefined, "another-session"]) {
      const response = yield* post("tools/list", replay);
      expect(response.status).toBe(401);
      yield* Effect.promise(() => response.text());
    }
    const listed = yield* post("tools/list", sessionId);
    expect(listed.status).toBe(200);
    expect(yield* Effect.promise(() => listed.json())).toMatchObject({
      result: { tools: expect.arrayContaining([expect.objectContaining({ name: "inspect" })]) },
    });
    yield* broker.revokeLease(lease.id);
    const revoked = yield* post("tools/list", sessionId);
    expect(revoked.status).toBe(401);
    yield* Effect.promise(() => revoked.text());
  }).pipe(Effect.scoped),
);

it.effect("expires leases after the default and per-lease maximum lifetimes", () =>
  Effect.gen(function* () {
    const fixture = yield* httpFixture;
    const broker = yield* make();
    const installation = httpInstallation(fixture.url);
    yield* expectFailure(
      broker.openLease(scope, installation, { maxLifetimeMs: 0 }),
      "invalid_configuration",
    );
    const lease = yield* broker.openLease(scope, installation);
    const short = yield* broker.openLease(scope, installation, { maxLifetimeMs: 100 });
    yield* TestClock.adjust(100);
    yield* expectFailure(broker.listTools(scope, short), "invalid_lease");
    yield* TestClock.adjust("7 hours");
    expect(yield* broker.listTools(scope, lease)).toHaveLength(2);
    yield* TestClock.adjust(60 * 60 * 1000 - 100);
    yield* expectFailure(broker.listTools(scope, lease), "invalid_lease");
  }).pipe(Effect.scoped),
);

it.live("discards an in-flight reply after revoke and keeps the shared upstream healthy", () =>
  Effect.gen(function* () {
    const fixture = yield* httpFixture;
    const broker = yield* make({ restartBudget: 0 });
    const installation = httpInstallation(fixture.url);
    const first = yield* broker.openLease(scope, installation, { approval: allow });
    const second = yield* broker.openLease(scope, installation, { approval: allow });
    const client = yield* attach(first);
    const active = yield* Effect.tryPromise(() => client.callTool({ name: "hang" })).pipe(
      Effect.flip,
      Effect.forkScoped,
    );

    yield* Effect.promise(() => fixture.started);
    yield* broker.revokeLease(first.id);
    expect((yield* Fiber.join(active)).cause).toMatchObject({
      data: { reason: "lease_revoked" },
    });
    fixture.reply();
    yield* Effect.promise(() => fixture.replied);
    expect(fixture.calls).toEqual(["hang"]);
    expect(yield* broker.listTools(scope, second)).toHaveLength(2);
    expect(fixture.seen.filter((headers) => !headers["mcp-session-id"])).toHaveLength(1);
    for (const request of [() => client.listTools(), () => client.callTool({ name: "inspect" })]) {
      const rejected = yield* Effect.tryPromise(async () => {
        await request();
      }).pipe(Effect.flip);
      expect(rejected.cause).toMatchObject({
        code: 401,
        message: expect.stringContaining('"reason":"lease_revoked"'),
      });
    }
  }),
);

it.live("rejects new operations on a revoked lease before consulting approval", () =>
  Effect.gen(function* () {
    const fixture = yield* httpFixture;
    const broker = yield* make();
    const installation = httpInstallation(fixture.url);
    const approval = vi.fn(allow);
    const lease = yield* broker.openLease(scope, installation, { approval });
    yield* broker.revokeLease(lease.id);

    yield* expectFailure(broker.listTools(scope, lease), "lease_revoked");
    yield* expectFailure(broker.callTool(scope, lease, "inspect"), "lease_revoked");
    yield* expectFailure(broker.listTools(otherProject, lease), "invalid_lease");
    expect(approval).not.toHaveBeenCalled();
    expect(fixture.seen).toEqual([]);
  }),
);

it.live("interrupts the upstream call when the downstream MCP client disconnects", () =>
  Effect.gen(function* () {
    const fixture = yield* httpFixture;
    const broker = yield* make();
    const installation = httpInstallation(fixture.url);
    const lease = yield* broker.openLease(scope, installation, { approval: allow });
    const client = yield* attach(lease);
    yield* Effect.tryPromise(() => client.callTool({ name: "hang" })).pipe(
      Effect.ignore,
      Effect.forkScoped,
    );
    yield* Effect.promise(() => fixture.started);
    yield* Effect.promise(() => client.close());
    yield* Effect.promise(() => fixture.disconnected);
    expect(yield* broker.listTools(scope, lease)).toHaveLength(2);
  }),
);

const startPausedStdioCall = Effect.fnUntraced(function* (
  options: Partial<PluginMcpBrokerOptions> = {},
) {
  const { data, installation } = yield* setupStdio("serve");
  const broker = yield* make(options);

  const lease = yield* broker.openLease(scope, installation, { approval: allow });
  const first = yield* broker.callTool(scope, lease, "inspect");
  const pid = Number(first.structuredContent?.pid);
  const paused = yield* broker
    .callTool(scope, lease, "inspect", { pause: true })
    .pipe(Effect.flip, Effect.forkScoped);
  yield* Effect.promise(() => vi.waitFor(() => access(join(data, "started"))));
  return { broker, data, installation, lease, paused, pid };
});

it.live("revokes delivery while the last call drains before stopping the child", () =>
  Effect.gen(function* () {
    const { broker, data, lease, paused, pid } = yield* startPausedStdioCall();
    yield* broker.revokeLease(lease.id);
    expect(yield* Fiber.join(paused)).toMatchObject({ code: "lease_revoked" });
    expect(() => process.kill(pid, 0)).not.toThrow();
    yield* Effect.promise(() => writeFile(join(data, "release"), ""));
    yield* Effect.promise(() =>
      vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/)),
    );
    expect(yield* Effect.promise(() => readFile(join(data, "finished"), "utf8"))).toBe("call\n");
  }),
);

it.effect("stops a hung upstream after the shutdown grace period", () => {
  const messages: unknown[] = [];
  return Effect.gen(function* () {
    const { broker, paused, pid, lease } = yield* startPausedStdioCall({
      requestTimeoutMs: 20_000,
      shutdownGraceMs: 250,
    });
    yield* broker.revokeLease(lease.id);
    expect(yield* Fiber.join(paused)).toMatchObject({ code: "lease_revoked" });
    yield* TestClock.adjust(249);
    expect(() => process.kill(pid, 0)).not.toThrow();
    yield* TestClock.adjust(1);
    yield* Effect.promise(() =>
      vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/)),
    );
    expect(
      messages
        .flat()
        .filter((item) => item instanceof PluginMcpFailure)
        .map(({ code }) => code),
    ).toEqual(["shutdown_timeout"]);
  }).pipe(
    Effect.scoped,
    Effect.provide(Logger.layer([Logger.make(({ message }) => messages.push(message))])),
  );
});

it.live("requires approval before calling and returns typed deny and unanswered decisions", () =>
  Effect.gen(function* () {
    const fixture = yield* httpFixture;
    const broker = yield* make({ requestTimeoutMs: 500 });
    const installation = httpInstallation(fixture.url);
    const approval = vi.fn(() => Effect.succeed("deny" as const));
    const denied = yield* broker.openLease(scope, installation, { approval });
    yield* expectFailure(
      broker.callTool(scope, denied, "inspect", { example: true }),
      "approval_denied",
    );
    expect(approval).toHaveBeenCalledWith({
      scope,
      arguments: { example: true },
      tool: expect.objectContaining({ name: "inspect" }),
    });
    const ask = yield* broker.openLease(scope, installation, {
      approval: () => Effect.succeed("ask"),
    });
    yield* expectFailure(broker.callTool(scope, ask, "inspect"), "approval_required");
    const unannotated = yield* broker.openLease(scope, installation);
    yield* expectFailure(broker.callTool(scope, unannotated, "inspect"), "approval_required");
    yield* expectFailure(broker.callTool(scope, unannotated, "missing"), "unknown_tool");
    const unanswered = yield* broker.openLease(scope, installation, {
      approval: () => Effect.never,
    });
    yield* expectFailure(broker.callTool(scope, unanswered, "inspect"), "approval_required");
    expect(fixture.calls).toEqual([]);
  }),
);

it.live("times out and disconnects an unresponsive tool request", () =>
  Effect.gen(function* () {
    const fixture = yield* httpFixture;
    const broker = yield* make({ requestTimeoutMs: 300 });
    const installation = httpInstallation(fixture.url);
    const lease = yield* broker.openLease(scope, installation, { approval: allow });
    yield* expectFailure(broker.callTool(scope, lease, "hang"), "timeout");
    yield* Effect.promise(() => fixture.disconnected);
    expect(fixture.calls).toEqual(["hang"]);
  }),
);

it.live(
  "restarts a disconnected stdio child without replaying the failed tool call, then exhausts the budget",
  () =>
    Effect.gen(function* () {
      const { data, installation } = yield* setupStdio("serve");
      const broker = yield* make({ restartBudget: 1 });

      const lease = yield* broker.openLease(scope, installation, { approval: allow });
      yield* expectFailure(
        broker.callTool(scope, lease, "inspect", { exit: true }),
        "upstream_unavailable",
      );
      expect(yield* broker.listTools(scope, lease)).toHaveLength(1);
      yield* expectFailure(
        broker.callTool(scope, lease, "inspect", { exit: true }),
        "upstream_unavailable",
      );
      yield* expectFailure(broker.listTools(scope, lease), "restart_budget_exhausted");
      expect(yield* Effect.promise(() => readFile(join(data, "starts"), "utf8"))).toBe(
        "start\nstart\n",
      );
    }),
);

it.live("bounds automatic restart when an upstream exits before negotiating capabilities", () =>
  Effect.gen(function* () {
    const { data, installation } = yield* setupStdio("crash");
    const broker = yield* make({ restartBudget: 1 });

    const lease = yield* broker.openLease(scope, installation, { approval: allow });
    yield* expectFailure(broker.listTools(scope, lease), "restart_budget_exhausted");
    expect(yield* Effect.promise(() => readFile(join(data, "starts"), "utf8"))).toBe(
      "start\nstart\n",
    );
  }),
);

it.live("serves only current Project skills and contains and bounds package reads", () =>
  Effect.gen(function* () {
    const broker = yield* make();
    const { base, root, installation } = yield* setupStdio("echo");
    const skill = {
      name: "guide",
      description: "A guide",
      directory: "skills/guide",
      valid: true,
      diagnostics: [],
    };
    yield* Effect.promise(async () => {
      const dir = join(root, skill.directory);
      await mkdir(dir, { recursive: true });
      await writeFile(join(base, "secret"), "outside");
      await writeFile(join(dir, "SKILL.md"), "first generation");
      await writeFile(join(dir, "guide.txt"), "supporting text");
      await writeFile(join(dir, "oversize.txt"), "x".repeat(64 * 1024 + 1));
      await symlink(join(base, "secret"), join(dir, "escape.txt"));
    });
    const first = { ...installation, skills: [skill] };
    let authorized = true;
    const lease = yield* broker.openSkillCatalog([["enabled", first]], {
      authorize: Effect.sync(() => authorized),
    });
    const client = yield* attach(lease, true);
    expect((yield* Effect.promise(() => client.listTools())).tools.map(({ name }) => name)).toEqual(
      ["list_plugin_skills", "read_plugin_skill"],
    );
    const call = (name: string, args: Record<string, unknown> = {}) =>
      Effect.promise(() => client.callTool({ name, arguments: args })).pipe(
        Effect.map((result) => {
          const [content] = result.content as { type: string; text: string }[];
          return { result, value: JSON.parse(content!.text) as unknown };
        }),
      );
    const selection = { installationId: "enabled", skill: skill.directory };
    expect((yield* call("list_plugin_skills")).value).toMatchObject({
      skills: [{ installationId: "enabled", generation: "v1" }],
      nextOffset: null,
    });
    expect((yield* call("read_plugin_skill", selection)).value).toMatchObject({
      text: "first generation",
      files: ["guide.txt"],
    });
    expect((yield* call("read_plugin_skill", { ...selection, file: "guide.txt" })).value).toEqual({
      text: "supporting text",
    });
    for (const file of ["../../../secret", "escape.txt", "oversize.txt"]) {
      expect((yield* call("read_plugin_skill", { ...selection, file })).result.isError).toBe(true);
    }
    for (const installationId of ["disabled", "other-project"]) {
      expect(
        (yield* call("read_plugin_skill", { ...selection, installationId })).result.isError,
      ).toBe(true);
    }
    authorized = false;
    yield* Effect.promise(() => expect(client.listTools()).rejects.toThrow("lease_revoked"));
    authorized = true;
    yield* broker.revokeLease(lease.id);
    yield* Effect.promise(() => expect(client.listTools()).rejects.toThrow());
  }),
);
