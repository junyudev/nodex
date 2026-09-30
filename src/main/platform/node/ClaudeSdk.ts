// @effect-diagnostics asyncFunction:off
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
  type SDKSessionInfo,
  type ModelInfo,
  type SlashCommand,
  type UserDialogRequest,
  type UserDialogResult,
  type ElicitationRequest,
  type ElicitationResult,
  type SDKControlInterruptResponse,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { AgentPromptImage } from "../../../shared/agent-conversation";
import {
  AGENT_TOOL_OUTPUT_MAX_BYTES,
  boundAgentToolOutput,
  type AgentToolOutput,
} from "../../../shared/agent-tool-output";
import type { ClaudeAgentInstanceConfig } from "../../../shared/types";
import type {
  ClaudeEffortLevel,
  ClaudeModelSelection,
  ClaudeRuntimeDiagnostics,
  ClaudeResolvedIntelligence,
} from "../../../shared/claude-models";
import { claudeModelWithContext } from "../../../shared/claude-models";
import { agentRuntimeError, AgentRuntimeError } from "../../agent-backend/AgentRuntimeError";
import { isClaudeHistoryPrompt } from "../../../shared/claude-history";
import { claudeNativeHome, resolveClaudeExecutable } from "./ClaudeExecutable";
import { resolveClaudeIntelligence } from "./ClaudeIntelligence";

