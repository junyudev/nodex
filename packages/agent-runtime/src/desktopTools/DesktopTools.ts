import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  type CallToolRequest,
  type CallToolResult,
  type ElicitRequest,
  type ElicitResult,
  type ListToolsRequest,
  type Progress,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpProviderDesktopTools } from "@nodex/provider-core/server/mcpSession";
import type { HostDesktopTools, HostTurnIdentity } from "@nodex/provider-core/server/ExecutionHost";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@nodex/runtime-contracts";
import * as Context from "effect/Context";
import type { RuntimeApprovals } from "../orchestration-v2/RuntimeApprovals.ts";
import {
  codexMcpApprovalOptions,
  codexMcpApprovalResponse,
  codexMcpElicitationPolicy,
  isCodexMcpPermissionRequest,
} from "../provider/CodexMcpElicitation.ts";
import { field } from "../orchestration-v2/unknownField.ts";
import { makeCaptures, publicArguments } from "./Captures.ts";
import { makeRepl } from "./Repl.ts";
import { readDesktopToolSkills } from "./Skills.ts";

export const desktopToolsPath = "/mcp/node_repl";
const turnMetadataKey = "x-codex-turn-metadata";
const timeout = 65 * 60_000;

export interface DesktopCaller {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface DesktopInvocationAuthority {
  readonly identity: HostTurnIdentity;
  readonly runtimeMode: RuntimeMode;
}

interface Launch {
  readonly tools: HostDesktopTools;
  readonly cwd: string | null;
}

interface Turn {
  readonly identity: HostTurnIdentity;
  readonly metadata: { session_id: string; thread_id: string; turn_id: string };
  readonly controller: AbortController;
  started?: Promise<void>;
}

interface Invocation {
  readonly turn: Turn;
  readonly runtimeMode: RuntimeMode;
  readonly signal: AbortSignal;
}

interface Ports {
  readonly admit: (caller: DesktopCaller) => Promise<DesktopInvocationAuthority | undefined>;
  readonly observe: (input: {
    readonly identity: HostTurnIdentity;
    readonly nativeThreadId: string;
    readonly nativeTurnId: string;
    readonly phase: "started" | "ended";
  }) => Promise<void>;
  readonly ask: (
    input: Parameters<RuntimeApprovals["Service"]["ask"]>[0],
  ) => Promise<ProviderApprovalDecision>;
  readonly isAllowedForChat: (threadId: ThreadId) => Promise<boolean>;
  readonly environment?: NodeJS.ProcessEnv;
}

export function desktopSessionId(threadId: ThreadId): string {
  return createHash("sha256").update(threadId).digest("hex");
}

const codeOptions: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Allow JavaScript for this chat" },
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Decline and stop" },
];
const toolError = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});
const terminal = (status: string) => status !== "running" && status !== "pending";

function hidden(tool: Tool): boolean {
  const visibility = field(tool._meta?.ui, "visibility");
  return tool.name === "turn_ended" || (Array.isArray(visibility) && visibility.length === 0);
}

