import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { vi } from "vitest";
import { makeOpenCodeCatalog, openOpenCodeCatalog } from "./OpenCodeCatalog.ts";
import { loadOpenCode2Catalog } from "../../vendor/provider-opencode/src/server/openCode2Catalog.ts";
import * as OpenCode2Client from "@t3tools/provider-opencode/server/v2/OpenCode2Client";

const directory = "/exact/workspace";
const model = (id: string, enabled = true) => ({
  id,
  modelID: id,
  providerID: "opencode",
  name: id,
  package: "@opencode/ai/providers/openai-compatible",
  settings: {},
  compatibility: {},
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  variants: [{ id: "low" }, { id: "high" }],
  time: { released: 1 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: "active",
  enabled,
  limit: { context: 200000, output: 32000 },
});
const agent = (name: string) => ({
  id: name,
  name,
  mode: "primary",
  hidden: false,
  request: { settings: {}, headers: {}, body: {} },
  permissions: [],
});

const fixture = (
  options: {
    generation?: "v1" | "v2";
    username?: string;
    cold?: boolean;
    hangAfter?: Readonly<Record<string, number>>;
    onHang?: (path: string) => Effect.Effect<void>;
  } = {},
) => {
  const generation = options.generation ?? "v2";
  const version = generation === "v2" ? "2.0.26" : "1.19.2";
  const requests: Array<{ path: string; directory: string | null }> = [];
  const commands: unknown[] = [];
  const starts: Array<
    Parameters<OpenCodeRuntime.OpenCodeRuntime["Service"]["startOpenCodeServerProcess"]>[0]
  > = [];
  const active = new Set<string>();
  const interrupted: string[] = [];
  const requestCounts = new Map<string, number>();
  let modelReads = 0;
  const reply = (url: URL, authorizationHeader: string | null | undefined) => {
    requests.push({ path: url.pathname, directory: url.searchParams.get("location[directory]") });
    const password = starts.at(-1)?.environment?.OPENCODE_PASSWORD ?? "secret";
    const authorization = `Basic ${Buffer.from(`${options.username ?? "opencode"}:${password}`).toString("base64")}`;
    const envelope = (data: unknown) => ({ location: { directory }, data });
    const bodies: Record<string, unknown> = {
      "/api/info":
        generation === "v2"
          ? { version, pid: 42, urls: ["http://opencode.test"], paths: { tmp: "/tmp/opencode" } }
          : "<html>OpenCode</html>",
      "/global/health": { healthy: true, version },
      "/api/model": envelope(
        options.cold && url.pathname === "/api/model" && modelReads++ === 0
          ? []
          : [
              model("glm-5.3-flash-free"),
              model("deepseek-v4.1-flash-free"),
              model("disabled-model-free", false),
            ],
      ),
      "/api/provider": envelope([
        {
          id: "opencode",
          name: "OpenCode Zen",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: {},
        },
      ]),
      "/api/agent": envelope([agent("build"), agent("plan")]),
      "/api/config": [
        {
          type: "document",
          info: { model: "opencode/deepseek-v4.1-flash-free", default_agent: "build" },
        },
        { type: "directory", path: "/exact" },
        {
          type: "document",
          path: "/exact/workspace/opencode.json",
          info: { model: "opencode/glm-5.3-flash-free", default_agent: "plan" },
        },
      ],
    };
    const unauthorized = authorizationHeader !== authorization;
    const body = unauthorized
      ? { _tag: "UnauthorizedError", message: "Authentication required" }
      : bodies[url.pathname];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: unauthorized ? 401 : 200,
      headers: {
        "content-type": typeof body === "string" ? "text/html" : "application/json",
      },
    });
  };
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const count = (requestCounts.get(url.pathname) ?? 0) + 1;
      requestCounts.set(url.pathname, count);
      const hangAfter = options.hangAfter?.[url.pathname];
      if (hangAfter === undefined || count <= hangAfter)
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, reply(url, request.headers.authorization)),
        );
      requests.push({ path: url.pathname, directory: url.searchParams.get("location[directory]") });
      active.add(url.pathname);
      return (options.onHang?.(url.pathname) ?? Effect.void).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            active.delete(url.pathname);
            interrupted.push(url.pathname);
          }),
        ),
      );
    }),
  );
  const runtime = Layer.succeed(
    OpenCodeRuntime.OpenCodeRuntime,
    OpenCodeRuntime.OpenCodeRuntime.of({
      runOpenCodeCommand: (input) =>
        Effect.sync(() => {
          commands.push(input);
          return { stdout: `opencode v${version}`, stderr: "", code: 0 };
        }),
      startOpenCodeServerProcess: (input) =>
        Effect.gen(function* () {
          starts.push(input);
          const url = "http://opencode.test";
          const verified = input.verify ? yield* input.verify(url) : version;
          return {
            url,
            version: verified,
            isRunning: Effect.succeed(true),
            exitCode: Effect.never,
          };
        }),
      connectToOpenCodeServer: () => Effect.die("Unexpected V1 connection"),
      createOpenCodeSdkClient: () => {
        throw new Error("Unexpected V1 client");
      },
      loadOpenCodeInventory: () => Effect.die("Unexpected V1 inventory"),
      loadOpenCodeSkills: () => Effect.die("Unexpected V1 skills"),
      loadInventoryFromCli: () => Effect.die("Unexpected CLI inventory"),
      loadSkillsFromCli: () => Effect.die("Unexpected CLI skills"),
    }),
  );
  return {
    requests,
    commands,
    starts,
    reply,
    active,
    interrupted,
    requestCounts,
    layer: Layer.merge(runtime, http).pipe(Layer.provideMerge(NodeServices.layer)),
  };
};
const input = {
  binaryPath: "/missing/opencode",
  serverUrl: "http://opencode.test",
  serverPassword: "secret",
  cwd: directory,
  profileDirectory: "/unused/profile",
  environment: {},
};

