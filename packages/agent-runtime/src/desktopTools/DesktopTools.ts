import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CallToolResultSchema,
  ErrorCode,
  ListToolsResultSchema,
  McpError,
  type CallToolRequest,
  type CallToolResult,
  type ElicitRequest,
  type ElicitResult,
  type ListToolsRequest,
  type Progress,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpProviderDesktopTools } from "@nodex/provider-core/server/mcpSession";
import { desktopToolResultActivity } from "@nodex/provider-core/server/desktopToolActivity";
import type {
  DesktopTurnObservation,
  HostDesktopTools,
  HostTurnIdentity,
  HostTurnIdentityReport,
} from "@nodex/provider-core/server/ExecutionHost";
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
import { replSandboxMetadata, type ReplExecutionPolicy } from "./ReplSandboxState.ts";
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
  readonly executionPolicy?: ReplExecutionPolicy;
  started?: Promise<void>;
  runningJavaScript: number;
}

interface Invocation {
  readonly turn: Turn;
  readonly runtimeMode: RuntimeMode;
  readonly signal: AbortSignal;
}

interface Ports {
  readonly admit: (caller: DesktopCaller) => Promise<DesktopInvocationAuthority | undefined>;
  readonly observe: (input: HostTurnIdentityReport) => Promise<void>;
  readonly ask: (
    input: Parameters<RuntimeApprovals["Service"]["ask"]>[0],
  ) => Promise<ProviderApprovalDecision>;
  readonly isAllowedForChat: (threadId: ThreadId) => Promise<boolean>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly attachmentsDir?: string;
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
const resetReasons = {
  permissionMode: "the chat's permission mode changed",
  executionPolicy: "the chat's execution policy changed",
  cwd: "the chat's working directory changed",
  idle: "the chat's JavaScript session was idle",
  stopped: "the previous JavaScript call was stopped",
  timeout: "the previous JavaScript call timed out",
  reset: "the Agent reset the JavaScript session",
  restarted: "the JavaScript runtime restarted",
  unavailable: "Desktop Tools became unavailable",
  archived: "the chat was archived",
} as const;

type ResetReason = keyof typeof resetReasons;
interface ResetNotice {
  readonly reason: ResetReason;
}
interface JavaScriptSession {
  remembered?: Promise<void>;
  notice?: ResetNotice;
}

const terminal = (status: string) => status !== "running" && status !== "pending";

const sameRunOwner = (a: HostTurnIdentity, b: HostTurnIdentity) =>
  a.runId === b.runId &&
  a.attemptId === b.attemptId &&
  a.providerInstanceId === b.providerInstanceId &&
  a.providerSessionId === b.providerSessionId &&
  a.providerThreadId === b.providerThreadId &&
  a.nativeGeneration === b.nativeGeneration;

/** Settles with `work`, or rejects as soon as `signal` aborts and leaves `work` running. */
const whileWaiting = <A>(work: Promise<A>, signal: AbortSignal) =>
  new Promise<A>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });

function hidden(tool: Tool): boolean {
  const visibility = field(tool._meta?.ui, "visibility");
  return tool.name === "turn_ended" || (Array.isArray(visibility) && visibility.length === 0);
}

/**
 * A chat keeps its JavaScript kernel, and the bindings its Agent built, while it is in use. A
 * kernel no turn has used for this long is released with its process tree; the chat's next
 * call starts a fresh one.
 */
const REPL_IDLE_RELEASE_MS = 30 * 60_000;