export interface ClaudeToolRequest {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly title?: string;
  readonly toolUseId: string;
  readonly agentId?: string;
  readonly suggestions?: PermissionUpdate[];
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly mcpServer?: { name: string; source?: string };
  readonly displayName?: string;
  readonly description?: string;
  readonly defaultToNo?: boolean;
  readonly suppressAlwaysAllowRule?: boolean;
}
export interface ClaudeNativeHistoryPage {
  readonly messages: readonly SessionMessage[];
  readonly before: string | null;
  readonly hasMore: boolean;
}
export interface ClaudeLaunchContext {
  readonly systemPromptAppend?: string;
  readonly mcpServers?: Options["mcpServers"];
  readonly additionalDirectories?: readonly string[];
}
export interface ClaudeSdkSession {
  readonly messages: Stream.Stream<SDKMessage, AgentRuntimeError>;
  readonly models: readonly ModelInfo[];
  readonly commands: readonly SlashCommand[];
  readonly diagnostics: ClaudeRuntimeDiagnostics;
  readonly intelligence: ClaudeResolvedIntelligence;
  readonly inspectIntelligence: Effect.Effect<ClaudeResolvedIntelligence, AgentRuntimeError>;
  readonly send: (
    text: string,
    messageId?: string,
    sessionId?: string,
    priority?: "now" | "next" | "later",
    images?: readonly AgentPromptImage[],
  ) => Effect.Effect<void, AgentRuntimeError>;
  readonly interrupt: Effect.Effect<SDKControlInterruptResponse | undefined, AgentRuntimeError>;
  readonly terminate: Effect.Effect<void>;
  readonly setIntelligence: (
    selection: ClaudeModelSelection,
  ) => Effect.Effect<void, AgentRuntimeError>;
  readonly setMode: (mode: PermissionMode) => Effect.Effect<void, AgentRuntimeError>;
  readonly stopTask: (taskId: string) => Effect.Effect<void, AgentRuntimeError>;
  readonly inspectRuntime: Effect.Effect<ClaudeRuntimeDiagnostics, AgentRuntimeError>;
}
export interface ClaudeSdkOpenInput {
  readonly instance: ClaudeAgentInstanceConfig;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly sessionId: string;
  readonly resume: boolean;
  readonly persistSession?: boolean;
  readonly purpose?: "session" | "discovery" | "helper";
  readonly launchContext?: ClaudeLaunchContext;
  readonly model?: string;
  readonly effort?: ClaudeEffortLevel;
  readonly fast?: boolean;
  readonly thinking?: boolean;
  readonly outputSchema?: Record<string, unknown>;
  readonly permissionMode: PermissionMode;
  readonly canUseTool: (
    request: ClaudeToolRequest,
  ) => Effect.Effect<PermissionResult, AgentRuntimeError>;
  readonly onUserDialog?: (
    request: UserDialogRequest,
  ) => Effect.Effect<UserDialogResult, AgentRuntimeError>;
  readonly onElicitation?: (
    request: ElicitationRequest,
  ) => Effect.Effect<ElicitationResult, AgentRuntimeError>;
}
type HistoryInput = Omit<ClaudeSdkOpenInput, "canUseTool" | "permissionMode">;
export type ClaudeNativeScopeInput = Pick<ClaudeSdkOpenInput, "instance" | "environment">;
export class ClaudeSdk extends Context.Service<
  ClaudeSdk,
  {
    readonly nativeHome: (
      input: ClaudeNativeScopeInput,
    ) => Effect.Effect<string, AgentRuntimeError>;
    readonly listSessions: (
      input: ClaudeNativeScopeInput,
      offset: number,
    ) => Effect.Effect<readonly SDKSessionInfo[], AgentRuntimeError>;
    readonly sessionInfo: (
      input: ClaudeNativeScopeInput,
      sessionId: string,
    ) => Effect.Effect<SDKSessionInfo | null, AgentRuntimeError>;
    readonly open: (
      input: ClaudeSdkOpenInput,
    ) => Effect.Effect<ClaudeSdkSession, AgentRuntimeError, Scope.Scope>;
    readonly configuration: (
      input: Pick<ClaudeSdkOpenInput, "instance" | "environment" | "cwd">,
    ) => Effect.Effect<Pick<Settings, "skillOverrides">, AgentRuntimeError>;
    readonly history: (
      input: HistoryInput,
    ) => Effect.Effect<readonly SessionMessage[], AgentRuntimeError>;
    readonly historyPage: (
      input: HistoryInput,
      page?: { readonly before?: string; readonly limit?: number; readonly all?: boolean },
    ) => Effect.Effect<ClaudeNativeHistoryPage, AgentRuntimeError>;
    readonly hasSession: (input: HistoryInput) => Effect.Effect<boolean, AgentRuntimeError>;
    readonly historyImage: (
      input: HistoryInput,
      nativeMessageId: string,
      index: number,
    ) => Effect.Effect<AgentPromptImage, AgentRuntimeError>;
    readonly historyToolOutput: (
      input: HistoryInput,
      nativeMessageId: string,
      toolUseId: string,
    ) => Effect.Effect<AgentToolOutput, AgentRuntimeError>;
    readonly fork: (
      input: HistoryInput,
      upToMessageId?: string,
    ) => Effect.Effect<
      { readonly sessionId: string; readonly messageIdMap?: Readonly<Record<string, string>> },
      AgentRuntimeError
    >;
  }
>()("nodex/main/platform/node/ClaudeSdk") {}

const failure = (operation: string, cause: unknown) =>
  Schema.is(AgentRuntimeError)(cause)
    ? cause
    : agentRuntimeError({
        operation: `Claude ${operation}`,
        reason:
          cause && typeof cause === "object" && "_tag" in cause && cause._tag === "TimeoutError"
            ? "timeout"
            : cause &&
                typeof cause === "object" &&
                "code" in cause &&
                cause.code === "NODEX_NATIVE_SESSION_NOT_FOUND"
              ? "resource-not-found"
              : operation === "launch"
                ? "spawn"
                : operation === "initialize"
                  ? "initialize"
                  : "request",
        retryable: false,
        cause,
      });

