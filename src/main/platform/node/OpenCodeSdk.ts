import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createOpencodeClient,
  type Agent,
  type Command,
  type Config,
  type Message,
  type Part,
  type ProviderListResponse,
} from "@opencode-ai/sdk/v2";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentRuntimeError } from "../../agent-backend/AgentRuntimeError";
import { OPENCODE_MANAGED_ENVIRONMENT_NAMES } from "../../../shared/opencode-agent-settings";

export interface OpenCodeLaunchInput {
  readonly binaryPath: string;
  readonly serverUrl: string | null;
  readonly cwd: string;
  readonly profileDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Only explicitly configured credentials may authenticate an external server. */
  readonly serverPassword?: string;
  readonly serverUsername?: string;
}
export interface OpenCodeInventory {
  readonly providers: ProviderListResponse;
  readonly agents: readonly Agent[];
  readonly commands: readonly Command[];
  readonly config: Config;
  readonly version: string;
}
// Check the native metadata Nodex consumes without decoding another protocol model.
const inventoryMetadata = Schema.Struct({
  providers: Schema.Struct({
    all: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        models: Schema.Record(
          Schema.String,
          Schema.Struct({
            id: Schema.String,
            providerID: Schema.String,
            name: Schema.String,
            capabilities: Schema.Struct({
              input: Schema.Struct({ text: Schema.Boolean, image: Schema.Boolean }),
            }),
            limit: Schema.Struct({ context: Schema.Finite }),
            variants: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
          }),
        ),
      }),
    ),
    connected: Schema.Array(Schema.String),
    default: Schema.Record(Schema.String, Schema.String),
  }),
  agents: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      mode: Schema.Literals(["primary", "subagent", "all"]),
      hidden: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  commands: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.optionalKey(Schema.String) }),
  ),
  config: Schema.Struct({
    model: Schema.optionalKey(Schema.String),
    default_agent: Schema.optionalKey(Schema.String),
  }),
});
export interface OpenCodeNativeMessage {
  readonly info: Message;
  readonly parts: readonly Part[];
}
export interface OpenCodeHistoryPage {
  readonly messages: readonly OpenCodeNativeMessage[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
}
export interface OpenCodeConnection {
  readonly inventory: Effect.Effect<OpenCodeInventory, AgentRuntimeError>;
  readonly history: (
    id: string,
    input?: { readonly before?: string; readonly limit?: number },
  ) => Effect.Effect<OpenCodeHistoryPage, AgentRuntimeError>;
  readonly message: (
    sessionId: string,
    messageId: string,
  ) => Effect.Effect<OpenCodeNativeMessage, AgentRuntimeError>;
}
export class OpenCodeSdk extends Context.Service<
  OpenCodeSdk,
  {
    readonly open: (
      input: OpenCodeLaunchInput,
    ) => Effect.Effect<OpenCodeConnection, AgentRuntimeError, Scope.Scope>;
  }
>()("nodex/main/platform/node/OpenCodeSdk") {}

export const openCodeSdkFailure = (operation: string, cause: unknown): AgentRuntimeError => {
  if (Schema.is(AgentRuntimeError)(cause)) return cause;
  const status =
    cause instanceof Error &&
    typeof cause.cause === "object" &&
    cause.cause !== null &&
    "status" in cause.cause
      ? cause.cause.status
      : undefined;
  return new AgentRuntimeError({
    message: `OpenCode ${operation}: ${cause instanceof Error ? cause.message : "request failed"}`,
    operation: `opencode.${operation}`,
    reason:
      status === 401 || status === 403
        ? "authentication-required"
        : status === 404
          ? "resource-not-found"
          : "request",
    retryable: status === undefined || (typeof status === "number" && status >= 500),
    ...(typeof status === "number" ? { protocolCode: status } : {}),
    cause,
  });
};

/** The profile owns native auth, config, transcript, and cache paths together. */
export const openCodeEnvironment = (
  input: OpenCodeLaunchInput,
): Record<string, string | undefined> => {
  const environment: Record<string, string | undefined> = {
    ...Object.fromEntries(
      Object.entries(input.environment).filter(
        ([name]) =>
          name.toUpperCase() === "HOME" ||
          !OPENCODE_MANAGED_ENVIRONMENT_NAMES.has(name.toUpperCase()),
      ),
    ),
    XDG_DATA_HOME: join(input.profileDirectory, "data"),
    XDG_CONFIG_HOME: join(input.profileDirectory, "config"),
    XDG_CACHE_HOME: join(input.profileDirectory, "cache"),
    XDG_STATE_HOME: join(input.profileDirectory, "state"),
    OPENCODE_CONFIG_DIR: join(input.profileDirectory, "config", "opencode"),
    OPENCODE_TEST_HOME: input.profileDirectory,
    OPENCODE_SERVER_USERNAME: "opencode",
  };
  return environment;
};

const request = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => openCodeSdkFailure(operation, cause) });

