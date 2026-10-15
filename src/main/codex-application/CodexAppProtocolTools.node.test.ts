import { CoreModuleResponseError } from "../core-client/core-client";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CodexWaitThreads } from "./CodexWaitThreads";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CoreModules } from "../core-runtime/CoreModules";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexConversationFork } from "./CodexConversationFork";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { CodexProjectSessionFork } from "./CodexProjectSessionFork";
import { CodexReadThreadHistory } from "./CodexReadThreadHistory";
import {
  AppToolInvocationInbox,
  type AppToolInvocation,
} from "../app-tools/AppToolInvocationInbox";
import { CodexApplicationRequestInbox } from "../codex-runtime/CodexApplicationRequestInbox";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexSidebarSectionSync } from "./CodexSidebarSectionSync";
import { CodexThreadCatalog } from "./CodexThreadCatalog";
import { CodexThreadDescriptionPersistence } from "./CodexThreadDescriptionPersistence";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadHandoffRuntime } from "./CodexThreadHandoffRuntime";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import { CodexDelegatedMessages } from "./CodexDelegatedMessages";
import { ConversationCommands } from "./ConversationCommands";
import { make } from "./CodexAppProtocolTools";

interface Calls {
  nativeCommands: AppToolInvocation[];
  nativeActive: boolean;
  coreReads: number;
  directoryReads: number;
  historyReads: number;
  turns: number;
  titles: number;
  archives: number;
  conversationForks: number;
  worktreeForks: number;
  handoffs: number;
  handoffInputs: { operationId: string; requestThreadId?: string; threadTitle?: string }[];
}

const makeCalls = (): Calls => ({
  nativeCommands: [],
  nativeActive: true,
  coreReads: 0,
  directoryReads: 0,
  historyReads: 0,
  turns: 0,
  titles: 0,
  archives: 0,
  conversationForks: 0,
  worktreeForks: 0,
  handoffs: 0,
  handoffInputs: [],
});

