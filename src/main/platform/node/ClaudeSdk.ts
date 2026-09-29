// @effect-diagnostics asyncFunction:off
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
  type ModelInfo,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { ClaudeAgentInstanceConfig } from "../../../shared/types";
import type { ClaudeEffortLevel, ClaudeEffortSelection } from "../../../shared/claude-models";
import { agentRuntimeError, type AgentRuntimeError } from "../../agent-backend/AgentRuntimeError";

export type ClaudeToolRequest = {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly title?: string;
  readonly toolUseId: string;
};
export interface ClaudeSdkSession {
  readonly messages: Stream.Stream<SDKMessage, AgentRuntimeError>;
  readonly models: readonly ModelInfo[];
  readonly commands: readonly SlashCommand[];
  readonly send: (text: string, messageId?: string) => Effect.Effect<void, AgentRuntimeError>;
  readonly interrupt: Effect.Effect<void, AgentRuntimeError>;
  readonly terminate: Effect.Effect<void>;
  readonly setModel: (
    model: string | undefined,
    effort?: ClaudeEffortSelection,
  ) => Effect.Effect<void, AgentRuntimeError>;
  readonly setEffort: (effort: ClaudeEffortSelection) => Effect.Effect<void, AgentRuntimeError>;
  readonly setMode: (mode: PermissionMode) => Effect.Effect<void, AgentRuntimeError>;
}
export interface ClaudeSdkOpenInput {
  readonly instance: ClaudeAgentInstanceConfig;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly sessionId: string;
  readonly resume: boolean;
  readonly persistSession?: boolean;
  readonly model?: string;
  readonly effort?: ClaudeEffortLevel;
  readonly permissionMode: PermissionMode;
  readonly canUseTool: (
    request: ClaudeToolRequest,
  ) => Effect.Effect<PermissionResult, AgentRuntimeError>;
}
export class ClaudeSdk extends Context.Service<
  ClaudeSdk,
  {
    readonly open: (
      input: ClaudeSdkOpenInput,
    ) => Effect.Effect<ClaudeSdkSession, AgentRuntimeError, Scope.Scope>;
    readonly history: (
      input: Omit<ClaudeSdkOpenInput, "canUseTool" | "permissionMode">,
    ) => Effect.Effect<readonly SessionMessage[], AgentRuntimeError>;
  }
>()("nodex/main/platform/node/ClaudeSdk") {}

const failure = (operation: string, cause: unknown) =>
  agentRuntimeError({
    operation: `Claude ${operation}`,
    reason: "request",
    retryable: false,
    cause,
  });

/** Config directory selects a Claude account; HOME and the OS keychain retain their normal identity. */
export const claudeEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  instance: ClaudeAgentInstanceConfig,
): Record<string, string | undefined> => {
  const result = { ...environment };
  delete result.CLAUDECODE;
  delete result.CLAUDE_CODE_ENTRYPOINT;
  if (instance.configDirectory) result.CLAUDE_CONFIG_DIR = instance.configDirectory;
  return result;
};

const resolveExecutable = async (
  binary: string,
  environment: Record<string, string | undefined>,
) => {
  const expanded = binary.startsWith("~/") ? join(environment.HOME ?? "", binary.slice(2)) : binary;
  const candidates = isAbsolute(expanded)
    ? [expanded]
    : (environment.PATH ?? "").split(delimiter).map((dir) => join(dir, expanded));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      return await realpath(candidate);
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error(
    `Claude Code executable was not found: ${binary}. Install Claude Code or choose its executable in Agent settings.`,
  );
};

export const claudeQueryOptions = (input: ClaudeSdkOpenInput, executable: string): Options => ({
  cwd: input.cwd,
  pathToClaudeCodeExecutable: executable,
  env: claudeEnvironment(input.environment, input.instance),
  settingSources: ["user", "project", "local"],
  systemPrompt: { type: "preset", preset: "claude_code" },
  tools: { type: "preset", preset: "claude_code" },
  includePartialMessages: true,
  permissionMode: input.permissionMode,
  allowDangerouslySkipPermissions: input.permissionMode === "bypassPermissions",
  persistSession: input.persistSession ?? true,
  ...(input.model ? { model: input.model } : {}),
  ...(input.effort ? { effort: input.effort } : {}),
  ...(input.resume ? { resume: input.sessionId } : { sessionId: input.sessionId }),
});

