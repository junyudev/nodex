import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProviderReplayTranscript } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexError from "effect-codex-app-server/errors";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

export class CodexReplayTranscriptDecodeError extends Schema.TaggedError<CodexReplayTranscriptDecodeError>()(
  "CodexReplayTranscriptDecodeError",
  {
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode Codex app-server replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export const CodexOrchestratorReplayHarnessError = Schema.Union([
  CodexReplayTranscriptDecodeError,
  CodexReplay.CodexAppServerReplayError,
  ProviderAdapterDriverCreateError,
]);
export type CodexOrchestratorReplayHarnessError = typeof CodexOrchestratorReplayHarnessError.Type;

export function withCodexReplayChildMetadata(
  client: CodexClient.CodexAppServerClient["Service"],
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  readMetadata: (
    threadId: string,
    method: "thread/read" | "thread/resume",
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError> = (threadId) =>
    Effect.succeed({ thread: { id: threadId }, model: null }),
): CodexClient.CodexAppServerClient["Service"] {
  const childThreadIds = new Set(
    transcript.entries.flatMap((entry) => {
      if (entry.type !== "emit_inbound" || !Predicate.isObject(entry.frame)) return [];
      const params = entry.frame.params;
      if (!Predicate.isObject(params) || !Predicate.isObject(params.item)) return [];
      const item = params.item;
      if (item.type === "subAgentActivity" && typeof item.agentThreadId === "string") {
        return [item.agentThreadId];
      }
      return item.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter(Predicate.isString)
        : [];
    }),
  );
  // Older transcripts predate roster discovery. Model their command lifecycle;
  // explicit discovery transcripts still verify the exact paginated RPC exchange.
  const commands = new Map<
    string,
    Map<string, { itemId: string; processId: string; command: string; turnId: string }>
  >();
  const settledTurns = new Set<string>();
  const hasDiscovery = transcript.entries.some(
    (entry) =>
      entry.type === "expect_outbound" &&
      Predicate.isObject(entry.frame) &&
      entry.frame.method === "thread/backgroundTerminals/list" &&
      Predicate.isObject(entry.frame.params) &&
      entry.frame.params.limit === 100,
  );
  return {
    ...client,
    handleServerNotification: (method, handler) =>
      client.handleServerNotification(method, (payload) =>
        Effect.sync(() => {
          if (
            method === "turn/completed" &&
            Predicate.isObject(payload) &&
            Predicate.isObject(payload.turn) &&
            payload.turn.status === "completed" &&
            typeof payload.turn.id === "string"
          ) {
            settledTurns.add(payload.turn.id);
            return;
          }
          if (
            (method !== "item/started" && method !== "item/completed") ||
            !Predicate.isObject(payload)
          )
            return;
          const item = payload.item;
          if (
            !Predicate.isObject(item) ||
            item.type !== "commandExecution" ||
            typeof item.id !== "string" ||
            typeof payload.threadId !== "string" ||
            typeof payload.turnId !== "string"
          )
            return;
          const items = commands.get(payload.threadId) ?? new Map();
          commands.set(payload.threadId, items);
          if (method === "item/completed") {
            items.delete(item.id);
            return;
          }
          if (typeof item.command !== "string" || typeof item.processId !== "string") return;
          items.set(item.id, {
            itemId: item.id,
            processId: item.processId,
            command: item.command,
            turnId: payload.turnId,
          });
        }).pipe(Effect.andThen(handler(payload))),
      ),
    raw: {
      ...client.raw,
      request: (method, params) =>
        method === "thread/backgroundTerminals/list" &&
        !hasDiscovery &&
        Predicate.isObject(params) &&
        params.limit === 100 &&
        typeof params.threadId === "string"
          ? Effect.succeed({
              data: [...(commands.get(params.threadId)?.values() ?? [])].filter((item) =>
                settledTurns.has(item.turnId),
              ),
              nextCursor: null,
            })
          : (method === "thread/read" || method === "thread/resume") &&
              Predicate.isObject(params) &&
              (method === "thread/read"
                ? params.includeTurns === false
                : params.excludeTurns === true) &&
              typeof params.threadId === "string" &&
              childThreadIds.has(params.threadId)
            ? readMetadata(params.threadId, method)
            : client.raw.request(method, params).pipe(
                Effect.tap((response) =>
                  Effect.sync(() => {
                    if (
                      method !== "thread/backgroundTerminals/terminate" ||
                      !Predicate.isObject(params) ||
                      typeof params.threadId !== "string" ||
                      !Predicate.isObject(response) ||
                      response.terminated !== true
                    )
                      return;
                    const items = commands.get(params.threadId);
                    for (const [id, item] of items ?? [])
                      if (item.processId === params.processId) items?.delete(id);
                  }),
                ),
              ),
    },
  };
}

function metadataFromTranscript(transcript: ProviderReplayTranscript): {
  readonly provider?: string;
  readonly protocol?: string;
  readonly scenario?: string;
} {
  return {
    provider: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

export function makeReplayServerConfig(
  scenario: string,
): Effect.Effect<
  ServerConfig.ServerConfig["Service"],
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectory({
      prefix: `t3-orchestration-v2-codex-${scenario}-`,
    });
    const stateDir = path.join(baseDir, "userdata");
    const logsDir = path.join(stateDir, "logs");
    const providerLogsDir = path.join(logsDir, "provider");
    const terminalLogsDir = path.join(logsDir, "terminals");
    const attachmentsDir = path.join(stateDir, "attachments");
    const environmentThemesDir = path.join(stateDir, "themes");
    const worktreesDir = path.join(baseDir, "worktrees");
    const providerStatusCacheDir = path.join(baseDir, "caches");

    for (const directory of [
      stateDir,
      logsDir,
      providerLogsDir,
      terminalLogsDir,
      attachmentsDir,
      environmentThemesDir,
      worktreesDir,
      providerStatusCacheDir,
    ]) {
      yield* fs.makeDirectory(directory, { recursive: true });
    }

    return {
      logLevel: "Error",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otelEnvironment: OtelEnvironment.none,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      mode: "web",
      port: 0,
      host: undefined,
      cwd: process.cwd(),
      baseDir,
      staticDir: undefined,
      devUrl: undefined,
      devAllowedOrigins: [],
      noBrowser: false,
      startupPresentation: "browser",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      stateDir,
      dbPath: path.join(stateDir, "state.sqlite"),
      keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
      settingsPath: path.join(stateDir, "settings.json"),
      providerStatusCacheDir,
      worktreesDir,
      attachmentsDir,
      browserArtifactsDir: path.join(stateDir, "browser-artifacts"),
      environmentThemesDir,
      logsDir,
      serverLogPath: path.join(logsDir, "server.log"),
      serverTracePath: path.join(logsDir, "server.trace.ndjson"),
      providerLogsDir,
      providerEventLogPath: path.join(providerLogsDir, "events.log"),
      terminalLogsDir,
      anonymousIdPath: path.join(stateDir, "anonymous-id"),
      environmentIdPath: path.join(stateDir, "environment-id"),
      serverRuntimeStatePath: path.join(stateDir, "server-runtime.json"),
      secretsDir: path.join(stateDir, "secrets"),
    };
  });
}

export function layer(input: {
  readonly transcript: CodexReplay.CodexAppServerReplayTranscript;
  readonly driver?: CodexReplay.CodexAppServerReplayDriver;
}) {
  const layerReplay =
    input.driver === undefined
      ? CodexReplay.layerReplay(input.transcript)
      : CodexReplay.layerReplayWithDriver(input.driver);
  const layerReplayClientFactory = Layer.succeed(CodexAdapterV2.CodexAppServerClientFactory, {
    open: (openInput) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(layerReplay).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
        );
        return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.map((client) => withCodexReplayChildMetadata(client, input.transcript)),
          Effect.provide(context),
        );
      }),
  });
  const layerServerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    makeReplayServerConfig(input.transcript.scenario).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  const layerRegistry = ProviderAdapterRegistry.layerFromDrivers({
    drivers: [CodexAdapterV2.CodexAdapterV2Driver],
    configMap: {
      [CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID]: {
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
      },
    },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerReplayClientFactory,
        layerServerConfig,
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );

  return layerRegistry;
}

const decodeCodexAppServerReplayTranscript = Schema.decodeUnknownEffect(
  CodexReplay.CodexAppServerReplayTranscript,
);

export const CodexOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  CodexReplay.CodexAppServerReplayTranscript,
  CodexOrchestratorReplayHarnessError
> = {
  driver: CodexAdapterV2.CODEX_DRIVER_KIND,
  decodeTranscript: (transcript) =>
    decodeCodexAppServerReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new CodexReplayTranscriptDecodeError({
            ...metadataFromTranscript(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (
    transcript,
    options: { readonly replayGate?: ProviderReplayGate } = {},
  ) => {
    return Layer.effectContext(
      Effect.gen(function* () {
        const replayGate = options.replayGate;
        if (replayGate !== undefined) {
          yield* Effect.addFinalizer(() => Effect.sync(() => replayGate.releaseAll()));
        }
        const driver = yield* CodexReplay.makeReplayDriver(
          transcript,
          replayGate === undefined
            ? {}
            : {
                beforeEmitInbound: (entry) =>
                  Effect.promise((signal) => replayGate.beforeEmit(entry.label, signal)),
              },
        );
        return yield* Layer.build(layer({ transcript, driver }));
      }),
    );
  },
};