const buildTools = (
  backend: "codex" | "acp",
  calls: Calls,
  missing = false,
  hostId = "ssh:builder",
) =>
  make.pipe(
    Effect.provideService(
      CoreModules,
      CoreModules.of({
        workspace: {
          read: () =>
            missing
              ? Effect.fail(
                  coreRuntimeError({
                    operation: "workspace.read",
                    reason: "operation",
                    retryable: false,
                    cause: new CoreModuleResponseError({
                      code: "not_found",
                      message: "Thread not found",
                      retryable: false,
                      recovery: { kind: "none" },
                    }),
                  }),
                )
              : Effect.sync(() => {
                  calls.coreReads += 1;
                  return {
                    value: {
                      kind: "thread",
                      thread: {
                        backend_binding:
                          backend === "codex"
                            ? { kind: "codex" }
                            : {
                                kind: "acp",
                                agent_definition_id: "claude-agent-acp",
                                instance_config_id: "claude:default",
                              },
                      },
                    },
                  } as never;
                }),
        },
      } as never),
    ),
    Effect.provideService(CodexThreadDirectory, {
      resolve: () =>
        Effect.sync(() => {
          calls.directoryReads += 1;
          return {
            durable: { sessionId: "session-target", executionHostId: hostId },
            summary: {
              threadName: "**Target** [task](https://example.com)",
              threadPreview: "",
            },
          } as never;
        }),
    } as unknown as CodexThreadDirectory["Service"]),
    Effect.provideService(CodexReadThreadHistory, {
      read: () =>
        Effect.sync(() => {
          calls.historyReads += 1;
          return {} as never;
        }),
    } as unknown as CodexReadThreadHistory["Service"]),
    Effect.provideService(CodexDelegatedMessages, {
      send: () =>
        Effect.sync(() => {
          calls.turns += 1;
        }),
    } as unknown as CodexDelegatedMessages["Service"]),
    Effect.provideService(CodexThreadTitlePersistence, {
      set: () =>
        Effect.sync(() => {
          calls.titles += 1;
        }),
    } as unknown as CodexThreadTitlePersistence["Service"]),
    Effect.provideService(CodexThreadDescriptionPersistence, {
      get: () => Effect.succeed(null),
      set: () => Effect.void,
    }),
    Effect.provideService(ConversationCommands, {
      archive: () =>
        Effect.sync(() => {
          calls.archives += 1;
        }),
      unarchive: () =>
        Effect.sync(() => {
          calls.archives += 1;
        }),
    } as unknown as ConversationCommands["Service"]),
    Effect.provideService(CodexConversationFork, {
      fork: () =>
        Effect.sync(() => {
          calls.conversationForks += 1;
          return { threadId: "forked" } as never;
        }),
    } as unknown as CodexConversationFork["Service"]),
    Effect.provideService(CodexProjectSessionFork, {
      fork: () =>
        Effect.sync(() => {
          calls.worktreeForks += 1;
          return { pendingWorktreeId: "pending" } as never;
        }),
    } as unknown as CodexProjectSessionFork["Service"]),
    Effect.provideService(CodexThreadHandoffRuntime, {
      get: (operationId: string) =>
        Effect.succeed(
          calls.handoffInputs.find((input) => input.operationId === operationId) ?? null,
        ),
      launch: (input: { operationId: string; requestThreadId?: string; threadTitle?: string }) =>
        Effect.sync(() => {
          calls.handoffs += 1;
          calls.handoffInputs.push(input);
          return input as never;
        }),
    } as unknown as CodexThreadHandoffRuntime["Service"]),
    Effect.provideService(CodexApplicationEventHub, {
      publish: () => undefined,
    } as unknown as CodexApplicationEventHub["Service"]),
    Effect.provideService(
      CodexPendingServerRequestRuntime,
      {} as CodexPendingServerRequestRuntime["Service"],
    ),
    Effect.provideService(AppToolInvocationInbox, {
      invoke: (input: AppToolInvocation) =>
        Effect.sync(() => {
          calls.nativeCommands.push(input);
          return {
            content: [],
            structuredContent: { sessionId: "runtime-session", threadId: "runtime-thread" },
          };
        }),
    } as unknown as AppToolInvocationInbox["Service"]),
    Effect.provideService(CodexApplicationRequestInbox, {
      captureNativeTurnSource: () => Effect.succeed({ isActive: () => calls.nativeActive }),
    } as unknown as CodexApplicationRequestInbox["Service"]),
    Effect.provideService(CodexMainConversationManagers, {
      current: () => ({
        assertCurrent: (generation: number) => {
          if (generation !== 7 || !calls.nativeActive) throw new Error("Native generation retired");
        },
      }),
    } as unknown as CodexMainConversationManagers["Service"]),
    Effect.provideService(CodexSidebarSectionSync, {} as CodexSidebarSectionSync["Service"]),
    Effect.provideService(CodexThreadCatalog, {} as CodexThreadCatalog["Service"]),
    Effect.provideService(CodexWaitThreads, { execute: () => Effect.die("unused wait tool") }),
    Effect.provideService(TerminalSessions, {} as TerminalSessions["Service"]),
  );

const call = (tool: string, arguments_: Record<string, unknown>) => ({
  threadId: "thread-caller",
  turnId: "turn-caller",
  callId: `call-${tool}`,
  namespace: "codex_app",
  tool,
  arguments: arguments_,
});

it.effect("rejects ACP-owned targets before invoking any Codex thread owner", () =>
  Effect.gen(function* () {
    const calls = makeCalls();
    const tools = yield* buildTools("acp", calls);
    const target = "thread-acp";
    const attempts = [
      call("read_thread", { threadId: target }),
      call("send_message_to_thread", { threadId: target, prompt: "Continue." }),
      call("set_thread_title", { threadId: target, title: "No" }),
      call("set_thread_archived", { threadId: target, archived: true }),
      call("fork_thread", { threadId: target, environment: { type: "same-directory" } }),
      call("fork_thread", { threadId: target, environment: { type: "worktree" } }),
      call("handoff_thread", { threadId: target }),
    ];

    for (const attempt of attempts) {
      const response = yield* tools.execute(attempt as never);
      assert.isFalse(response.success);
      assert.match(JSON.stringify(response), /not owned by the Codex Agent Backend/);
    }

    assert.strictEqual(calls.coreReads, attempts.length);
    assert.strictEqual(calls.directoryReads, 0);
    assert.strictEqual(calls.historyReads, 0);
    assert.strictEqual(calls.turns, 0);
    assert.strictEqual(calls.titles, 0);
    assert.strictEqual(calls.archives, 0);
    assert.strictEqual(calls.conversationForks, 0);
    assert.strictEqual(calls.worktreeForks, 0);
    assert.strictEqual(calls.handoffs, 0);
  }),
);

