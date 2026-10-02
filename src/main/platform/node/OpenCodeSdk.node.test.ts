// @effect-diagnostics strictEffectProvide:off
import { createServer } from "node:http";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  OpenCodeSdk,
  nodeLive,
  openCodeEnvironment,
  openCodeSdkFailure,
  type OpenCodeLaunchInput,
} from "./OpenCodeSdk";

const launch: OpenCodeLaunchInput = {
  binaryPath: "opencode",
  serverUrl: null,
  cwd: "/project/exact",
  profileDirectory: "/profile/agent",
  environment: {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "moonshot/kimi-k3",
      provider: { moonshot: { options: { baseURL: "https://example.test" } } },
      mcp: { existing: { type: "local", command: ["existing"] } },
    }),
    OPENCODE_SERVER_PASSWORD: "ambient-password",
    OPENCODE_CONFIG: "/ambient/opencode.json",
    OPENCODE_AUTH_CONTENT: "ambient-native-auth",
    OPENCODE_TEST_HOME: "/ambient/native-home",
    HOME: "/host-home",
    MOONSHOT_API_KEY: "configured-key",
  },
};
const serverFixture = (
  eventStatus = 200,
  providerMetadata: unknown = { all: [], connected: [], default: {} },
  nativePolicy: {
    readonly version?: string;
    readonly createPrefix?: PermissionRuleset;
    readonly ignoreCreate?: boolean;
    readonly ignoreUpdate?: boolean;
    readonly shadowUpdate?: PermissionRuleset;
  } = {},
) =>
  Effect.gen(function* () {
    const eventsClosed = yield* Deferred.make<void>();
    let permission: PermissionRuleset = [{ permission: "*", pattern: "*", action: "ask" }];
    const session = () => ({ id: "ses_policy", directory: launch.cwd, permission });
    const received: {
      path: string;
      method: string | undefined;
      directory: string | null;
      authorization: string | undefined;
      before: string | null;
    }[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createServer>>((resume) => {
        const server = createServer((request, response) => {
          const url = new URL(request.url!, "http://localhost");
          received.push({
            path: url.pathname,
            method: request.method,
            directory: url.searchParams.get("directory"),
            authorization: request.headers.authorization,
            before: url.searchParams.get("before"),
          });
          response.setHeader("content-type", "application/json");
          response.statusCode = url.pathname === "/event" ? eventStatus : 200;
          if (response.statusCode !== 200) {
            response.end(
              JSON.stringify({ name: "NotFoundError", data: { message: "native missing" } }),
            );
            return;
          }
          if (url.pathname === "/event") {
            response.once("close", () => Deferred.doneUnsafe(eventsClosed, Effect.void));
            response.setHeader("content-type", "text/event-stream");
            response.write(
              `data: ${JSON.stringify({ id: "evt_connected", type: "server.connected", properties: {} })}\n\n`,
            );
            return;
          }
          if (url.pathname === "/session/ses_history/message") {
            if (!url.searchParams.has("before"))
              response.setHeader("X-Next-Cursor", "opaque-native-cursor");
            response.end("[]");
            return;
          }
          if (
            (url.pathname === "/session" && request.method === "POST") ||
            (url.pathname === "/session/ses_policy" && request.method === "PATCH")
          ) {
            let body = "";
            request.on("data", (chunk: Buffer) => {
              body += chunk.toString();
            });
            request.on("end", () => {
              const requested = (JSON.parse(body) as { permission: PermissionRuleset }).permission;
              const creating = request.method === "POST";
              if (creating && !nativePolicy.ignoreCreate)
                permission = [...(nativePolicy.createPrefix ?? []), ...requested];
              if (!creating && !nativePolicy.ignoreUpdate)
                permission = [...permission, ...requested, ...(nativePolicy.shadowUpdate ?? [])];
              // The update response may claim success while the subsequent read stays unchanged.
              response.end(
                JSON.stringify(creating ? session() : { ...session(), permission: requested }),
              );
            });
            return;
          }
          if (url.pathname === "/session/ses_policy") {
            response.end(JSON.stringify(session()));
            return;
          }
          const value =
            url.pathname === "/global/health"
              ? { healthy: true, version: nativePolicy.version ?? "1.15.13" }
              : url.pathname === "/session/status"
                ? { ses_active: { type: "busy" }, ses_idle: { type: "idle" } }
                : url.pathname === "/provider"
                  ? providerMetadata
                  : url.pathname === "/agent" || url.pathname === "/command"
                    ? []
                    : {};
          response.end(JSON.stringify(value));
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.closeAllConnections();
          server.close(() => resume(Effect.void));
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      return yield* Effect.die("Missing test server port");
    return {
      url: `http://127.0.0.1:${address.port}`,
      received,
      eventsClosed: Deferred.await(eventsClosed),
      disconnect: Effect.sync(() => server.closeAllConnections()),
    };
  });

it.effect(
  "an instance profile excludes ambient native config and auth while retaining provider keys and scoped app tools",
  () =>
    Effect.gen(function* () {
      const environment = openCodeEnvironment({
        ...launch,
        nativeMcp: { nodex: { type: "local", command: ["nodex-tools"] } },
      });
      expect(environment).toMatchObject({
        XDG_DATA_HOME: "/profile/agent/data",
        XDG_CONFIG_HOME: "/profile/agent/config",
        XDG_CACHE_HOME: "/profile/agent/cache",
        XDG_STATE_HOME: "/profile/agent/state",
        OPENCODE_CONFIG_DIR: "/profile/agent/config/opencode",
        OPENCODE_TEST_HOME: "/profile/agent",
        HOME: "/host-home",
        MOONSHOT_API_KEY: "configured-key",
      });
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          environment.OPENCODE_CONFIG_CONTENT!,
        ),
      ).toMatchObject({
        mcp: { nodex: { command: ["nodex-tools"] } },
      });
      expect(environment.OPENCODE_AUTH_CONTENT).toBeUndefined();
      expect(environment.OPENCODE_CONFIG).toBeUndefined();
      expect(openCodeEnvironment(launch).OPENCODE_CONFIG_CONTENT).toBeUndefined();
    }),
);
it.effect(
  "native HTTP inventory uses exact cwd and creates no conversation or ambient external authentication",
  () =>
    Effect.gen(function* () {
      const server = yield* serverFixture();
      const sdk = yield* OpenCodeSdk;
      const connection = yield* sdk.open({ ...launch, serverUrl: server.url });
      const firstId = yield* connection.nextMessageId;
      const secondId = yield* connection.nextMessageId;
      expect(firstId).toMatch(/^msg_[A-Za-z0-9]{26}$/u);
      expect(firstId < secondId).toBe(true);
      yield* connection.inventory;
      expect(server.received.map((request) => request.path).sort()).toEqual([
        "/agent",
        "/command",
        "/config",
        "/global/health",
        "/provider",
      ]);
      expect(
        server.received.every(
          (request) => request.directory === launch.cwd && request.authorization === undefined,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(nodeLive)),
);
it.effect("external credentials are explicit and SSE is scoped to the same directory", () =>
  Effect.gen(function* () {
    const server = yield* serverFixture();
    const sdk = yield* OpenCodeSdk;
    const connection = yield* sdk.open({
      ...launch,
      serverUrl: server.url,
      serverPassword: "configured",
      serverUsername: "configured-user",
    });
    yield* connection.events.pipe(Stream.take(1), Stream.runDrain);
    yield* connection.ready;
    expect(server.received.find((request) => request.path === "/event")).toEqual({
      path: "/event",
      method: "GET",
      directory: launch.cwd,
      authorization: `Basic ${Buffer.from("configured-user:configured").toString("base64")}`,
      before: null,
    });
  }).pipe(Effect.provide(nodeLive)),
);
it.effect(
  "unsupported native model metadata reports the runtime version and a concrete upgrade",
  () =>
    Effect.gen(function* () {
      const server = yield* serverFixture(200, {
        all: [
          { id: "provider", name: "Provider", models: { older: { id: "older", name: "Older" } } },
        ],
        connected: ["provider"],
        default: { provider: "older" },
      });
      const sdk = yield* OpenCodeSdk;
      const connection = yield* sdk.open({ ...launch, serverUrl: server.url });
      const result = yield* connection.inventory.pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "protocol",
          operation: "opencode.inventory",
          message: expect.stringContaining(
            "Update the configured executable or server to OpenCode 1.15.13",
          ),
        },
      });
      expect(result._tag === "Failure" && result.failure.message).toContain("OpenCode 1.15.13");
      expect(server.received.some((request) => request.path === "/session")).toBe(false);
    }).pipe(Effect.provide(nodeLive)),
);
it.effect("native history retains the server's opaque pagination cursor", () =>
  Effect.gen(function* () {
    const server = yield* serverFixture();
    const sdk = yield* OpenCodeSdk;
    const connection = yield* sdk.open({ ...launch, serverUrl: server.url });
    const first = yield* connection.history("ses_history", { limit: 20 });
    expect(first).toEqual({ messages: [], cursor: "opaque-native-cursor", hasMore: true });
    const next = yield* connection.history("ses_history", { limit: 20, before: first.cursor! });
    expect(next).toEqual({ messages: [], cursor: null, hasMore: false });
    expect(server.received.at(-1)?.before).toBe("opaque-native-cursor");
  }).pipe(Effect.provide(nodeLive)),
);
it.live.each(["interrupt", "scope close"] as const)(
  "an open native SSE response releases its consumer and fetch on %s",
  (release) =>
    Effect.gen(function* () {
      const server = yield* serverFixture();
      const sdk = yield* OpenCodeSdk;
      const connectionScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(connectionScope, Exit.void));
      const connection = yield* sdk
        .open({ ...launch, serverUrl: server.url })
        .pipe(Scope.provide(connectionScope));
      const consumer = yield* connection.events.pipe(
        Stream.runDrain,
        Effect.forkIn(connectionScope),
      );
      yield* connection.ready;
      yield* Effect.yieldNow;
      const released = yield* (
        release === "interrupt"
          ? Fiber.interrupt(consumer)
          : Scope.close(connectionScope, Exit.void)
      ).pipe(
        Effect.as(true),
        // A stuck finalizer must still release the HTTP fixture before the assertion fails.
        Effect.raceFirst(
          Effect.sleep("1 second").pipe(Effect.andThen(server.disconnect), Effect.as(false)),
        ),
      );
      expect(released).toBe(true);
      expect(Exit.isFailure(yield* Fiber.await(consumer))).toBe(true);
      yield* server.eventsClosed.pipe(Effect.timeout("1 second"));
      expect(server.received.filter((request) => request.path === "/event")).toHaveLength(1);
    }).pipe(Effect.provide(nodeLive)),
);
it.effect("native SSE request failures retain the SDK error without reconnecting", () =>
  Effect.gen(function* () {
    const server = yield* serverFixture(503);
    const sdk = yield* OpenCodeSdk;
    const connection = yield* sdk.open({ ...launch, serverUrl: server.url });
    const error = yield* connection.events.pipe(Stream.runDrain, Effect.flip);
    expect(error.operation).toBe("opencode.events");
    expect(error.message).toContain("SSE failed: 503");
    expect(error.retryable).toBe(true);
    expect(server.received.filter((request) => request.path === "/event")).toHaveLength(1);
  }).pipe(Effect.provide(nodeLive)),
);
it.effect("native session statuses retain exact directory and native active state", () =>
  Effect.gen(function* () {
    const server = yield* serverFixture();
    const sdk = yield* OpenCodeSdk;
    const connection = yield* sdk.open({ ...launch, serverUrl: server.url });
    expect(yield* connection.sessionStatuses).toEqual({
      ses_active: { type: "busy" },
      ses_idle: { type: "idle" },
    });
    expect(server.received.at(-1)).toMatchObject({
      path: "/session/status",
      directory: launch.cwd,
    });
  }).pipe(Effect.provide(nodeLive)),
);
const askPolicy: PermissionRuleset = [
  { permission: "*", pattern: "*", action: "ask" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "read", pattern: "*.env", action: "ask" },
  { permission: "read", pattern: "*.env.*", action: "ask" },
];
it.effect.each([[], [{ permission: "*", pattern: "*", action: "deny" }]] as PermissionRuleset[])(
  "native session creation retains the requested policy after prefix %j",
  (createPrefix) =>
    Effect.gen(function* () {
      const server = yield* serverFixture(200, undefined, { createPrefix });
      const sdk = yield* OpenCodeSdk;
      const connection = yield* sdk.open({ ...launch, serverUrl: server.url });
      const session = yield* connection.createSession(askPolicy);
      expect(session.id).toBe("ses_policy");
      expect(session.permission?.at(-1)).toEqual(askPolicy.at(-1));
    }).pipe(Effect.provide(nodeLive)),
);
it.effect("native permission updates verify persisted rules with last matching precedence", () =>
  Effect.gen(function* () {
    const server = yield* serverFixture();
    const sdk = yield* OpenCodeSdk;
    const connection = yield* sdk.open({ ...launch, serverUrl: server.url });
    const session = yield* connection.createSession(askPolicy);
    yield* connection.setPermissions(session.id, [
      { permission: "*", pattern: "*", action: "allow" },
    ]);
    yield* connection.setPermissions(session.id, askPolicy);
    expect(server.received.slice(-4).map(({ method, path }) => [method, path])).toEqual([
      ["PATCH", "/session/ses_policy"],
      ["GET", "/session/ses_policy"],
      ["PATCH", "/session/ses_policy"],
      ["GET", "/session/ses_policy"],
    ]);
  }).pipe(Effect.provide(nodeLive)),
);
it.effect("ignored creation policies fail before the native session is admitted", () =>
  Effect.gen(function* () {
    const server = yield* serverFixture(200, undefined, { ignoreCreate: true, version: "1.2.24" });
    const sdk = yield* OpenCodeSdk;
    const connection = yield* sdk.open({ ...launch, serverUrl: server.url });
    const error = yield* connection
      .createSession([{ permission: "*", pattern: "*", action: "allow" }])
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      reason: "protocol",
      operation: "opencode.create-session",
      retryable: false,
    });
    expect(error.message).toContain("OpenCode 1.2.24");
    expect(error.message).toContain(
      "Update the configured executable or server to OpenCode 1.15.13",
    );
  }).pipe(Effect.provide(nodeLive)),
);
it.effect.each([
  { ignoreUpdate: true, version: "1.2.24" },
  {
    shadowUpdate: [{ permission: "*", pattern: "*", action: "deny" }] as PermissionRuleset,
    version: "1.15.13",
  },
])("unretained native permission updates fail closed for %j", (nativePolicy) =>
  Effect.gen(function* () {
    const server = yield* serverFixture(200, undefined, nativePolicy);
    const sdk = yield* OpenCodeSdk;
    const connection = yield* sdk.open({ ...launch, serverUrl: server.url });
    const session = yield* connection.createSession(askPolicy);
    const error = yield* connection
      .setPermissions(session.id, [{ permission: "*", pattern: "*", action: "allow" }])
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      reason: "protocol",
      operation: "opencode.permissions",
      retryable: false,
      sessionId: session.id,
    });
    expect(error.message).toContain(`OpenCode ${nativePolicy.version}`);
    expect(error.message).toContain(
      "Update the configured executable or server to OpenCode 1.15.13",
    );
    expect(server.received.at(-1)).toMatchObject({ method: "GET", path: "/session/ses_policy" });
  }).pipe(Effect.provide(nodeLive)),
);
it.effect("native HTTP missing-session status remains distinguishable from transport failure", () =>
  Effect.sync(() => {
    const missing = openCodeSdkFailure(
      "get-session",
      new Error("native missing", { cause: { status: 404 } }),
    );
    expect(missing.reason).toBe("resource-not-found");
    expect(missing.retryable).toBe(false);
    expect(
      openCodeSdkFailure("health", new Error("Unauthorized", { cause: { status: 401 } })).reason,
    ).toBe("authentication-required");
  }),
);
