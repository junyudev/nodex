import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AutomationApplication } from "../automation-application/AutomationApplication";
import { CoreModules } from "../core-runtime/CoreModules";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexConversationFork } from "./CodexConversationFork";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { CodexProjectSessionFork } from "./CodexProjectSessionFork";
import { CodexReadThreadHistory } from "./CodexReadThreadHistory";
import { CodexSessionThreadLaunch } from "./CodexSessionThreadLaunch";
import { CodexSidebarSectionSync } from "./CodexSidebarSectionSync";
import { CodexThreadCatalog } from "./CodexThreadCatalog";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadHandoffRuntime } from "./CodexThreadHandoffRuntime";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { ConversationCommands } from "./ConversationCommands";
import { make } from "./CodexAppProtocolTools";

interface Calls {
  coreReads: number;
  directoryReads: number;
  automationWrites: number;
  historyReads: number;
  turns: number;
  titles: number;
  archives: number;
  conversationForks: number;
  worktreeForks: number;
  handoffs: number;
}

const makeCalls = (): Calls => ({
  coreReads: 0,
  directoryReads: 0,
  automationWrites: 0,
  historyReads: 0,
  turns: 0,
  titles: 0,
  archives: 0,
  conversationForks: 0,
  worktreeForks: 0,
  handoffs: 0,
});

const buildTools = (backend: "codex" | "acp", calls: Calls) =>
  make.pipe(
    Effect.provideService(
      CoreModules,
      CoreModules.of({
        workspace: {
          read: () =>
            Effect.sync(() => {
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
          return { durable: { sessionId: "session-target" } } as never;
        }),
    } as unknown as CodexThreadDirectory["Service"]),
    Effect.provideService(AutomationApplication, {
      definitions: {
        create: () =>
          Effect.sync(() => {
            calls.automationWrites += 1;
            return {} as never;
          }),
        get: () => Effect.succeed({} as never),
        update: () =>
          Effect.sync(() => {
            calls.automationWrites += 1;
            return {} as never;
          }),
      },
    } as unknown as AutomationApplication["Service"]),
    Effect.provideService(CodexReadThreadHistory, {
      read: () =>
        Effect.sync(() => {
          calls.historyReads += 1;
          return {} as never;
        }),
    } as unknown as CodexReadThreadHistory["Service"]),
    Effect.provideService(CodexTurnCommands, {
      start: () =>
        Effect.sync(() => {
          calls.turns += 1;
        }),
    } as unknown as CodexTurnCommands["Service"]),
    Effect.provideService(CodexThreadTitlePersistence, {
      set: () =>
        Effect.sync(() => {
          calls.titles += 1;
        }),
    } as unknown as CodexThreadTitlePersistence["Service"]),
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
      get: () => Effect.succeed(null),
      launch: () =>
        Effect.sync(() => {
          calls.handoffs += 1;
          return {} as never;
        }),
    } as unknown as CodexThreadHandoffRuntime["Service"]),
    Effect.provideService(CodexApplicationEventHub, {
      publish: () => undefined,
    } as unknown as CodexApplicationEventHub["Service"]),
    Effect.provideService(
      CodexPendingServerRequestRuntime,
      {} as CodexPendingServerRequestRuntime["Service"],
    ),
    Effect.provideService(CodexSessionThreadLaunch, {} as CodexSessionThreadLaunch["Service"]),
    Effect.provideService(CodexSidebarSectionSync, {} as CodexSidebarSectionSync["Service"]),
    Effect.provideService(CodexThreadCatalog, {} as CodexThreadCatalog["Service"]),
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
      call("automation_update", {
        mode: "create",
        kind: "heartbeat",
        name: "No",
        prompt: "No",
        rrule: "FREQ=HOURLY",
        status: "ACTIVE",
        targetThreadId: target,
      }),
      call("automation_update", {
        mode: "update",
        id: "automation-no",
        kind: "heartbeat",
        name: "No",
        prompt: "No",
        rrule: "FREQ=HOURLY",
        status: "ACTIVE",
        targetThreadId: target,
      }),
    ];

    for (const attempt of attempts) {
      const response = yield* tools.execute(attempt as never);
      assert.isFalse(response.success);
      assert.match(JSON.stringify(response), /not owned by the Codex Agent Backend/);
    }

    assert.strictEqual(calls.coreReads, attempts.length);
    assert.strictEqual(calls.directoryReads, 0);
    assert.strictEqual(calls.automationWrites, 0);
    assert.strictEqual(calls.historyReads, 0);
    assert.strictEqual(calls.turns, 0);
    assert.strictEqual(calls.titles, 0);
    assert.strictEqual(calls.archives, 0);
    assert.strictEqual(calls.conversationForks, 0);
    assert.strictEqual(calls.worktreeForks, 0);
    assert.strictEqual(calls.handoffs, 0);
  }),
);

it.effect("admits a Core-owned Codex target before sending a message", () =>
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
