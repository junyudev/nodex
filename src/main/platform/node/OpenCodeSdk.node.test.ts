// @effect-diagnostics strictEffectProvide:off
import { createServer } from "node:http";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
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
const serverFixture = (providerMetadata: unknown = { all: [], connected: [], default: {} }) =>
  Effect.gen(function* () {
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
          if (url.pathname === "/session/ses_history/message") {
            if (!url.searchParams.has("before"))
              response.setHeader("X-Next-Cursor", "opaque-native-cursor");
            response.end("[]");
            return;
          }
          const value =
            url.pathname === "/global/health"
              ? { healthy: true, version: "1.15.13" }
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
      disconnect: Effect.sync(() => server.closeAllConnections()),
    };
  });

it.effect(
  "an instance profile excludes ambient native config and auth while retaining provider keys for metadata reads",
  () =>
    Effect.sync(() => {
      const environment = openCodeEnvironment(launch);
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
it.effect("external history credentials are explicit and scoped to the saved directory", () =>
  Effect.gen(function* () {
    const server = yield* serverFixture();
    const sdk = yield* OpenCodeSdk;
    const connection = yield* sdk.open({
      ...launch,
      serverUrl: server.url,
      serverPassword: "configured",
      serverUsername: "configured-user",
    });
    yield* connection.history("ses_history", { limit: 20 });
    expect(
      server.received.find((request) => request.path === "/session/ses_history/message"),
    ).toEqual({
      path: "/session/ses_history/message",
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
      const server = yield* serverFixture({
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