it.effect("retains V2 input capabilities through the provider status catalog loader", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const opencode = yield* OpenCode2Client.make;
    const { client } = yield* opencode.connect({
      baseUrl: input.serverUrl,
      password: input.serverPassword,
    });
    const models = yield* loadOpenCode2Catalog(client, directory);
    assert.isAbove(models.length, 0);
    for (const listed of models) assert.deepEqual(listed.capabilities?.input, ["text", "image"]);
  }).pipe(Effect.provide(f.layer));
});

it.live(
  "reads V2 workspace models, variants, modalities and configured defaults without a local CLI",
  () => {
    const f = fixture({ cold: true });
    return Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* makeOpenCodeCatalog(input);
        assert.isNotNull(connection);
        const inventory = yield* connection!.inventory;
        assert.deepEqual(inventory.providers.connected, ["opencode"]);
        assert.equal(inventory.providers.all[0]!.name, "OpenCode Zen");
        assert.deepEqual(Object.keys(inventory.providers.all[0]!.models), [
          "glm-5.3-flash-free",
          "deepseek-v4.1-flash-free",
        ]);
        assert.deepEqual(
          Object.keys(inventory.providers.all[0]!.models["glm-5.3-flash-free"]!.variants ?? {}),
          ["low", "high"],
        );
        assert.deepEqual(
          inventory.providers.all[0]!.models["glm-5.3-flash-free"]!.capabilities.input,
          { text: true, image: true },
        );
        assert.deepEqual(inventory.config, {
          model: "opencode/glm-5.3-flash-free",
          default_agent: "plan",
        });
        assert.deepEqual(
          inventory.agents.map((entry) => entry.name),
          ["build", "plan"],
        );
        assert.deepEqual(f.commands, []);
        assert.deepEqual(f.starts, []);
        assert.isTrue(
          f.requests
            .filter(({ path }) => path !== "/api/info")
            .every((request) => request.directory === directory),
        );
        assert.equal(f.requests.filter(({ path }) => path === "/api/model").length, 2);
        assert.isFalse(f.requests.some(({ path }) => path.includes("session")));
      }),
    ).pipe(Effect.provide(f.layer));
  },
);

it.effect("leaves V1 external servers with the V1 SDK even when no CLI is installed", () => {
  const f = fixture({ generation: "v1", username: "custom-user" });
  return Effect.scoped(
    Effect.gen(function* () {
      assert.isNull(yield* makeOpenCodeCatalog({ ...input, serverUsername: "custom-user" }));
      assert.deepEqual(f.commands, []);
      assert.deepEqual(f.starts, []);
      assert.deepEqual(
        f.requests.map(({ path }) => path),
        ["/api/info", "/global/health"],
      );
    }),
  ).pipe(Effect.provide(f.layer));
});

it.effect("routes a local V2 CLI to an authenticated scoped metadata server", () => {
  const f = fixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* makeOpenCodeCatalog({
        ...input,
        serverUrl: null,
        environment: { MARKER: "instance" },
      });
      assert.isNotNull(connection);
      yield* connection!.inventory;
      assert.deepEqual(f.commands, [
        { binaryPath: input.binaryPath, args: ["--version"], environment: { MARKER: "instance" } },
      ]);
      assert.equal(f.starts.length, 1);
      assert.equal(f.starts[0]!.directory, directory);
      assert.equal(f.starts[0]!.environment?.MARKER, "instance");
      assert.isString(f.starts[0]!.environment?.OPENCODE_PASSWORD);
      assert.isUndefined(f.starts[0]!.environment?.OPENCODE_SERVER_PASSWORD);
    }),
  ).pipe(Effect.provide(f.layer));
});

