import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createOpencodeClient,
  type Agent,
  type Command,
  type Config,
  type Event,
  type Message,
  type Part,
  type PermissionRequest,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionRequest,
  type Session,
  type SessionStatusResponse,
} from "@opencode-ai/sdk/v2";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentRuntimeError } from "../../agent-backend/AgentRuntimeError";
import { OPENCODE_MANAGED_ENVIRONMENT_NAMES } from "../../../shared/opencode-agent-settings";

export type OpenCodeNativeMcp = NonNullable<Config["mcp"]>;
export interface OpenCodeLaunchInput {
  readonly binaryPath: string;
  readonly serverUrl: string | null;
  readonly cwd: string;
  readonly profileDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Only explicitly configured credentials may authenticate an external server. */
  readonly serverPassword?: string;
  readonly serverUsername?: string;
  readonly nativeMcp?: OpenCodeNativeMcp;
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
const permissionMetadata = Schema.Array(
  Schema.Struct({
    permission: Schema.String,
    pattern: Schema.String,
    action: Schema.Literals(["allow", "ask", "deny"]),
  }),
);

// Native updates append rules; their requested suffix must retain last-match precedence.
const retainsPermissionPolicy = (session: Session, requested: PermissionRuleset): boolean => {
  const stored = session.permission;
  if (!Schema.is(permissionMetadata)(stored) || stored.length < requested.length) return false;
  return requested.every((rule, index) => {
    const retained = stored[stored.length - requested.length + index];
    return (
      retained?.permission === rule.permission &&
      retained.pattern === rule.pattern &&
      retained.action === rule.action
    );
  });
};
export interface OpenCodeNativeMessage {
  readonly info: Message;
  readonly parts: readonly Part[];
}
export interface OpenCodeHistoryPage {
  readonly messages: readonly OpenCodeNativeMessage[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
}
export interface OpenCodePromptInput {
  readonly sessionId: string;
  readonly messageId: string;
  readonly text: string;
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly variant?: string;
  readonly agent?: string;
  readonly system?: string;
  readonly command?: { readonly name: string; readonly arguments: string };
  readonly images?: readonly { readonly mediaType: string; readonly data: string }[];
}
export interface OpenCodeConnection {
  readonly nextMessageId: Effect.Effect<string>;
  readonly inventory: Effect.Effect<OpenCodeInventory, AgentRuntimeError>;
  readonly events: Stream.Stream<Event, AgentRuntimeError>;
  readonly ready: Effect.Effect<void, AgentRuntimeError>;
  readonly termination: Effect.Effect<never, AgentRuntimeError>;
  readonly createSession: (
    permission: PermissionRuleset,
  ) => Effect.Effect<Session, AgentRuntimeError>;
  readonly session: (id: string) => Effect.Effect<Session, AgentRuntimeError>;
  readonly sessionStatuses: Effect.Effect<SessionStatusResponse, AgentRuntimeError>;
  readonly history: (
    id: string,
    input?: { readonly before?: string; readonly limit?: number },
  ) => Effect.Effect<OpenCodeHistoryPage, AgentRuntimeError>;
  readonly message: (
    sessionId: string,
    messageId: string,
  ) => Effect.Effect<OpenCodeNativeMessage, AgentRuntimeError>;
  readonly prompt: (input: OpenCodePromptInput) => Effect.Effect<void, AgentRuntimeError>;
  readonly abort: (id: string) => Effect.Effect<void, AgentRuntimeError>;
  readonly children: (id: string) => Effect.Effect<readonly Session[], AgentRuntimeError>;
  readonly setPermissions: (
    id: string,
    permission: PermissionRuleset,
  ) => Effect.Effect<void, AgentRuntimeError>;
  readonly pendingPermissions: Effect.Effect<readonly PermissionRequest[], AgentRuntimeError>;
  readonly pendingQuestions: Effect.Effect<readonly QuestionRequest[], AgentRuntimeError>;
  readonly replyPermission: (
    id: string,
    reply: "once" | "reject",
  ) => Effect.Effect<void, AgentRuntimeError>;
  readonly replyQuestion: (
    id: string,
    answers: string[][],
  ) => Effect.Effect<void, AgentRuntimeError>;
  readonly rejectQuestion: (id: string) => Effect.Effect<void, AgentRuntimeError>;
  readonly fork: (id: string, messageId: string) => Effect.Effect<Session, AgentRuntimeError>;
  readonly compact: (
    id: string,
    model: OpenCodePromptInput["model"],
  ) => Effect.Effect<void, AgentRuntimeError>;
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
  if (!input.nativeMcp) return environment;
  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: input.nativeMcp }),
  };
};