/** Only an explicit instance directory overrides native account selection; it never changes HOME. */
export const claudeEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  instance: ClaudeAgentInstanceConfig,
): Record<string, string | undefined> => {
  const result = { ...environment };
  delete result.CLAUDECODE;
  delete result.CLAUDE_CODE_ENTRYPOINT;
  if (!instance.configDirectory) return result;
  const directory = instance.configDirectory.startsWith("~/")
    ? join(claudeNativeHome(environment) ?? "", instance.configDirectory.slice(2))
    : instance.configDirectory;
  if (
    !isAbsolute(directory) &&
    !/^[A-Za-z]:[\\/]/u.test(directory) &&
    !directory.startsWith("\\\\")
  )
    throw new Error("Claude config directory must be absolute or start with ~/.");
  result.CLAUDE_CONFIG_DIR = directory;
  return result;
};
export const claudeQueryOptions = (input: ClaudeSdkOpenInput, executable: string): Options => {
  const isolated = input.purpose === "discovery" || input.purpose === "helper";
  const environment = claudeEnvironment(input.environment, input.instance);
  if (isolated) {
    environment.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
    delete environment.FORCE_CODE_TERMINAL;
    environment.CLAUDE_CODE_AUTO_CONNECT_IDE = "0";
    environment.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = "1";
  }
  return {
    cwd: input.cwd,
    pathToClaudeCodeExecutable: executable,
    env: environment,
    settingSources: ["user", "project", "local"],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(input.launchContext?.systemPromptAppend
        ? { append: input.launchContext.systemPromptAppend }
        : {}),
    },
    tools: isolated ? [] : { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
    permissionMode: input.permissionMode,
    // Enables the host's explicit live Full access control; the initial mode still governs tools.
    allowDangerouslySkipPermissions: !isolated,
    persistSession: isolated ? false : (input.persistSession ?? true),
    ...(isolated
      ? {
          settings: { disableAllHooks: true },
          mcpServers: {},
          strictMcpConfig: true,
          allowedTools: [],
        }
      : {}),
    ...(input.purpose === "helper"
      ? {
          maxTurns: 1,
          ...(input.outputSchema
            ? { outputFormat: { type: "json_schema", schema: input.outputSchema } as const }
            : {}),
        }
      : {}),
    ...(!isolated && input.launchContext?.mcpServers
      ? { mcpServers: input.launchContext.mcpServers }
      : {}),
    ...(!isolated && input.launchContext?.additionalDirectories
      ? { additionalDirectories: [...input.launchContext.additionalDirectories] }
      : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.fast !== undefined || input.thinking !== undefined
      ? {
          settings: {
            ...(isolated ? { disableAllHooks: true } : {}),
            ...(input.fast !== undefined ? { fastMode: input.fast } : {}),
            ...(input.thinking !== undefined ? { alwaysThinkingEnabled: input.thinking } : {}),
          },
        }
      : {}),
    ...(input.resume ? { resume: input.sessionId } : { sessionId: input.sessionId }),
  };
};
const open = Effect.fn("ClaudeSdk.open")(function* (input: ClaudeSdkOpenInput) {
  const executable = yield* Effect.tryPromise({
    try: () =>
      resolveClaudeExecutable(
        input.instance.binaryPath,
        claudeEnvironment(input.environment, input.instance),
        process.platform,
        input.cwd,
      ),
    catch: (cause) => failure("launch", cause),
  });
  const runPermission = yield* FiberSet.makeRuntimePromise<
    never,
    PermissionResult,
    AgentRuntimeError
  >();
  const runDialog = yield* FiberSet.makeRuntimePromise<
    never,
    UserDialogResult,
    AgentRuntimeError
  >();
  const runElicitation = yield* FiberSet.makeRuntimePromise<
    never,
    ElicitationResult,
    AgentRuntimeError
  >();
  const messages = yield* Queue.bounded<SDKUserMessage>(16);
  yield* Effect.addFinalizer(() => Queue.shutdown(messages));
  const canUseTool: CanUseTool = (name, toolInput, options) =>
    runPermission(
      input.canUseTool({
        name,
        input: toolInput,
        toolUseId: options.toolUseID,
        ...(options.title ? { title: options.title } : {}),
        ...(options.agentID ? { agentId: options.agentID } : {}),
        ...(options.suggestions ? { suggestions: options.suggestions } : {}),
        ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
        ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
        ...(options.mcpServer ? { mcpServer: options.mcpServer } : {}),
        ...(options.displayName ? { displayName: options.displayName } : {}),
        ...(options.description ? { description: options.description } : {}),
        ...(options.defaultToNo !== undefined ? { defaultToNo: options.defaultToNo } : {}),
        ...(options.suppressAlwaysAllowRule !== undefined
          ? { suppressAlwaysAllowRule: options.suppressAlwaysAllowRule }
          : {}),
      }),
      { signal: options.signal },
    );
  const session = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        query({
          prompt: Stream.toAsyncIterable(Stream.fromQueue(messages)),
          options: {
            ...claudeQueryOptions(input, executable),
            canUseTool,
            ...(input.onUserDialog
              ? {
                  supportedDialogKinds: ["resume_return"],
                  onUserDialog: (request, options) =>
                    runDialog(input.onUserDialog!(request), { signal: options.signal }),
                }
              : {}),
            ...(input.onElicitation
              ? {
                  onElicitation: (request, options) =>
                    runElicitation(input.onElicitation!(request), { signal: options.signal }),
                }
              : {}),
          },
        }),
      catch: (cause) => failure("launch", cause),
    }),
    (resource) => Effect.sync(() => resource.close()),
  );
  const call = <A>(operation: string, evaluate: () => Promise<A>) =>
    Effect.tryPromise({ try: evaluate, catch: (cause) => failure(operation, cause) }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((cause) => failure(operation, cause)),
    );
  const initialized = yield* call("initialize", () => session.initializationResult());
  let flags = {
    model: input.model,
    effort: input.effort,
    fast: input.fast,
    thinking: input.thinking,
  };
  let fastState = initialized.fast_mode_state;
  // This installed SDK exposes the native read on Query even though its public declaration omits
  // it. Keep the feature check and response validation at this version-sensitive platform seam.
  const nativeSettings = session as typeof session & { getSettings?: () => Promise<unknown> };
  const inspectIntelligence = Effect.suspend(() =>
    typeof nativeSettings.getSettings === "function"
      ? call("intelligence read", () => nativeSettings.getSettings!()).pipe(
          Effect.catch(() => Effect.void),
        )
      : Effect.void,
  ).pipe(
    Effect.map((settings) =>
      resolveClaudeIntelligence({
        settings,
        models: initialized.models ?? [],
        customModels: input.instance.customModels,
        environment: claudeEnvironment(input.environment, input.instance),
        acknowledged: flags,
        ...(fastState ? { fastState } : {}),
      }),
    ),
  );
  let intelligence = yield* inspectIntelligence;
  // Capture the model selected by this Query's native configuration before any flag override.
  const inheritedModel = input.model === undefined ? intelligence.model : null;
  const diagnostics: ClaudeRuntimeDiagnostics = {
    health: {
      status: "unknown",
      executable,
      version: null,
      account: initialized.account ?? null,
      error: null,
    },
    agents: (initialized.agents ?? []).map((agent) => ({
      name: agent.name,
      description: agent.description,
    })),
    mcpServers: [],
    capabilities: [],
  };
  return {
    messages: Stream.fromAsyncIterable(session, (cause) => failure("stream", cause)).pipe(
      Stream.tap((message) =>
        Effect.sync(() => {
          if (!("fast_mode_state" in message) || !message.fast_mode_state) return;
          fastState = message.fast_mode_state;
          intelligence = { ...intelligence, fast: fastState === "on" };
        }),
      ),
      Stream.ensuring(Effect.sync(() => session.close())),
    ),
    get intelligence() {
      return intelligence;
    },
    inspectIntelligence: inspectIntelligence.pipe(
      Effect.tap((resolved) =>
        Effect.sync(() => {
          intelligence = resolved;
        }),
      ),
    ),
    terminate: Effect.sync(() => session.close()),
    models: initialized.models ?? [],
    commands: initialized.commands ?? [],
    diagnostics,
    send: (text, messageId, sessionId, priority, images) =>
      Queue.offer(messages, {
        type: "user",
        ...(priority ? { priority } : {}),
        session_id: sessionId ?? input.sessionId,
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: images?.length
            ? [
                ...images.map((image) => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: image.mediaType,
                    data: image.data,
                  },
                })),
                ...(text ? [{ type: "text" as const, text }] : []),
              ]
            : text,
        },
        ...(messageId
          ? { uuid: messageId as `${string}-${string}-${string}-${string}-${string}` }
          : {}),
      }).pipe(Effect.asVoid),
    interrupt: call("interrupt", () => session.interrupt()),
    setIntelligence: (selection) =>
      Effect.suspend(() => {
        const model =
          selection.model !== "default"
            ? claudeModelWithContext(selection.model, selection.context)
            : selection.context && inheritedModel
              ? claudeModelWithContext(inheritedModel, selection.context)
              : undefined;
        if (selection.model === "default" && selection.context && !inheritedModel)
          return Effect.fail(
            failure("intelligence", new Error("Claude has not reported the inherited model.")),
          );
        if (
          (flags.model !== undefined && model === undefined) ||
          (flags.effort !== undefined && selection.effort === "default")
        )
          return Effect.fail(
            failure(
              "intelligence",
              new Error(
                "Restoring Claude defaults requires reopening the query without overrides.",
              ),
            ),
          );
        return call("intelligence", () =>
          session.applyFlagSettings({
            ...(model !== undefined ? { model } : {}),
            ...(selection.effort !== "default" ? { effortLevel: selection.effort } : {}),
            ...(selection.fast !== undefined
              ? { fastMode: selection.fast }
              : flags.fast !== undefined
                ? { fastMode: null }
                : {}),
            ...(selection.thinking !== undefined
              ? { alwaysThinkingEnabled: selection.thinking }
              : flags.thinking !== undefined
                ? { alwaysThinkingEnabled: null }
                : {}),
          }),
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (selection.fast !== flags.fast) fastState = undefined;
              flags = {
                model,
                effort: selection.effort === "default" ? undefined : selection.effort,
                fast: selection.fast,
                thinking: selection.thinking,
              };
            }),
          ),
        );
      }),
    setMode: (mode) => call("mode", () => session.setPermissionMode(mode)),
    stopTask: (taskId) => call("stop task", () => session.stopTask(taskId)),
    inspectRuntime: call("diagnostics", () => session.mcpServerStatus()).pipe(
      Effect.map((servers) => ({
        ...diagnostics,
        mcpServers: servers.map(({ name, status, error }) => ({
          name,
          status,
          ...(error ? { error } : {}),
        })),
      })),
    ),
  } satisfies ClaudeSdkSession;
});

