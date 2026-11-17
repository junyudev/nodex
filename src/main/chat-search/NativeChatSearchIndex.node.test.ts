import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type { ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import type {
  NativeSearchHistoryInput,
  NativeSearchHistoryState,
  NativeSearchItem,
} from "@nodex/agent-runtime/orchestration/NativeSearchHistory";
import { nativeSearchThreadId } from "@nodex/agent-runtime/orchestration/NativeSearchHistory";
import { CoreModules } from "../core-runtime/CoreModules";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexMainConversationManagers } from "../codex-application/CodexMainConversationManagers";
import { row } from "./ChatSearch.test-support";
import { make } from "./NativeChatSearchIndex";

for (const mode of ["paginated", "legacy"] as const)
  it.effect(
    `backfills ${mode} native host history, defers streaming text and recovers a removed anchor`,
    () =>
      Effect.gen(function* () {
        let revision = 1,
          running = false,
          offline = false,
          unreadable = false,
          reads = 0;
        const host = mode === "legacy" ? "local" : "remote";
        let ready = mode !== "legacy";
        const items = new Map<string, NativeSearchItem>();
        let state: NativeSearchHistoryState = { cursor: null, complete: false };
        let knownRevision = "";
        const message = (id: string, text: string, completed = true): ThreadItemEntry => ({
          turnId: `turn:${id}`,
          item: {
            type: "agentMessage",
            id,
            text,
            phase: null,
            memoryCitation: null,
            delivery: null,
            questions: null,
          },
          startedAtMs: 1,
          completedAtMs: completed ? 2 : null,
        });
        const command: ThreadItemEntry = {
          turnId: "tools",
          startedAtMs: 1,
          completedAtMs: 2,
          item: {
            type: "commandExecution",
            id: "command",
            pluginId: null,
            scriptPath: null,
            command: "printf marigold",
            cwd: "/workspace",
            processId: null,
            source: "agent",
            status: "completed",
            commandActions: [],
            aggregatedOutput: "excluded output",
            exitCode: 0,
            durationMs: 1,
          },
        };
        const file: ThreadItemEntry = {
          turnId: "tools",
          startedAtMs: 1,
          completedAtMs: 2,
          item: {
            type: "fileChange",
            id: "file",
            status: "completed",
            changes: [
              {
                path: "new.ts",
                kind: { type: "update", move_path: "old.ts" },
                diff: "excluded diff",
              },
            ],
          },
        };
        let native = [message("one", "database 中文"), command, file];
        const base = row("native", "Other topic", "native");
        const refresh = yield* make.pipe(
          Effect.provideService(CoreModules, {
            workspace: {
              read: (input: { archived: boolean }) =>
                Effect.succeed({
                  value: {
                    kind: "session_window",
                    sessions: {
                      items: input.archived
                        ? []
                        : [
                            {
                              ...base,
                              task: {
                                ...base.task,
                                thread: {
                                  ...base.task.thread!,
                                  execution_host_id: host,
                                  updated_at: revision,
                                  status: {
                                    status_type: running ? "active" : "idle",
                                    active_flags: [],
                                  },
                                },
                              },
                            },
                          ],
                      next_cursor: null,
                    },
                  },
                }),
            },
          } as never),
          Effect.provideService(AgentRuntimeApplication, {
            syncNativeSearchHistory: (input: NativeSearchHistoryInput) =>
              Effect.sync(() => {
                if (input.kind === "admit" && input.revision !== knownRevision) {
                  knownRevision = input.revision;
                  state = { ...state, complete: false };
                }
                if (input.kind === "page") {
                  assert.isAtMost(input.items.length, 24);
                  input.items.forEach((item) => items.set(item.itemId, item));
                  state = { cursor: input.cursor, complete: input.complete };
                }
                if (input.kind === "reset") {
                  items.clear();
                  state = { cursor: null, complete: false };
                }
                return state;
              }),
          } as never),
          Effect.provideService(CodexMainConversationManagers, {
            get: (host: string) =>
              Effect.sync(() => {
                assert.equal(host, mode === "legacy" ? "local" : "remote");
                return { generation: 7, assertCurrent: () => undefined };
              }),
          } as never),
          Effect.provideService(CodexGateway, {
            localHostId: "local",
            awaitReady: () =>
              Effect.sync(() => {
                ready = true;
              }),
            connection: () =>
              Effect.succeed(
                offline
                  ? { kind: "idle" }
                  : ready
                    ? { kind: "ready", generation: 7 }
                    : { kind: "stopped" },
              ),
            requestOnHost: (
              host: string,
              method: string,
              input: { cursor: string | null; limit: number },
              options: { expectedGeneration: number },
            ) =>
              Effect.gen(function* () {
                reads++;
                assert.equal(host, mode === "legacy" ? "local" : "remote");
                if (unreadable) return yield* Effect.fail(new Error("History unavailable"));
                if (method === "thread/read") return { thread: { historyMode: mode } };
                if (mode === "legacy") {
                  assert.equal(method, "thread/turns/list");
                  return {
                    data: [
                      {
                        id: "legacy-turn",
                        status: running ? "inProgress" : "completed",
                        items: native.map((entry) => entry.item),
                        startedAt: 1,
                        completedAt: running ? null : 2,
                      },
                    ],
                    nextCursor: null,
                    backwardsCursor: "0",
                  };
                }
                assert.equal(method, "thread/items/list");
                assert.equal(options.expectedGeneration, 7);
                if (offline) return yield* Effect.fail(new Error("Offline"));
                const start = input.cursor ? Number(input.cursor) : 0;
                const data = native.slice(start, start + input.limit);
                return {
                  data,
                  nextCursor:
                    start + data.length < native.length ? String(start + data.length) : null,
                  backwardsCursor: data.length ? String(start + data.length - 1) : null,
                };
              }),
          } as never),
        );
        yield* refresh;
        assert.isTrue(state.complete);
        assert.equal(items.get("one")?.text, "database 中文");
        assert.equal(items.get("command")?.text, "printf marigold");
        assert.equal(items.get("command")?.role, "command_execution");
        assert.equal(items.get("file")?.text, "new.ts\nold.ts");
        assert.equal(items.get("file")?.role, "file_change");
        const before = reads;
        yield* refresh;
        assert.equal(reads, before);
        revision++;
        running = true;
        native.push(message("two", "unfinished", false));
        yield* refresh;
        assert.isFalse(state.complete);
        assert.isFalse(items.has("two"));
        revision++;
        running = false;
        native = [...native.slice(0, 3), message("two", "finished")];
        yield* refresh;
        assert.isTrue(state.complete);
        assert.equal(items.get("two")?.runId, mode === "legacy" ? "legacy-turn" : "turn:two");
        revision++;
        offline = true;
        yield* refresh;
        assert.isFalse(state.complete);
        assert.equal(items.size, 4);
        offline = false;
        native = [message("replacement", "new history")];
        yield* refresh;
        assert.equal(items.size, 0);
        assert.isFalse(state.complete);
        yield* refresh;
        assert.isTrue(state.complete);
        assert.equal(items.get("replacement")?.text, "new history");
        revision++;
        native.push(...Array.from({ length: 60 }, (_, i) => message(`bulk:${i}`, "more history")));
        yield* refresh.pipe(Effect.repeat({ until: () => state.complete }));
        assert.equal(items.size, 61);
        revision++;
        unreadable = true;
        yield* refresh;
        assert.isFalse(state.complete);
        assert.equal(items.size, 61);
        const failedReads = reads;
        yield* refresh;
        assert.equal(reads, failedReads);
        yield* TestClock.adjust("5 seconds");
        yield* refresh;
        assert.isAbove(reads, failedReads);
        unreadable = false;
        revision++;
        yield* refresh;
        assert.isTrue(state.complete);
        assert.notEqual(
          nativeSearchThreadId("remote", "native"),
          nativeSearchThreadId("local", "native"),
        );
      }),
  );