export function makeDesktopTools(home: string, ports: Ports) {
  const captures = makeCaptures();
  const threads = new Map<ThreadId, Thread>();
  let closed = false;

  const observe = (turn: Turn, phase: "started" | "ended") =>
    ports
      .observe({
        identity: turn.identity,
        nativeThreadId: turn.metadata.thread_id,
        nativeTurnId: turn.metadata.turn_id,
        phase,
      })
      .catch(() => {});

  const makeThread = (threadId: ThreadId, launch: Launch) => {
    const invocations = new Map<string, Invocation>();
    const turns = new Map<string, Turn>();
    const hooks = new Set<Promise<void>>();
    const retirements = new Set<Promise<void>>();
    let activeProvider: ProviderInstanceId;
    let closing = false;
    const repl = makeRepl({
      home,
      sessionId: desktopSessionId(threadId),
      server: launch.tools.server,
      cwd: launch.cwd,
      // The provider's account and the workspace's setup do not configure this launcher.
      environment: ports.environment ?? process.env,
      async elicit(params, signal) {
        // The REPL echoes the originating call ID. Its reverse request has its own progress token.
        const callId = params._meta?.callId;
        const invocation = typeof callId === "string" ? invocations.get(callId) : undefined;
        if (
          !invocation ||
          !isDeepStrictEqual(params._meta?.[turnMetadataKey], invocation.turn.metadata)
        )
          return { action: "decline" };
        return await elicit(params, invocation, AbortSignal.any([invocation.signal, signal]));
      },
    });

    const end = (turn: Turn, hook: "Stop" | "Interrupt") => {
      if (!turns.delete(turn.identity.attemptId)) return Promise.resolve();
      turn.controller.abort();
      if (!turn.started) return Promise.resolve();
      const cleanup = Promise.resolve()
        .then(async () => {
          await repl.running()?.request(
            {
              method: "tools/call",
              params: {
                name: "turn_ended",
                arguments: {
                  hook_event_name: hook,
                  session_id: turn.metadata.session_id,
                  turn_id: turn.metadata.turn_id,
                },
              },
            },
            CallToolResultSchema,
            { timeout: 3_000 },
          );
        })
        .catch(() => {})
        .finally(() => {
          hooks.delete(cleanup);
        });
      hooks.add(cleanup);
      const retiring = Promise.all([turn.started, cleanup])
        .then(() => observe(turn, "ended"))
        .finally(() => retirements.delete(retiring));
      retirements.add(retiring);
      return retiring;
    };
    const close = async () => {
      closing = true;
      for (const turn of turns.values()) void end(turn, "Interrupt");
      // The Main connection can already be closing during Runtime shutdown.
      await Promise.all(hooks);
      await repl.close();
      await Promise.all(retirements);
    };
    return {
      launch,
      repl,
      invocations,
      turns,
      end,
      close,
      whenRetired: () => Promise.all(retirements),
      closing: () => closing,
      provider: () => activeProvider,
      setProvider: (provider: ProviderInstanceId) => {
        activeProvider = provider;
      },
    };
  };
  type Thread = ReturnType<typeof makeThread>;

  async function elicit(
    params: ElicitRequest["params"],
    invocation: Invocation,
    signal: AbortSignal,
  ): Promise<ElicitResult> {
    if (signal.aborted) return { action: "cancel" };
    const { identity, metadata } = invocation.turn;
    const payload = {
      ...params,
      mode: params.mode ?? "form",
      _meta: params._meta ?? null,
      serverName: "node_repl",
      threadId: metadata.thread_id,
      turnId: metadata.turn_id,
    } as Parameters<typeof codexMcpElicitationPolicy>[0];
    const policy = codexMcpElicitationPolicy(payload, {
      fullAccess: invocation.runtimeMode === "full-access",
    });
    if (policy === "accept") return { action: "accept", content: {} };
    if (policy === "decline" || !isCodexMcpPermissionRequest(payload)) return { action: "decline" };
    const connector = field(payload._meta, "connector_name");
    const decision = await ports.ask({
      threadId: identity.threadId,
      runId: identity.runId,
      attemptId: identity.attemptId,
      kind: "mcp-elicitation",
      prompt: payload.message,
      appName: typeof connector === "string" ? connector : payload.serverName,
      options: codexMcpApprovalOptions(payload),
      signal,
    });
    return codexMcpApprovalResponse(payload, signal.aborted ? "cancel" : decision) as ElicitResult;
  }

  const lookup = (caller: DesktopCaller) => {
    const thread = threads.get(caller.threadId);
    return thread?.provider() === caller.providerInstanceId ? thread : undefined;
  };

  const pendingCloses = new Map<ThreadId, Promise<void>>();
  const remove = (threadId: ThreadId) => {
    const thread = threads.get(threadId);
    threads.delete(threadId);
    const previous = pendingCloses.get(threadId);
    if (!thread) return previous ?? Promise.resolve();
    const closing = Promise.all([previous, thread.close()]).then(() => {
      if (pendingCloses.get(threadId) === closing) pendingCloses.delete(threadId);
    });
    pendingCloses.set(threadId, closing);
    return closing;
  };
  const prepare = async (
    caller: DesktopCaller,
    endpoint: string,
    launch?: Launch,
  ): Promise<McpProviderDesktopTools | undefined> => {
    if (closed) return undefined;
    if (!launch) {
      void remove(caller.threadId);
      return undefined;
    }
    const old = threads.get(caller.threadId);
    const replace =
      old === undefined ||
      old.launch.cwd !== launch.cwd ||
      !isDeepStrictEqual(old.launch.tools.server, launch.tools.server);
    const thread = replace ? makeThread(caller.threadId, launch) : old;
    if (replace) void remove(caller.threadId);
    thread.setProvider(caller.providerInstanceId);
    threads.set(caller.threadId, thread);
    const skills = await readDesktopToolSkills(launch.tools.pluginRoots);
    if (lookup(caller) !== thread) return undefined;
    return {
      endpoint: new URL(desktopToolsPath, endpoint).href,
      pluginRoots: launch.tools.pluginRoots,
      skills,
    };
  };

  const getClient = async (caller: DesktopCaller, expected: Thread, signal?: AbortSignal) => {
    // Prepare can publish the new launcher while the old process group is draining.
    await pendingCloses.get(caller.threadId);
    signal?.throwIfAborted();
    if (lookup(caller) !== expected) throw new Error("Desktop tools are unavailable");
    return await expected.repl.get();
  };

  const initialize = async (caller: DesktopCaller, signal?: AbortSignal) => {
    const thread = lookup(caller);
    if (!thread) throw new Error("Desktop tools are unavailable");
    const client = await getClient(caller, thread, signal);
    return {
      version: client.getServerVersion()?.version ?? "1",
      instructions: client.getInstructions(),
    };
  };

  const list = async (
    caller: DesktopCaller,
    params: ListToolsRequest["params"],
    signal: AbortSignal,
  ) => {
    const thread = lookup(caller);
    if (!thread) throw new Error("Desktop tools are unavailable");
    const client = await getClient(caller, thread, signal);
    const result = await client.request({ method: "tools/list", params }, ListToolsResultSchema, {
      signal,
    });
    return {
      ...result,
      tools: result.tools
        .filter((tool) => !hidden(tool))
        .map(({ annotations: _annotations, ...tool }) => ({
          ...tool,
          _meta: { ...tool._meta, "anthropic/alwaysLoad": true },
        })),
    };
  };

  const approveCode = async (invocation: Invocation, params: CallToolRequest["params"]) => {
    if (invocation.signal.aborted) return false;
    if (params.name !== "js" && params.name !== "js_add_node_module_dir") return true;
    if (invocation.runtimeMode === "full-access") return true;
    const { threadId, runId, attemptId } = invocation.turn.identity;
    if (await ports.isAllowedForChat(threadId)) return !invocation.signal.aborted;
    if (invocation.signal.aborted) return false;
    const prompt =
      params.name === "js"
        ? params.arguments?.code
        : (params.arguments?.path ?? params.arguments?.dir ?? params.arguments?.directory);
    if (typeof prompt !== "string") return false;
    const decision = await ports.ask({
      threadId,
      runId,
      attemptId,
      kind: "command",
      prompt,
      options: codeOptions,
      // Recorded with the answer, so a crash between the two cannot lose the person's choice.
      chatGrant: "desktop-tools-javascript",
      signal: invocation.signal,
    });
    if (invocation.signal.aborted) return false;
    return decision === "accept" || decision === "acceptForSession";
  };

  const call = async (
    caller: DesktopCaller,
    params: CallToolRequest["params"],
    requestSignal: AbortSignal,
    onprogress: (progress: Progress) => void,
  ): Promise<CallToolResult> => {
    const thread = lookup(caller);
    if (!thread) return toolError("Desktop tools are unavailable");
    if (params.name === "turn_ended") return toolError("Tool is reserved for the host");
    const authority = await ports.admit(caller);
    if (!authority || lookup(caller) !== thread || requestSignal.aborted)
      return toolError("Desktop tools require an active turn");
    const { identity, runtimeMode } = authority;
    const sessionId = desktopSessionId(caller.threadId);
    const turn: Turn = thread.turns.get(identity.attemptId) ?? {
      identity,
      metadata: { session_id: sessionId, thread_id: sessionId, turn_id: identity.attemptId },
      controller: new AbortController(),
    };
    thread.turns.set(identity.attemptId, turn);
    const signal = AbortSignal.any([requestSignal, turn.controller.signal]);
    const invocation: Invocation = { turn, runtimeMode, signal };
    const callId = randomUUID();
    const args = publicArguments(params.arguments) as CallToolRequest["params"]["arguments"];
    const startedAtMs = Date.now();
    thread.invocations.set(callId, invocation);

    const execute = async (): Promise<CallToolResult> => {
      // Subscribe before rechecking so retirement during the first admission read cannot be missed.
      const live = await ports.admit(caller);
      if (live?.identity.attemptId !== identity.attemptId || signal.aborted)
        return toolError("Desktop tool call cancelled");
      const client = await getClient(caller, thread, signal);
      let cursor: string | undefined;
      let visible = false;
      const visited = new Set<string>();
      do {
        const page = await client.request(
          { method: "tools/list", params: cursor === undefined ? undefined : { cursor } },
          ListToolsResultSchema,
          { signal },
        );
        const entry = page.tools.find((tool) => tool.name === params.name);
        if (entry) {
          visible = !hidden(entry);
          break;
        }
        cursor = page.nextCursor;
        if (cursor !== undefined && (visited.has(cursor) || visited.size === 32)) break;
        if (cursor !== undefined) visited.add(cursor);
      } while (cursor !== undefined);
      if (!visible) return toolError("Desktop tool is unavailable");
      if (!(await approveCode(invocation, params)))
        return toolError("Desktop tool execution was declined");
      if (turn.started === undefined) await thread.whenRetired();
      if (signal.aborted || lookup(caller) !== thread)
        return toolError("Desktop tool call cancelled");
      turn.started ??= observe(turn, "started");
      await turn.started;
      if (signal.aborted || lookup(caller) !== thread)
        return toolError("Desktop tool call cancelled");
      return await client.request(
        {
          method: "tools/call",
          params: {
            name: params.name,
            arguments: args,
            _meta: { callId, [turnMetadataKey]: turn.metadata },
          },
        },
        CallToolResultSchema,
        { signal, timeout, onprogress },
      );
    };

    try {
      const result = await execute().catch(() =>
        toolError(signal.aborted ? "Desktop tool call cancelled" : "Desktop tool call failed"),
      );
      if (!thread.closing())
        captures.record({
          threadId: caller.threadId,
          runId: identity.runId,
          attemptId: identity.attemptId,
          tool: params.name,
          arguments: args ?? {},
          result,
          startedAtMs,
          updatedAtMs: Date.now(),
          status: signal.aborted ? "cancelled" : result.isError ? "failed" : "completed",
        });
      return result;
    } finally {
      thread.invocations.delete(callId);
    }
  };

  return {
    prepare,
    initialize,
    list,
    call,
    has: (caller: DesktopCaller) => lookup(caller) !== undefined,
    enrich: captures.enrich,
    hasCaptures: captures.has,
    retire(threadId: ThreadId, match: (identity: HostTurnIdentity) => boolean, status: string) {
      if (!terminal(status)) return;
      const thread = threads.get(threadId);
      if (!thread) return;
      for (const turn of thread.turns.values())
        if (match(turn.identity))
          void thread.end(turn, status === "completed" ? "Stop" : "Interrupt");
    },
    async closeThread(threadId: ThreadId) {
      captures.clear(threadId);
      await remove(threadId);
    },
    async close() {
      closed = true;
      for (const threadId of threads.keys()) void remove(threadId);
      await Promise.all(pendingCloses.values());
    },
  };
}

export class DesktopTools extends Context.Service<
  DesktopTools,
  ReturnType<typeof makeDesktopTools>
>()("nodex/agent-runtime/DesktopTools") {}