/** Turn boundaries prevent a page from starting with an orphaned assistant/tool continuation. */
export const claudeHistoryWindow = (
  messages: readonly SessionMessage[],
  options: { readonly before?: string; readonly limit?: number; readonly all?: boolean } = {},
  isPrompt = isClaudeHistoryPrompt,
): ClaudeNativeHistoryPage => {
  const end = options.before
    ? messages.findIndex(({ uuid }) => uuid === options.before)
    : messages.length;
  if (end < 0) throw new Error("This history cursor no longer belongs to the native conversation.");
  if (options.all) return { messages: messages.slice(0, end), before: null, hasMore: false };
  const limit = Math.max(1, Math.min(2048, options.limit ?? 512));
  let start = Math.max(0, end - limit);
  while (start > 0 && !isPrompt(messages[start]!)) start -= 1;
  return {
    messages: messages.slice(start, end),
    before: start > 0 ? messages[start]!.uuid : null,
    hasMore: start > 0,
  };
};

/** UUID remapping is accepted only for the matching native content and actor. */
export const claudeForkMessageIds = (
  source: readonly SessionMessage[],
  forked: readonly SessionMessage[],
  equal = isDeepStrictEqual,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    forked.flatMap((entry, index) => {
      const previous = source[index];
      if (
        !previous ||
        previous.type !== entry.type ||
        previous.parent_tool_use_id !== entry.parent_tool_use_id ||
        previous.parent_agent_id !== entry.parent_agent_id ||
        !equal(previous.message, entry.message)
      )
        return [];
      return [[previous.uuid, entry.uuid]];
    }),
  );