it.effect("admits an explicitly remote Core-owned Codex target before sending a message", () =>
  Effect.gen(function* () {
    const calls = makeCalls();
    const tools = yield* buildTools("codex", calls);

    const response = yield* tools.execute(
      call("send_message_to_thread", {
        threadId: "thread-codex",
        prompt: "Continue.",
      }) as never,
    );

    assert.isTrue(response.success);
    assert.strictEqual(calls.coreReads, 1);
    assert.strictEqual(calls.directoryReads, 1);
    assert.strictEqual(calls.turns, 1);
  }),
);

it.effect(
  "keeps a repeated handoff call attached to one operation and its requesting conversation",
  () =>
    Effect.gen(function* () {
      const calls = makeCalls();
      const tools = yield* buildTools("codex", calls);
      const request = call("handoff_thread", { threadId: "thread-target" });
      const first = yield* tools.execute(request as never);
      const second = yield* tools.execute(request as never);
      assert.isTrue(first.success);
      assert.deepEqual(second, first);
      assert.strictEqual(calls.handoffs, 1);
      assert.strictEqual(calls.handoffInputs[0]?.requestThreadId, request.threadId);
      assert.strictEqual(calls.handoffInputs[0]?.threadTitle, "Target task");
    }),
);

it.effect("read_thread can inspect a native task before durable workspace import", () =>
  Effect.gen(function* () {
    const calls = makeCalls();
    const tools = yield* buildTools("codex", calls, true);
    const response = yield* tools.execute(
      call("read_thread", { threadId: "native-only" }) as never,
    );
    assert.isTrue(response.success);
    assert.strictEqual(calls.historyReads, 1);
    assert.strictEqual(calls.directoryReads, 0);
  }),
);

it.effect(
  "local native tool Session writes retain original source and enter the Runtime owner",
  () =>
    Effect.gen(function* () {
      const calls = makeCalls();
      const tools = yield* buildTools("codex", calls, false, "local");
      const context = { nativeSource: { hostId: "local", generation: 7 } };
      const source = call("create_thread", {
        prompt: "Build",
        target: { type: "projectless" },
        thinking: "high",
      });
      assert.isTrue((yield* tools.execute(source as never, context)).success);
      assert.isTrue((yield* tools.execute(source as never, context)).success);
      assert.deepEqual(calls.nativeCommands[0]?.arguments, {
        prompt: "Build",
        target: { type: "projectless" },
        reasoningEffort: "high",
      });
      assert.deepEqual(calls.nativeCommands[0]?.arguments, calls.nativeCommands[1]?.arguments);
      assert.equal(calls.nativeCommands[0]?.caller.turnId, "turn-caller");
      assert.equal(calls.nativeCommands[0]?.caller.callId, source.callId);
      assert.equal(calls.nativeCommands[0]?.caller.generation, 7);
      assert.equal(calls.coreReads, 0);
      assert.isTrue(
        (yield* tools.execute(
          call("send_message_to_thread", { threadId: "target", prompt: "Continue" }) as never,
          context,
        )).success,
      );
      assert.isTrue(
        (yield* tools.execute(call("fork_thread", { threadId: "target" }) as never, context))
          .success,
      );
      assert.deepEqual(
        calls.nativeCommands.slice(2).map((input) => [input.name, input.arguments]),
        [
          ["send_message_to_session", { sessionId: "session-target", prompt: "Continue" }],
          ["fork_session", { sessionId: "session-target" }],
        ],
      );
      assert.equal(calls.turns, 0);
      assert.equal(calls.conversationForks, 0);
      assert.equal(calls.worktreeForks, 0);
      calls.nativeActive = false;
      assert.isFalse(calls.nativeCommands[0]?.caller.isActive());
      assert.isFalse((yield* tools.execute(source as never, context)).success);
      assert.equal(calls.nativeCommands.length, 4);
    }),
);
