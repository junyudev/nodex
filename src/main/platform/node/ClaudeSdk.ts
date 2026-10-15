import { readClaudeHistoryRecords, readClaudeHistoryRecord } from "./ClaudeHistoryRecords";
// @effect-diagnostics asyncFunction:off
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  query,
  type Options,
  type SessionMessage,
  type SDKSessionInfo,
  type ModelInfo,
  type SlashCommand,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
  ClaudeRuntimeDiagnostics,
  ClaudeResolvedIntelligence,
} from "../../../shared/claude-models";
import { agentRuntimeError, AgentRuntimeError } from "../../agent-backend/AgentRuntimeError";
import { isClaudeHistoryPrompt } from "../../../shared/claude-history";
import { claudeNativeHome, resolveClaudeLaunch } from "./ClaudeExecutable";
import { resolveClaudeIntelligence } from "./ClaudeIntelligence";
import { WorktreeShellEnvironmentRuntime } from "../../host-runtime/WorktreeShellEnvironmentRuntime";
import { MainConfig } from "../../app/MainConfig";

export interface ClaudeNativeHistoryPage {
  readonly messages: readonly SessionMessage[];
  readonly before: string | null;
  readonly hasMore: boolean;
}
export interface ClaudeSdkDiscovery {
  readonly models: readonly ModelInfo[];
  readonly commands: readonly SlashCommand[];
  readonly diagnostics: ClaudeRuntimeDiagnostics;
  readonly intelligence: ClaudeResolvedIntelligence;
}
export interface ClaudeSdkDiscoveryInput {
  readonly instance: ClaudeAgentInstanceConfig;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly allowPathDiscovery?: boolean;
  readonly cwd: string;
}
interface HistoryInput extends ClaudeSdkDiscoveryInput {
  readonly sessionId: string;
}
export type ClaudeNativeScopeInput = Pick<ClaudeSdkDiscoveryInput, "instance" | "environment">;
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
    readonly discover: (
      input: ClaudeSdkDiscoveryInput,
    ) => Effect.Effect<ClaudeSdkDiscovery, AgentRuntimeError, Scope.Scope>;
    readonly configuration: (
      input: Pick<ClaudeSdkDiscoveryInput, "instance" | "environment" | "cwd">,
    ) => Effect.Effect<Pick<Settings, "skillOverrides">, AgentRuntimeError>;
    readonly historyPage: (
      input: HistoryInput,
      page?: { readonly before?: string; readonly limit?: number },
    ) => Effect.Effect<ClaudeNativeHistoryPage, AgentRuntimeError>;
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
/** Native discovery can inspect configuration but cannot submit work or acquire application tools. */
export const claudeDiscoveryOptions = (
  input: ClaudeSdkDiscoveryInput,
  executable: string,
): Options => {
  const environment = claudeEnvironment(input.environment, input.instance);
  environment.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  delete environment.FORCE_CODE_TERMINAL;
  environment.CLAUDE_CODE_AUTO_CONNECT_IDE = "0";
  environment.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = "1";
  return {
    cwd: input.cwd,
    pathToClaudeCodeExecutable: executable,
    env: environment,
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    tools: [],
    allowedTools: [],
    permissionMode: "dontAsk",
    allowDangerouslySkipPermissions: false,
    persistSession: false,
    settings: { disableAllHooks: true },
    mcpServers: {},
    strictMcpConfig: true,
  };
};
const discover = Effect.fn("ClaudeSdk.discover")(function* (
  input: ClaudeSdkDiscoveryInput,
  executable: string,
) {
  const session = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        query({
          prompt: Stream.toAsyncIterable(Stream.never),
          options: claudeDiscoveryOptions(input, executable),
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
  const nativeSettings = session as typeof session & { getSettings?: () => Promise<unknown> };
  const settings =
    typeof nativeSettings.getSettings === "function"
      ? yield* call("intelligence read", () => nativeSettings.getSettings!()).pipe(
          Effect.catch(() => Effect.void),
        )
      : undefined;
  return {
    models: initialized.models ?? [],
    commands: initialized.commands ?? [],
    intelligence: resolveClaudeIntelligence({
      settings,
      models: initialized.models ?? [],
      customModels: input.instance.customModels,
      environment: claudeEnvironment(input.environment, input.instance),
      acknowledged: {},
      ...(initialized.fast_mode_state ? { fastState: initialized.fast_mode_state } : {}),
    }),
    diagnostics: {
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
    },
  } satisfies ClaudeSdkDiscovery;
});

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
    | "configuration"
    | "image"
    | "tool-output",
  options: {
    readonly before?: string | null;
    readonly limit?: number;
    readonly nativeMessageId?: string;
    readonly index?: number;
    readonly toolUseId?: string;
    readonly offset?: number;
    readonly records?: readonly import("@anthropic-ai/claude-agent-sdk").SessionStoreEntry[];
    readonly hasMore?: boolean;
  } = {},
) =>
  Effect.callback<A, AgentRuntimeError>((resume) => {
    const worker = new Worker(
      `
    const { parentPort, workerData } = require("node:worker_threads");
    const isPrompt = ${isClaudeHistoryPrompt.toString()};
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
      if (workerData.operation === "session-info") {post(metadata(await sdk.getSessionInfo(workerData.sessionId)));return;}
      const store = { append: async()=>{throw new Error("History cannot write native records");}, load: async(key)=>key.sessionId===workerData.sessionId ? workerData.options.records : null };
      const entries = await sdk.getSessionMessages(workerData.sessionId,{includeSystemMessages:true,limit:workerData.options.records.length,offset:0,sessionStore:store});
      if (workerData.operation === "image") { post(readImage(entries,workerData.options.nativeMessageId,workerData.options.index,isPrompt));return; }
      if (workerData.operation === "tool-output") { post(readToolOutput(entries,workerData.options.nativeMessageId,workerData.options.toolUseId,boundOutput));return; }
      post(withoutInlineImages({messages:entries,before:workerData.options.before??null,hasMore:workerData.options.hasMore===true}));
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
  Effect.gen(function* () {
    const home = yield* nativeHome(input);
    const selected = yield* Effect.tryPromise({
      try: () => readClaudeHistoryRecords({ home, sessionId: input.sessionId, ...page }),
      catch: (cause) => failure("history", cause),
    });
    return yield* nativeOperation<ClaudeNativeHistoryPage>(input, "history", {
      records: selected.entries,
      before: selected.before,
      hasMore: selected.hasMore,
    });
  });
const historyImage: ClaudeSdk["Service"]["historyImage"] = (input, nativeMessageId, index) =>
  Effect.gen(function* () {
    const home = yield* nativeHome(input);
    const records = yield* Effect.tryPromise({
      try: () => readClaudeHistoryRecord({ home, sessionId: input.sessionId, nativeMessageId }),
      catch: (cause) => failure("image", cause),
    });
    return yield* nativeOperation<AgentPromptImage>(input, "image", {
      records,
      nativeMessageId,
      index,
    });
  });
const historyToolOutput: ClaudeSdk["Service"]["historyToolOutput"] = (
  input,
  nativeMessageId,
  toolUseId,
) =>
  Effect.gen(function* () {
    const home = yield* nativeHome(input);
    const records = yield* Effect.tryPromise({
      try: () => readClaudeHistoryRecord({ home, sessionId: input.sessionId, nativeMessageId }),
      catch: (cause) => failure("tool-output", cause),
    });
    return yield* nativeOperation<AgentToolOutput>(input, "tool-output", {
      records,
      nativeMessageId,
      toolUseId,
    });
  });
const configuration: ClaudeSdk["Service"]["configuration"] = (input) =>
  nativeOperation({ ...input, sessionId: "" }, "configuration");
const nativeHome: ClaudeSdk["Service"]["nativeHome"] = (input) => nativeOperation(input, "home");
const listSessions: ClaudeSdk["Service"]["listSessions"] = (input, offset) =>
  nativeOperation(input, "catalog", { offset });
const sessionInfo: ClaudeSdk["Service"]["sessionInfo"] = (input, sessionId) =>
  nativeOperation({ ...input, sessionId }, "session-info");
export const live = Layer.effect(
  ClaudeSdk,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const shellEnvironment = yield* WorktreeShellEnvironmentRuntime;
    const discoverMetadata = Effect.fn("ClaudeSdk.discoverMetadata")(function* (
      input: ClaudeSdkDiscoveryInput,
    ) {
      const explicitPath = input.instance.environment.some(({ name }) =>
        config.platform === "win32" ? name.toUpperCase() === "PATH" : name === "PATH",
      );
      const launch = yield* resolveClaudeLaunch(
        {
          binary: input.instance.binaryPath,
          environment: claudeEnvironment(input.environment, input.instance),
          platform: config.platform,
          cwd: input.cwd,
          allowPathDiscovery: !explicitPath && input.allowPathDiscovery !== false,
        },
        shellEnvironment.load,
      ).pipe(Effect.mapError((cause) => failure("launch", cause)));
      return yield* discover({ ...input, environment: launch.environment }, launch.executable);
    });
    return ClaudeSdk.of({
      nativeHome,
      listSessions,
      sessionInfo,
      discover: discoverMetadata,
      historyPage,
      configuration,
      historyImage,
      historyToolOutput,
    });
  }),
);