/** Lazy image reads stay at the native history boundary; snapshots only contain descriptors. */
export const claudeHistoryImage = (
  messages: readonly SessionMessage[],
  nativeMessageId: string,
  index: number,
  isPrompt = isClaudeHistoryPrompt,
): AgentPromptImage => {
  if (!Number.isInteger(index) || index < 0) throw new Error("Invalid native image index.");
  const message = messages.find(({ uuid }) => uuid === nativeMessageId);
  if (!message || !isPrompt(message))
    throw new Error("This image no longer belongs to native prompt history.");
  const content = (message.message as { content?: unknown }).content;
  const block = Array.isArray(content)
    ? (content[index] as
        | { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } }
        | undefined)
    : undefined;
  const source = block?.source;
  if (
    block?.type !== "image" ||
    source?.type !== "base64" ||
    typeof source.media_type !== "string" ||
    !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.media_type) ||
    typeof source.data !== "string" ||
    source.data.length === 0 ||
    source.data.length > Math.ceil((5 * 1024 * 1024) / 3) * 4 ||
    source.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(source.data) ||
    Buffer.byteLength(source.data, "base64") > 5 * 1024 * 1024
  )
    throw new Error("Native image data is invalid or exceeds the image limit.");
  return { mediaType: source.media_type as AgentPromptImage["mediaType"], data: source.data };
};