const open = Effect.fn("ClaudeSdk.open")(function* (input: ClaudeSdkOpenInput) {
  const environment = claudeEnvironment(input.environment, input.instance);
  const executable = yield* Effect.tryPromise({
    try: () => resolveExecutable(input.instance.binaryPath, environment),
    catch: (cause) => failure("launch", cause),
  });
  const runPromise = yield* FiberSet.makeRuntimePromise<
    never,
    PermissionResult,
    AgentRuntimeError
  >();
  const messages = yield* Queue.bounded<SDKUserMessage>(1);
  yield* Effect.addFinalizer(() => Queue.shutdown(messages));
  const canUseTool: CanUseTool = (name, toolInput, options) =>
    runPromise(
      input.canUseTool({
        name,
        input: toolInput,
        toolUseId: options.toolUseID,
        ...(options.title ? { title: options.title } : {}),
      }),
      { signal: options.signal },
    );
  const session = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        query({
          prompt: Stream.toAsyncIterable(Stream.fromQueue(messages)),
          options: { ...claudeQueryOptions(input, executable), canUseTool },
        }),
      catch: (cause) => failure("launch", cause),
    }),
    (resource) => Effect.sync(() => resource.close()),
  );
  const call = <A>(operation: string, evaluate: () => Promise<A>) =>
    Effect.tryPromise({ try: evaluate, catch: (cause) => failure(operation, cause) });
  const initialized = yield* call("initialize", () => session.initializationResult()).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) => failure("initialize", cause)),
  );
  return {
    messages: Stream.fromAsyncIterable(session, (cause) => failure("stream", cause)).pipe(
      Stream.ensuring(Effect.sync(() => session.close())),
    ),
    terminate: Effect.sync(() => session.close()),
    models: initialized.models,
    commands: initialized.commands,
    send: (text, messageId) =>
      Queue.offer(messages, {
        type: "user",
        session_id: input.sessionId,
        parent_tool_use_id: null,
        message: { role: "user", content: text },
        ...(messageId
          ? { uuid: messageId as `${string}-${string}-${string}-${string}-${string}` }
          : {}),
      }).pipe(Effect.asVoid),
    interrupt: call("interrupt", () => session.interrupt()).pipe(Effect.asVoid),
    setModel: (model, effort) =>
      call("model", () =>
        effort === undefined
          ? session.setModel(model)
          : session.applyFlagSettings({
              model: model ?? null,
              effortLevel: effort === "default" ? null : effort,
            }),
      ),
    setEffort: (effort) =>
      call("effort", () =>
        session.applyFlagSettings({ effortLevel: effort === "default" ? null : effort }),
      ),
    setMode: (mode) => call("mode", () => session.setPermissionMode(mode)),
  } satisfies ClaudeSdkSession;
});

// SDK history helpers use process environment. A worker gives each account its own environment
// without ever mutating Main's environment or crossing into another account's session directory.
const history: ClaudeSdk["Service"]["history"] = (input) =>
  Effect.callback<readonly SessionMessage[], AgentRuntimeError>((resume) => {
    const worker = new Worker(
      `
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.moduleUrl).then(async (sdk) => {
      const info = await sdk.getSessionInfo(workerData.sessionId, { dir: workerData.cwd });
      if (!info) throw new Error("Claude Code no longer has this session. Start a new task.");
      const messages = await sdk.getSessionMessages(workerData.sessionId, { dir: workerData.cwd, includeSystemMessages: true });
      parentPort.postMessage(messages.slice(-512));
    }).catch((error) => { throw error; });
  `,
      {
        eval: true,
        env: claudeEnvironment(input.environment, input.instance),
        workerData: {
          moduleUrl: pathToFileURL(
            createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"),
          ).href,
          sessionId: input.sessionId,
          cwd: input.cwd,
        },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      },
    );
    worker.once("message", (messages: SessionMessage[]) => resume(Effect.succeed(messages)));
    worker.once("error", (cause) => resume(Effect.fail(failure("history", cause))));
    worker.once("exit", (code) => {
      if (code !== 0)
        resume(Effect.fail(failure("history", new Error(`History reader exited (${code})`))));
    });
    return Effect.promise(() => worker.terminate()).pipe(Effect.asVoid);
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) => failure("history", cause)),
  );

export const live = Layer.succeed(ClaudeSdk, ClaudeSdk.of({ open, history }));