it.effect("keeps a local V1 CLI on the V1 SDK path", () => {
  const f = fixture({ generation: "v1" });
  return Effect.scoped(
    Effect.gen(function* () {
      assert.isNull(yield* makeOpenCodeCatalog({ ...input, serverUrl: null }));
      assert.equal(f.commands.length, 1);
      assert.deepEqual(f.starts, []);
    }),
  ).pipe(Effect.provide(f.layer));
});

it.effect("reports rejected remote credentials without trying a local CLI", () => {
  const f = fixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const failure = yield* makeOpenCodeCatalog({ ...input, serverPassword: "wrong" }).pipe(
        Effect.flip,
      );
      assert.isTrue(failure.authenticationRequired);
      assert.deepEqual(f.commands, []);
      assert.deepEqual(f.starts, []);
    }),
  ).pipe(Effect.provide(f.layer));
});

it.effect("uses one explicit proxy identity for the V2 probe and inventory requests", () => {
  const f = fixture({ username: "proxy-user" });
  return Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* makeOpenCodeCatalog({ ...input, serverUsername: "proxy-user" });
      assert.isNotNull(connection);
      const inventory = yield* connection!.inventory;
      assert.equal(inventory.providers.all[0]!.name, "OpenCode Zen");
      assert.deepEqual(f.commands, []);
      assert.deepEqual(
        f.requests.map(({ path }) => path).sort(),
        [
          "/api/info",
          "/api/info",
          "/api/model",
          "/api/provider",
          "/api/agent",
          "/api/config",
        ].sort(),
      );
    }),
  ).pipe(Effect.provide(f.layer));
});

for (const path of ["/api/model", "/api/provider", "/api/agent", "/api/config"]) {
  it.effect(`bounds and cancels a pending ${path} inventory request`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const f = fixture({
          hangAfter: { [path]: 0 },
          onHang: () => Deferred.succeed(started, undefined),
        });
        return yield* Effect.gen(function* () {
          const connection = yield* makeOpenCodeCatalog(input);
          assert.isNotNull(connection);
          const pending = yield* connection!.inventory.pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(started);
          yield* TestClock.adjust("20 seconds");
          const failure = yield* Fiber.join(pending);
          assert.include(failure.message, "Timed out");
          assert.deepEqual([...f.active], []);
          assert.deepEqual(f.interrupted, path === "/api/model" ? [path, path] : [path]);
        }).pipe(Effect.provide(f.layer));
      }),
    ),
  );
}

it.effect("cancels the cold-catalog fallback request at the inventory deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = fixture({ cold: true, hangAfter: { "/api/model": 1 } });
      return yield* Effect.gen(function* () {
        const connection = yield* makeOpenCodeCatalog(input);
        assert.isNotNull(connection);
        const pending = yield* connection!.inventory.pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        assert.equal(f.requestCounts.get("/api/model"), 3);
        yield* TestClock.adjust("15 seconds");
        assert.include((yield* Fiber.join(pending)).message, "Timed out");
        assert.deepEqual([...f.active], []);
        assert.equal(f.interrupted.length, 2);
      }).pipe(Effect.provide(f.layer));
    }),
  ),
);

it.effect("interrupts all sibling metadata requests when inventory times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const paths = ["/api/provider", "/api/agent", "/api/config"];
      const started = yield* Deferred.make<void>();
      const seen = new Set<string>();
      const f = fixture({
        hangAfter: Object.fromEntries(paths.map((path) => [path, 0])),
        onHang: (path) => {
          seen.add(path);
          return seen.size === paths.length ? Deferred.succeed(started, undefined) : Effect.void;
        },
      });
      return yield* Effect.gen(function* () {
        const connection = yield* makeOpenCodeCatalog(input);
        assert.isNotNull(connection);
        const pending = yield* connection!.inventory.pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("20 seconds");
        assert.include((yield* Fiber.join(pending)).message, "Timed out");
        assert.deepEqual([...f.active], []);
        assert.deepEqual(f.interrupted.sort(), paths.sort());
      }).pipe(Effect.provide(f.layer));
    }),
  ),
);

it.live("provides host HTTP and Node capabilities at the public catalog entry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = fixture({ username: "proxy-user" });
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
            const url = new URL(
              typeof request === "string" || request instanceof URL ? request : request.url,
            );
            const headers = new Headers(
              init?.headers ?? (request instanceof Request ? request.headers : undefined),
            );
            return Promise.resolve(f.reply(url, headers.get("authorization")));
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const connection = yield* openOpenCodeCatalog({ ...input, serverUsername: "proxy-user" });
      assert.isNotNull(connection);
      assert.equal((yield* connection!.inventory).providers.all[0]!.name, "OpenCode Zen");
      assert.isFalse(f.requests.some(({ path }) => path.includes("session")));
    }),
  ),
);