/** The caller selects an exact native result, and binary payloads never enter the text response. */
export const claudeHistoryToolOutput = (
  messages: readonly SessionMessage[],
  nativeMessageId: string,
  toolUseId: string,
  bound = boundAgentToolOutput,
): AgentToolOutput => {
  const message = messages.find(({ uuid }) => uuid === nativeMessageId);
  if (message?.type !== "user")
    throw new Error("This tool output no longer belongs to the selected native result.");
  const content = (message?.message as { content?: unknown } | undefined)?.content;
  const result = Array.isArray(content)
    ? (content.find(
        (block: unknown) =>
          block !== null &&
          typeof block === "object" &&
          "type" in block &&
          block.type === "tool_result" &&
          "tool_use_id" in block &&
          block.tool_use_id === toolUseId,
      ) as { content?: unknown } | undefined)
    : undefined;
  if (!result) throw new Error("This tool output no longer belongs to the selected native result.");
  const withoutBinary = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value.map(withoutBinary).filter((entry) => entry !== undefined);
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (object.type === "image" || object.type === "document" || object.type === "base64")
      return undefined;
    return Object.fromEntries(
      Object.entries(object)
        .filter(([key]) => key !== "data" && key !== "base64")
        .flatMap(([key, entry]) => {
          const safe = withoutBinary(entry);
          return safe === undefined ? [] : [[key, safe]];
        }),
    );
  };
  const text = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
    if (value === null || typeof value !== "object") return value == null ? "" : String(value);
    const object = value as Record<string, unknown>;
    if (object.type === "text" && typeof object.text === "string") return object.text;
    const safe = withoutBinary(value);
    return safe === undefined ? "" : JSON.stringify(safe);
  };
  return bound(text(result.content));
};

