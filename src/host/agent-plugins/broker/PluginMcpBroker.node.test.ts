import { mkdtemp, mkdir, readFile, rm, copyFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vitest";
import type { PluginMcpFailureCode } from "../../../shared/agent-plugins/mcp-lease";
import {
  makePluginMcpBroker,
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
    activeProjects: [scope.project],
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
    activeProjects: [scope.project],
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

const attach = Effect.fnUntraced(function* (lease: PluginMcpLease) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new Client({ name: "test", version: "1" })),
    (client) => Effect.promise(() => client.close()),
  );
  const transport = new StreamableHTTPClientTransport(new URL(lease.url), {
    requestInit: { headers: { Authorization: "Bearer " + lease.bearerToken } },
  });
  yield* Effect.promise(() => client.connect(transport));
  expect(transport.sessionId).toBeUndefined();
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
          yield* broker.publishInstallation(scope.installationId, installation);
          const lease = yield* broker.openLease(scope, allow);
          const view = {
            ...scope,
            principal: { kind: "interface-view", id: scope.principal.id },
          } as const;
          const viewLease = yield* broker.openLease(view, allow);
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
      yield* broker.publishInstallation(scope.installationId, installation);
      const lease = yield* broker.openLease(scope, allow);
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
      yield* broker.publishInstallation(scope.installationId, installation);
      yield* expectFailure(broker.openLease(otherProject), "server_inactive");
      yield* expectFailure(broker.openLease(otherSpace), "server_inactive");
      const lease = yield* broker.openLease(scope, allow);
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
      });
      expect(fixture.seen[0]).toMatchObject({
        authorization: "Bearer from-host-secret-port",
        "x-project": scope.project.projectId,
      });
      expect(
        fixture.seen.some((headers) => headers.authorization?.includes(lease.bearerToken)),
      ).toBe(false);

      yield* broker.publishInstallation(scope.installationId, {
        ...installation,
        activeProjects: [scope.project, otherProject.project],
      });
      const otherLease = yield* broker.openLease(otherProject, allow);
      const mismatched = yield* Effect.promise(() =>
        fetch(otherLease.url, { headers: { Authorization: "Bearer " + lease.bearerToken } }),
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

it.live(
  "revokes a call in flight and cancels the upstream request while another lease remains live",
  () =>
    Effect.gen(function* () {
      const fixture = yield* httpFixture;
      const broker = yield* make();
      yield* broker.publishInstallation(scope.installationId, httpInstallation(fixture.url));
      const first = yield* broker.openLease(scope, allow);
      const second = yield* broker.openLease(scope, allow);
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
      yield* Effect.promise(() => fixture.disconnected);
      yield* expectFailure(broker.listTools(scope, first), "invalid_lease");
      expect(yield* broker.listTools(scope, second)).toHaveLength(2);
      expect(fixture.seen.filter((headers) => !headers["mcp-session-id"])).toHaveLength(1);
    }),
);

it.live("interrupts the upstream call when the downstream MCP client disconnects", () =>
  Effect.gen(function* () {
    const fixture = yield* httpFixture;
    const broker = yield* make();
    yield* broker.publishInstallation(scope.installationId, httpInstallation(fixture.url));
    const lease = yield* broker.openLease(scope, allow);
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

it.live("invalidates leases on disable, generation replacement and uninstall", () =>
  Effect.gen(function* () {
    const fixture = yield* httpFixture;
    const broker = yield* make();
    const installation = httpInstallation(fixture.url);
    yield* broker.publishInstallation(scope.installationId, installation);
    const disabled = yield* broker.openLease(scope);
    const client = yield* attach(disabled);

    yield* broker.publishInstallation(scope.installationId, {
      ...installation,
      activeProjects: [],
    });
    yield* expectFailure(broker.listTools(scope, disabled), "invalid_lease");
    yield* expectFailure(broker.openLease(scope), "server_inactive");
    expect(
      (yield* Effect.tryPromise(() => client.listTools()).pipe(Effect.flip)).cause,
    ).toMatchObject({ code: 401 });

    yield* broker.publishInstallation(scope.installationId, installation);
    const stale = yield* broker.openLease(scope);
    const next = { ...scope, generation: "v2" };
    yield* broker.publishInstallation(scope.installationId, {
      ...installation,
      generation: next.generation,
    });
    yield* expectFailure(broker.listTools(scope, stale), "invalid_lease");
    yield* expectFailure(broker.openLease(scope), "server_inactive");
    const active = yield* broker.openLease(next);
    expect(yield* broker.listTools(next, active)).toHaveLength(2);
    yield* broker.publishInstallation(scope.installationId, null);
    yield* expectFailure(broker.listTools(next, active), "invalid_lease");
  }),
);

it.live("requires approval before calling and returns typed deny and unanswered decisions", () =>
  Effect.gen(function* () {
    const fixture = yield* httpFixture;
    const broker = yield* make({ requestTimeoutMs: 500 });
    yield* broker.publishInstallation(scope.installationId, httpInstallation(fixture.url));
    const approval = vi.fn(() => Effect.succeed("deny" as const));
    const denied = yield* broker.openLease(scope, approval);
    yield* expectFailure(
      broker.callTool(scope, denied, "inspect", { example: true }),
      "approval_denied",
    );
    expect(approval).toHaveBeenCalledWith({
      scope,
      arguments: { example: true },
      tool: expect.objectContaining({ name: "inspect" }),
    });
    const ask = yield* broker.openLease(scope, () => Effect.succeed("ask"));
    yield* expectFailure(broker.callTool(scope, ask, "inspect"), "approval_required");
    const unannotated = yield* broker.openLease(scope);
    yield* expectFailure(broker.callTool(scope, unannotated, "inspect"), "approval_required");
    yield* expectFailure(broker.callTool(scope, unannotated, "missing"), "unknown_tool");
    const unanswered = yield* broker.openLease(scope, () => Effect.never);
    yield* expectFailure(broker.callTool(scope, unanswered, "inspect"), "approval_required");
    expect(fixture.calls).toEqual([]);
  }),
);

it.live("times out and disconnects an unresponsive tool request", () =>
  Effect.gen(function* () {
    const fixture = yield* httpFixture;
    const broker = yield* make({ requestTimeoutMs: 300 });
    yield* broker.publishInstallation(scope.installationId, httpInstallation(fixture.url));
    const lease = yield* broker.openLease(scope, allow);
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
      yield* broker.publishInstallation(scope.installationId, installation);
      const lease = yield* broker.openLease(scope, allow);
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
    yield* broker.publishInstallation(scope.installationId, installation);
    const lease = yield* broker.openLease(scope, allow);
    yield* expectFailure(broker.listTools(scope, lease), "restart_budget_exhausted");
    expect(yield* Effect.promise(() => readFile(join(data, "starts"), "utf8"))).toBe(
      "start\nstart\n",
    );
  }),
);