const request = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => openCodeSdkFailure(operation, cause) });

export const live = Layer.effect(
  OpenCodeSdk,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return OpenCodeSdk.of({
      open: Effect.fn("OpenCodeSdk.open")(function* (input) {
        if (input.serverUrl && input.nativeMcp && Object.keys(input.nativeMcp).length > 0) {
          return yield* new AgentRuntimeError({
            message: "An external OpenCode server cannot isolate this thread's app tools",
            operation: "opencode.open",
            reason: "capability",
            retryable: false,
          });
        }
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
        const abortController = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        );
        let streamError: AgentRuntimeError | null = null;
        const stream = yield* request("events", () =>
          client.event.subscribe(
            {},
            {
              signal: abortController.signal,
              throwOnError: true,
              sseMaxRetryAttempts: 1,
              onSseError: (cause) => {
                streamError = openCodeSdkFailure("events", cause);
              },
            },
          ),
        );
        const connected = yield* Deferred.make<void, AgentRuntimeError>();
        const events = Stream.fromAsyncIterable(
          {
            [Symbol.asyncIterator]: () => ({
              next: () => stream.stream.next(),
              return: () => {
                // A pending SDK read must abort before generator return can complete.
                abortController.abort();
                return stream.stream.return();
              },
            }),
          },
          (cause) => openCodeSdkFailure("events", cause),
        ).pipe(
          Stream.tap((event) =>
            event.type === "server.connected"
              ? Deferred.succeed(connected, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Stream.concat(
            Stream.suspend(() =>
              Stream.fail(
                streamError ??
                  new AgentRuntimeError({
                    message: "The OpenCode event connection closed",
                    operation: "opencode.events",
                    reason: "session-lost",
                    retryable: true,
                  }),
              ),
            ),
          ),
        );
        const call = <A>(operation: string, run: (signal: AbortSignal) => Promise<{ data: A }>) =>
          request(operation, run).pipe(Effect.map((result) => result.data));
        const confirmPermissions = (
          operation: string,
          session: Session,
          permission: PermissionRuleset,
        ) =>
          retainsPermissionPolicy(session, permission)
            ? Effect.void
            : Effect.fail(
                new AgentRuntimeError({
                  message: `OpenCode ${health.data.version} did not retain the permission policy Nodex requires. Update the configured executable or server to OpenCode 1.15.13 or newer.`,
                  operation: `opencode.${operation}`,
                  reason: "protocol",
                  retryable: false,
                  sessionId: session.id,
                }),
              );
        let lastTimestamp = 0;
        let messageCounter = 0;
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
          events,
          ready: Deferred.await(connected).pipe(
            Effect.timeout("10 seconds"),
            Effect.mapError((cause) => openCodeSdkFailure("events-connect", cause)),
          ),
          termination,
          nextMessageId: Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              if (now !== lastTimestamp) {
                lastTimestamp = now;
                messageCounter = 0;
              }
              messageCounter += 1;
              const prefix = ((BigInt(now) * 0x1000n + BigInt(messageCounter)) & 0xffffffffffffn)
                .toString(16)
                .padStart(12, "0");
              return `msg_${prefix}${randomBytes(7).toString("hex")}`;
            }),
          ),
          createSession: Effect.fn("OpenCodeSdk.createSession")(function* (
            permission: PermissionRuleset,
          ) {
            const session = yield* call("create-session", (signal) =>
              client.session.create({ permission }, { signal, throwOnError: true }),
            );
            yield* confirmPermissions("create-session", session, permission);
            return session;
          }),
          session: (sessionID) =>
            call("get-session", (signal) =>
              client.session.get({ sessionID }, { signal, throwOnError: true }),
            ),
          sessionStatuses: call("session-statuses", (signal) =>
            client.session.status({}, { signal, throwOnError: true }),
          ),
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
          prompt: (input) =>
            request<unknown>("prompt", (signal) =>
              input.command
                ? client.session.command(
                    {
                      sessionID: input.sessionId,
                      messageID: input.messageId,
                      command: input.command.name,
                      arguments: input.command.arguments,
                      model: `${input.model.providerID}/${input.model.modelID}`,
                      ...(input.variant ? { variant: input.variant } : {}),
                      ...(input.agent ? { agent: input.agent } : {}),
                      parts: (input.images ?? []).map((image) => ({
                        type: "file" as const,
                        mime: image.mediaType,
                        url: `data:${image.mediaType};base64,${image.data}`,
                      })),
                    },
                    { signal, throwOnError: true },
                  )
                : client.session.promptAsync(
                    {
                      sessionID: input.sessionId,
                      messageID: input.messageId,
                      model: input.model,
                      ...(input.variant ? { variant: input.variant } : {}),
                      ...(input.agent ? { agent: input.agent } : {}),
                      ...(input.system ? { system: input.system } : {}),
                      parts: [
                        { type: "text", text: input.text },
                        ...(input.images ?? []).map((image) => ({
                          type: "file" as const,
                          mime: image.mediaType,
                          url: `data:${image.mediaType};base64,${image.data}`,
                        })),
                      ],
                    },
                    { signal, throwOnError: true },
                  ),
            ).pipe(Effect.asVoid),
          abort: (sessionID) =>
            request("abort", (signal) =>
              client.session.abort({ sessionID }, { signal, throwOnError: true }),
            ).pipe(Effect.asVoid),
          children: (sessionID) =>
            call("children", (signal) =>
              client.session.children({ sessionID }, { signal, throwOnError: true }),
            ),
          setPermissions: Effect.fn("OpenCodeSdk.setPermissions")(function* (
            sessionID: string,
            permission: PermissionRuleset,
          ) {
            yield* request("permissions", (signal) =>
              client.session.update({ sessionID, permission }, { signal, throwOnError: true }),
            );
            const session = yield* call("get-session", (signal) =>
              client.session.get({ sessionID }, { signal, throwOnError: true }),
            );
            yield* confirmPermissions("permissions", session, permission);
          }),
          pendingPermissions: call("pending-permissions", (signal) =>
            client.permission.list({}, { signal, throwOnError: true }),
          ),
          pendingQuestions: call("pending-questions", (signal) =>
            client.question.list({}, { signal, throwOnError: true }),
          ),
          replyPermission: (requestID, reply) =>
            request("permission-reply", (signal) =>
              client.permission.reply({ requestID, reply }, { signal, throwOnError: true }),
            ).pipe(Effect.asVoid),
          replyQuestion: (requestID, answers) =>
            request("question-reply", (signal) =>
              client.question.reply({ requestID, answers }, { signal, throwOnError: true }),
            ).pipe(Effect.asVoid),
          rejectQuestion: (requestID) =>
            request("question-reject", (signal) =>
              client.question.reject({ requestID }, { signal, throwOnError: true }),
            ).pipe(Effect.asVoid),
          fork: (sessionID, messageID) =>
            call("fork", (signal) =>
              client.session.fork({ sessionID, messageID }, { signal, throwOnError: true }),
            ),
          compact: (sessionID, model) =>
            request("compact", (signal) =>
              client.session.summarize(
                { sessionID, ...model, auto: false },
                { signal, throwOnError: true },
              ),
            ).pipe(Effect.asVoid),
        } satisfies OpenCodeConnection;
      }),
    });
  }),
);
export const nodeLive = live.pipe(Layer.provide(NodeServices.layer));