export const live = Layer.effect(
  OpenCodeSdk,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return OpenCodeSdk.of({
      open: Effect.fn("OpenCodeSdk.open")(function* (input) {
        let baseUrl = input.serverUrl;
        let password = input.serverPassword;
        let termination: Effect.Effect<never, AgentRuntimeError> = Effect.never;
        if (!baseUrl) {
          const environment = yield* Effect.try({
            try: () => openCodeEnvironment(input),
            catch: (cause) => openCodeSdkFailure("configuration", cause),
          });
          password =
            password ??
            environment.OPENCODE_SERVER_PASSWORD ??
            randomBytes(24).toString("base64url");
          const process = yield* spawner
            .spawn(
              ChildProcess.make(input.binaryPath, ["serve", "--hostname=127.0.0.1", "--port=0"], {
                cwd: input.cwd,
                env: { ...environment, OPENCODE_SERVER_PASSWORD: password },
                extendEnv: false,
                shell: false,
                killSignal: "SIGTERM",
                forceKillAfter: "3 seconds",
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AgentRuntimeError({
                    message: `OpenCode could not start: ${cause.message}`,
                    operation: "opencode.spawn",
                    reason: "spawn",
                    retryable: true,
                    cause,
                  }),
              ),
            );
          const ready = yield* Deferred.make<string, AgentRuntimeError>();
          termination = process.exitCode.pipe(
            Effect.mapError((cause) => openCodeSdkFailure("wait", cause)),
            Effect.flatMap((code) =>
              Effect.fail(
                new AgentRuntimeError({
                  message: `OpenCode server exited with code ${code}`,
                  operation: "opencode.exit",
                  reason: "session-lost",
                  retryable: true,
                  pid: Number(process.pid),
                }),
              ),
            ),
          );
          yield* process.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) => {
              const url = line.match(
                /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/,
              )?.[1];
              return url ? Deferred.succeed(ready, url).pipe(Effect.asVoid) : Effect.void;
            }),
            Effect.forkScoped,
          );
          yield* process.stderr.pipe(Stream.runDrain, Effect.forkScoped);
          baseUrl = yield* Effect.raceFirst(Deferred.await(ready), termination).pipe(
            Effect.timeout("20 seconds"),
            Effect.mapError((cause) => openCodeSdkFailure("startup", cause)),
          );
        }
        const client = createOpencodeClient({
          baseUrl,
          directory: input.cwd,
          throwOnError: true,
          headers: password
            ? {
                Authorization: `Basic ${Buffer.from(`${input.serverUrl ? (input.serverUsername ?? "opencode") : "opencode"}:${password}`).toString("base64")}`,
              }
            : {},
        });
        const health = yield* request("health", (signal) =>
          client.global.health({ signal, throwOnError: true }),
        );
        if (!health.data?.healthy)
          return yield* openCodeSdkFailure("health", new Error("server is unhealthy"));
        const call = <A>(operation: string, run: (signal: AbortSignal) => Promise<{ data: A }>) =>
          request(operation, run).pipe(Effect.map((result) => result.data));
        return {
          inventory: Effect.gen(function* () {
            const [providers, agents, commands, config] = yield* Effect.all(
              [
                call("providers", (signal) =>
                  client.provider.list({}, { signal, throwOnError: true }),
                ),
                call("agents", (signal) => client.app.agents({}, { signal, throwOnError: true })),
                call("commands", (signal) =>
                  client.command.list({}, { signal, throwOnError: true }),
                ),
                call("config", (signal) => client.config.get({}, { signal, throwOnError: true })),
              ],
              { concurrency: 4 },
            );
            const inventory = { providers, agents, commands, config, version: health.data.version };
            if (!Schema.is(inventoryMetadata)(inventory))
              return yield* new AgentRuntimeError({
                message: `OpenCode ${health.data.version} cannot provide the model metadata Nodex requires. Update the configured executable or server to OpenCode 1.15.13 or newer.`,
                operation: "opencode.inventory",
                reason: "protocol",
                retryable: false,
              });
            return inventory;
          }),
          history: (sessionID, input) =>
            request("history", (signal) =>
              client.session.messages({ sessionID, ...input }, { signal, throwOnError: true }),
            ).pipe(
              Effect.map((result) => {
                const cursor = result.response.headers.get("x-next-cursor");
                return { messages: result.data, cursor, hasMore: cursor !== null };
              }),
            ),
          message: (sessionID, messageID) =>
            call("message", (signal) =>
              client.session.message({ sessionID, messageID }, { signal, throwOnError: true }),
            ),
        } satisfies OpenCodeConnection;
      }),
    });
  }),
);
export const nodeLive = live.pipe(Layer.provide(NodeServices.layer));