export function makeDesktopTools(
  home: string,
  ports: Ports,
  options: { readonly replIdleReleaseMs?: number } = {},
) {
  const replIdleReleaseMs = options.replIdleReleaseMs ?? REPL_IDLE_RELEASE_MS;
  const captures = makeCaptures();
  const threads = new Map<ThreadId, Thread>();
  const javaScriptSessions = new Map<ThreadId, JavaScriptSession>();
  const sessionMarker = (threadId: ThreadId) =>
    join(home, "desktop-repl-sessions", desktopSessionId(threadId));
  const runPolicies = new Map<
    ThreadId,
    {
      readonly identity: HostTurnIdentity;
      readonly policy: ReplExecutionPolicy;
    }
  >();
  const managesSandbox = process.platform === "darwin";
  let closed = false;

  const prepareRun = (
    identity: HostTurnIdentity,
    runtimeMode: RuntimeMode,
    sourceRoots: readonly string[],
  ) => {
    if (closed || !managesSandbox) return;
    const previous = runPolicies.get(identity.threadId);
    if (previous && sameRunOwner(previous.identity, identity)) return;
    const writableRoots = [identity.cwd, ...sourceRoots, ports.attachmentsDir].filter(
      (path): path is string => typeof path === "string" && isAbsolute(path),
    );
    const thread = threads.get(identity.threadId);
    const retired = previous && thread?.turns.get(previous.identity.attemptId);
    if (thread && retired) void thread.end(retired, "Interrupt");
    runPolicies.set(identity.threadId, {
      identity,
      policy: { runtimeMode, cwd: identity.cwd, writableRoots: [...new Set(writableRoots)].sort() },
    });
  };

  const observe = (turn: Turn, observation: DesktopTurnObservation) =>
    ports
      .observe({
        identity: turn.identity,
        nativeThreadId: turn.metadata.thread_id,
        nativeTurnId: turn.metadata.turn_id,
        ...observation,
      })
      .catch(() => {});

  const makeThread = (threadId: ThreadId, launch: Launch) => {
    const session = javaScriptSessions.get(threadId) ?? {};
    javaScriptSessions.set(threadId, session);
    const invocations = new Map<string, Invocation>();
    const turns = new Map<string, Turn>();
    // Calls still running in the kernel after their caller stopped waiting. See `call`.
    const abandoned = new Set<Promise<void>>();
    const hooks = new Set<Promise<void>>();
    const retirements = new Set<Promise<void>>();
    let activeProvider: ProviderInstanceId;
    let closing = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const inUse = () => turns.size > 0 || invocations.size > 0 || abandoned.size > 0;
    const keepKernel = () => {
      clearTimeout(idle);
      idle = undefined;
    };
    const releaseWhenIdle = () => {
      keepKernel();
      if (closing || inUse()) return;
      idle = setTimeout(() => {
        idle = undefined;
        if (!closing && !inUse()) void releaseKernel("idle");
      }, replIdleReleaseMs);
      idle.unref?.();
    };
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

    type ReplClient = Awaited<ReturnType<typeof repl.get>>;
    let javaScriptClient: ReplClient | undefined;
    const noteReset = (reason: ResetReason, client = javaScriptClient) => {
      if (!javaScriptClient || javaScriptClient !== client) return;
      if (repl.running() !== javaScriptClient) reason = "restarted";
      javaScriptClient = undefined;
      // Retain the reason bindings were first lost if no call has reported it yet.
      // A new notice also keeps a late result from the retired kernel from consuming it.
      session.notice = { reason: session.notice?.reason ?? reason };
    };
    const releaseKernel = (reason: ResetReason) => {
      noteReset(reason);
      return repl.release();
    };
    const rememberSession = () =>
      (session.remembered ??= mkdir(sessionMarker(threadId), { recursive: true })
        .then((created) => {
          // A Runtime restart can't keep the kernel. Remember only chats that used JavaScript.
          if (created === undefined) session.notice ??= { reason: "restarted" };
        })
        .catch((error: unknown) => {
          delete session.remembered;
          throw error;
        }));
    const useJavaScript = (client: ReplClient) => {
      if (javaScriptClient !== client) noteReset("restarted");
      javaScriptClient = client;
      return session.notice;
    };
    const withResetNotice = (result: CallToolResult, notice: ResetNotice | undefined) => {
      if (!notice || session.notice !== notice) return result;
      delete session.notice;
      return {
        ...result,
        content: [
          {
            type: "text" as const,
            text: `This JavaScript call started a fresh session because ${resetReasons[notice.reason]}. Bindings from earlier calls are gone. Set them up again.`,
          },
          ...result.content,
        ],
      };
    };

    let appliedPolicy: ReplExecutionPolicy | undefined;
    let clientQueue = Promise.resolve();
    const client = (policy?: ReplExecutionPolicy, validate?: () => void) => {
      if (!managesSandbox) return repl.get();
      const pending = clientQueue.then(async () => {
        validate?.();
        if (policy && !isDeepStrictEqual(appliedPolicy, policy)) {
          const previousCwd = appliedPolicy ? appliedPolicy.cwd : launch.cwd;
          if (policy.cwd !== previousCwd) await releaseKernel("cwd");
          else if (appliedPolicy)
            await releaseKernel(
              policy.runtimeMode !== appliedPolicy.runtimeMode
                ? "permissionMode"
                : "executionPolicy",
            );
          validate?.();
          appliedPolicy = policy;
        }
        return await repl.get(appliedPolicy ? appliedPolicy.cwd : launch.cwd);
      });
      clientQueue = pending.then(
        () => {},
        () => {},
      );
      return pending;
    };
    const sandboxMetadata = (policy: ReplExecutionPolicy | undefined) => {
      if (!policy) return {};
      const scratchRoot = repl.scratchRoot();
      if (!scratchRoot) throw new Error("Desktop Tool scratch directory unavailable");
      return replSandboxMetadata(
        policy,
        policy.cwd ?? process.cwd(),
        scratchRoot,
        launch.tools.server.env.CODEX_CLI_PATH,
      );
    };

    const end = (turn: Turn, hook: "Stop" | "Interrupt") => {
      if (!turns.delete(turn.identity.attemptId)) return Promise.resolve();
      if (turn.runningJavaScript > 0) noteReset("stopped");
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
                ...(turn.executionPolicy ? { _meta: sandboxMetadata(turn.executionPolicy) } : {}),
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
        .then(() => observe(turn, { phase: "ended", completed: hook === "Stop" }))
        .finally(() => {
          retirements.delete(retiring);
          releaseWhenIdle();
        });
      retirements.add(retiring);
      return retiring;
    };
    const close = async () => {
      closing = true;
      keepKernel();
      for (const turn of turns.values()) void end(turn, "Interrupt");
      // The Main connection can already be closing during Runtime shutdown.
      await Promise.all(hooks);
      await repl.close();
      await Promise.all(retirements);
    };
    return {
      launch,
      client,
      sandboxMetadata,
      noteReset,
      rememberSession,
      useJavaScript,
      withResetNotice,
      invocations,
      abandoned,
      turns,
      end,
      close,
      whenRetired: () => Promise.all(retirements),
      closing: () => closing,
      keepKernel,
      releaseWhenIdle,
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
  const remove = (threadId: ThreadId, reason?: ResetReason) => {
    const thread = threads.get(threadId);
    threads.delete(threadId);
    const previous = pendingCloses.get(threadId);
    if (!thread) return previous ?? Promise.resolve();
    if (reason) thread.noteReset(reason);
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
      void remove(caller.threadId, "unavailable");
      return undefined;
    }
    const old = threads.get(caller.threadId);
    const cwdChanged = old !== undefined && old.launch.cwd !== launch.cwd;
    const replace =
      !old || cwdChanged || !isDeepStrictEqual(old.launch.tools.server, launch.tools.server);
    const thread = replace ? makeThread(caller.threadId, launch) : old;
    if (replace && old) void remove(caller.threadId, cwdChanged ? "cwd" : "restarted");
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

  const getClient = async (
    caller: DesktopCaller,
    expected: Thread,
    signal?: AbortSignal,
    policy?: ReplExecutionPolicy,
    assertCurrent?: () => void,
  ) => {
    // Prepare can publish the new launcher while the old process group is draining.
    await pendingCloses.get(caller.threadId);
    signal?.throwIfAborted();
    if (lookup(caller) !== expected) throw new Error("Desktop tools are unavailable");
    return await expected.client(policy, assertCurrent ?? (() => signal?.throwIfAborted()));
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
    const prepared = runPolicies.get(caller.threadId);
    if (managesSandbox && (!prepared || !sameRunOwner(prepared.identity, identity)))
      return toolError("Desktop tool execution policy is unavailable");
    const sessionId = desktopSessionId(caller.threadId);
    const turn: Turn = thread.turns.get(identity.attemptId) ?? {
      identity,
      metadata: { session_id: sessionId, thread_id: sessionId, turn_id: identity.attemptId },
      controller: new AbortController(),
      runningJavaScript: 0,
      ...(prepared ? { executionPolicy: prepared.policy } : {}),
    };
    thread.turns.set(identity.attemptId, turn);
    thread.keepKernel();
    const signal = AbortSignal.any([requestSignal, turn.controller.signal]);
    const invocation: Invocation = { turn, runtimeMode, signal };
    const callId = randomUUID();
    const args = publicArguments(params.arguments) as CallToolRequest["params"]["arguments"];
    const startedAtMs = Date.now();
    thread.invocations.set(callId, invocation);

    const assertCurrent = () => {
      signal.throwIfAborted();
      if (
        lookup(caller) !== thread ||
        (managesSandbox && runPolicies.get(caller.threadId) !== prepared)
      )
        throw new Error("Desktop tool execution policy was retired");
    };

    let resultNotice: ResetNotice | undefined;
    const execute = async (): Promise<CallToolResult> => {
      // Subscribe before rechecking so retirement during the first admission read cannot be missed.
      const live = await ports.admit(caller);
      if (live?.identity.attemptId !== identity.attemptId || signal.aborted)
        return toolError("Desktop tool call cancelled");
      const discovery = await getClient(caller, thread, signal);
      let cursor: string | undefined;
      let visible = false;
      const visited = new Set<string>();
      do {
        const page = await discovery.request(
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
      turn.started ??= observe(turn, { phase: "started" });
      await turn.started;
      if (signal.aborted || lookup(caller) !== thread)
        return toolError("Desktop tool call cancelled");
      // One kernel runs this Thread's calls, so a call its caller gave up on finishes first.
      await whileWaiting(Promise.all(thread.abandoned), signal);
      const executesJavaScript = params.name === "js";
      const usesJavaScript = executesJavaScript || params.name === "js_add_node_module_dir";
      if (usesJavaScript) await thread.rememberSession();
      if (turn.executionPolicy) {
        const current = await ports.admit(caller);
        if (!current || !sameRunOwner(current.identity, identity))
          return toolError("Desktop tool call cancelled");
      }
      assertCurrent();
      const client = await getClient(caller, thread, signal, turn.executionPolicy, assertCurrent);
      assertCurrent();
      const sandbox = thread.sandboxMetadata(turn.executionPolicy);
      const notice = usesJavaScript ? thread.useJavaScript(client) : undefined;
      // The REPL can only cancel running JavaScript by resetting its kernel, which discards
      // every binding the Agent has built. A caller that stops waiting, as a provider does when
      // a new message redirects its turn, is not a reason to do that: the call belongs to the
      // Run attempt, finishes on its own, and is cancelled upstream only when the attempt ends.
      if (executesJavaScript) turn.runningJavaScript++;
      const running = client
        .request(
          {
            method: "tools/call",
            params: {
              name: params.name,
              arguments: args,
              _meta: {
                callId,
                [turnMetadataKey]: turn.metadata,
                ...sandbox,
              },
            },
          },
          CallToolResultSchema,
          {
            signal: turn.controller.signal,
            timeout,
            onprogress: (progress) => {
              if (!requestSignal.aborted) onprogress(progress);
            },
          },
        )
        .then(
          (result) => {
            if (params.name === "js_reset" && !result.isError && lookup(caller) === thread)
              thread.noteReset("reset", client);
            return result;
          },
          (error: unknown) => {
            if (
              executesJavaScript &&
              !turn.controller.signal.aborted &&
              lookup(caller) === thread &&
              error instanceof McpError &&
              error.code === Number(ErrorCode.RequestTimeout)
            )
              thread.noteReset("timeout", client);
            throw error;
          },
        )
        .finally(() => {
          if (executesJavaScript) turn.runningJavaScript--;
        });
      const result = await whileWaiting(running, requestSignal).catch((error: unknown) => {
        if (!turn.controller.signal.aborted && requestSignal.aborted) {
          const settled = running.then(
            () => {},
            () => {},
          );
          thread.abandoned.add(settled);
          void settled.then(() => {
            thread.abandoned.delete(settled);
            thread.releaseWhenIdle();
          });
        }
        throw error;
      });
      if (executesJavaScript) resultNotice = notice;
      return result;
    };

    try {
      const output = await execute().catch(() =>
        toolError(signal.aborted ? "Desktop tool call cancelled" : "Desktop tool call failed"),
      );
      const activity = desktopToolResultActivity(callId, output);
      if (activity && !signal.aborted && lookup(caller) === thread)
        await observe(turn, { phase: "activity", activity });
      const result =
        !signal.aborted && lookup(caller) === thread
          ? thread.withResetNotice(output, resultNotice)
          : output;
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
      thread.releaseWhenIdle();
    }
  };

  return {
    prepare,
    managesSandbox,
    prepareRun,
    initialize,
    list,
    call,
    has: (caller: DesktopCaller) => lookup(caller) !== undefined,
    enrich: captures.enrich,
    hasCaptures: captures.has,
    retire(threadId: ThreadId, match: (identity: HostTurnIdentity) => boolean, status: string) {
      if (!terminal(status)) return;
      const prepared = runPolicies.get(threadId);
      if (prepared && match(prepared.identity)) runPolicies.delete(threadId);
      const thread = threads.get(threadId);
      if (!thread) return;
      for (const turn of thread.turns.values())
        if (match(turn.identity))
          void thread.end(turn, status === "completed" ? "Stop" : "Interrupt");
    },
    async closeThread(threadId: ThreadId, deleted = false) {
      captures.clear(threadId);
      runPolicies.delete(threadId);
      await remove(threadId, deleted ? undefined : "archived");
      if (!deleted) return;
      const session = javaScriptSessions.get(threadId);
      javaScriptSessions.delete(threadId);
      await session?.remembered?.catch(() => {});
      await rm(sessionMarker(threadId), { recursive: true, force: true });
    },
    async close() {
      closed = true;
      runPolicies.clear();
      for (const threadId of threads.keys()) void remove(threadId);
      await Promise.all(pendingCloses.values());
    },
  };
}

export class DesktopTools extends Context.Service<
  DesktopTools,
  ReturnType<typeof makeDesktopTools>
>()("nodex/agent-runtime/DesktopTools") {}