// Native history/mutations read process.env; a bounded worker isolates each account without mutating Main.
const nativeOperation = <A>(
  input: ClaudeNativeScopeInput & Partial<HistoryInput>,
  operation:
    | "home"
    | "catalog"
    | "session-info"
    | "history"
    | "fork"
    | "configuration"
    | "image"
    | "exists"
    | "tool-output",
  options: {
    readonly before?: string;
    readonly limit?: number;
    readonly all?: boolean;
    readonly upToMessageId?: string;
    readonly nativeMessageId?: string;
    readonly index?: number;
    readonly toolUseId?: string;
    readonly offset?: number;
  } = {},
) =>
  Effect.callback<A, AgentRuntimeError>((resume) => {
    const worker = new Worker(
      `
    const { parentPort, workerData } = require("node:worker_threads");
    const {isDeepStrictEqual} = require("node:util");
    const isPrompt = ${isClaudeHistoryPrompt.toString()};
    const windowHistory = ${claudeHistoryWindow.toString()};
    const mapFork = ${claudeForkMessageIds.toString()};
    const readImage = ${claudeHistoryImage.toString()};
    const AGENT_TOOL_OUTPUT_MAX_BYTES = ${AGENT_TOOL_OUTPUT_MAX_BYTES};
    const boundOutput = ${boundAgentToolOutput.toString()};
    const readToolOutput = ${claudeHistoryToolOutput.toString()};
    const metadata = info => info ? {
      sessionId:info.sessionId,
      summary:String(info.summary??"").slice(0,2000),
      lastModified:info.lastModified,
      ...(info.customTitle?{customTitle:info.customTitle.slice(0,2000)}:{}),
      ...(info.firstPrompt?{firstPrompt:info.firstPrompt.slice(0,1024)}:{}),
      ...(info.cwd?{cwd:info.cwd}:{}),
      ...(info.createdAt===undefined?{}:{createdAt:info.createdAt})
    } : null;
    const post = value => { if (Buffer.byteLength(JSON.stringify(value),"utf8") > 8 * 1024 * 1024) throw new Error("Native history exceeds the page size limit. Load a smaller history page.");parentPort.postMessage(value);};
    const withoutInlineImages = value => {
      if (Array.isArray(value)) return value.map(withoutInlineImages);
      if (typeof value !== "object" || value === null) return value;
      if (value.type === "image" && value.source?.type === "base64") { const {data,...source}=value.source; return {...value,source}; }
      return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,withoutInlineImages(entry)]));
    };
    Promise.resolve().then(async()=>{
      if(workerData.operation!=="home") return import(workerData.moduleUrl);
      const {basename,dirname,isAbsolute,join,resolve}=require("node:path");
      const {lstat,realpath,stat}=require("node:fs/promises");
      const root=process.env.CLAUDE_CONFIG_DIR||join(require("node:os").homedir(),".claude");
      if(!isAbsolute(root)) throw new Error("Claude Code configuration directories must be absolute paths.");
      const present=path=>lstat(path).catch(error=>{if(error.code!=="ENOENT")throw error;return null;});
      const suffix=[];
      let ancestor=resolve(root);
      // Bind the physical ancestor before Claude creates its missing configuration directory.
      while(await present(ancestor)===null){
        suffix.unshift(basename(ancestor));
        const parent=dirname(ancestor);
        if(parent===ancestor) throw new Error("Claude Code configuration directory has no existing ancestor.");
        ancestor=parent;
      }
      if(!(await stat(ancestor)).isDirectory()) throw new Error("Claude Code configuration home must be a directory.");
      post(join(await realpath(ancestor),...suffix));
    }).then(async sdk => {
      if (workerData.operation === "home") return;
      if (workerData.operation === "catalog") {
        post((await sdk.listSessions({limit:51,offset:workerData.options.offset,includeProgrammatic:true})).map(metadata));return;
      }
      if (workerData.operation === "configuration") {
        const resolved = await sdk.resolveSettings({cwd:workerData.cwd,settingSources:["user","project","local"]});
        post({skillOverrides:resolved.effective.skillOverrides??{}}); return;
      }
      // Exact native identity is account-scoped; moving execution must not move or lose history.
      const info = await sdk.getSessionInfo(workerData.sessionId);
      if (workerData.operation === "session-info") {post(metadata(info));return;}
      if (workerData.operation === "exists") {post(Boolean(info));return;}
      if (!info) {const error=new Error("Claude Code no longer has this session. Start a new task.");error.code="NODEX_NATIVE_SESSION_NOT_FOUND";throw error;}
      if (workerData.operation === "fork") {
        const entries = await sdk.getSessionMessages(workerData.sessionId,{includeSystemMessages:true});
        if (workerData.options.upToMessageId && !entries.some(entry=>entry.uuid===workerData.options.upToMessageId)) throw new Error("The selected message is no longer in native history.");
        const forked = await sdk.forkSession(workerData.sessionId,{upToMessageId:workerData.options.upToMessageId});
        const retained = await sdk.getSessionMessages(forked.sessionId,{includeSystemMessages:true});
        post({...forked,messageIdMap:mapFork(entries,retained,isDeepStrictEqual)}); return;
      }

      const entries = await sdk.getSessionMessages(workerData.sessionId,{includeSystemMessages:true});
      if (workerData.operation === "image") { post(readImage(entries,workerData.options.nativeMessageId,workerData.options.index,isPrompt));return; }
      if (workerData.operation === "tool-output") { post(readToolOutput(entries,workerData.options.nativeMessageId,workerData.options.toolUseId,boundOutput));return; }
      post(withoutInlineImages(windowHistory(entries,workerData.options,isPrompt)));
    }).catch(error=>{ parentPort.postMessage({nodexWorkerFailure:{message:String(error?.message??"Native operation failed").slice(0,2048),code:error?.code}}); });
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
          operation,
          options,
        },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      },
    );
    let delivered = false;
    worker.once(
      "message",
      (value: A | { nodexWorkerFailure: { message: string; code?: string } }) => {
        delivered = true;
        if (value && typeof value === "object" && "nodexWorkerFailure" in value) {
          const error = Object.assign(new Error(value.nodexWorkerFailure.message), {
            code: value.nodexWorkerFailure.code,
          });
          resume(Effect.fail(failure(operation, error)));
          return;
        }
        resume(Effect.succeed(value as A));
      },
    );
    worker.once("error", (cause) => {
      delivered = true;
      resume(Effect.fail(failure(operation, cause)));
    });
    worker.once("exit", (code) => {
      if (!delivered)
        resume(
          Effect.fail(failure(operation, new Error(`Native history worker exited (${code})`))),
        );
    });
    return Effect.promise(() => worker.terminate()).pipe(Effect.asVoid);
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) => failure(operation, cause)),
  );
const historyPage: ClaudeSdk["Service"]["historyPage"] = (input, page) =>
  nativeOperation(input, "history", page);
const history: ClaudeSdk["Service"]["history"] = (input) =>
  historyPage(input).pipe(Effect.map(({ messages }) => messages));
const fork: ClaudeSdk["Service"]["fork"] = (input, upToMessageId) =>
  nativeOperation(input, "fork", { ...(upToMessageId ? { upToMessageId } : {}) });
const hasSession: ClaudeSdk["Service"]["hasSession"] = (input) => nativeOperation(input, "exists");
const historyImage: ClaudeSdk["Service"]["historyImage"] = (input, nativeMessageId, index) =>
  nativeOperation(input, "image", { nativeMessageId, index });
const historyToolOutput: ClaudeSdk["Service"]["historyToolOutput"] = (
  input,
  nativeMessageId,
  toolUseId,
) => nativeOperation(input, "tool-output", { nativeMessageId, toolUseId });
const configuration: ClaudeSdk["Service"]["configuration"] = (input) =>
  nativeOperation({ ...input, sessionId: "", resume: false }, "configuration");
const nativeHome: ClaudeSdk["Service"]["nativeHome"] = (input) => nativeOperation(input, "home");
const listSessions: ClaudeSdk["Service"]["listSessions"] = (input, offset) =>
  nativeOperation(input, "catalog", { offset });
const sessionInfo: ClaudeSdk["Service"]["sessionInfo"] = (input, sessionId) =>
  nativeOperation({ ...input, sessionId }, "session-info");
export const live = Layer.succeed(
  ClaudeSdk,
  ClaudeSdk.of({
    nativeHome,
    listSessions,
    sessionInfo,
    open,
    history,
    historyPage,
    fork,
    configuration,
    historyImage,
    historyToolOutput,
    hasSession,
  }),
);
