import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import type {
  NativeSearchHistoryInput,
  NativeSearchHistoryState,
  NativeSearchItem,
} from "@nodex/agent-runtime/orchestration/NativeSearchHistory";
import { nativeSearchThreadId } from "@nodex/agent-runtime/orchestration/NativeSearchHistory";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import { CoreModules } from "../core-runtime/CoreModules";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { CodexMainConversationManagers } from "../codex-application/CodexMainConversationManagers";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { row } from "./ChatSearch.test-support";
import { make } from "./NativeChatSearchIndex";

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

/** Publishes from a fiber the test clock wakes, so advancing the clock also waits for every
 * fiber the published signal resumes. */
const publish = <A>(pubsub: PubSub.PubSub<A>, value: A) =>
  PubSub.publish(pubsub, value).pipe(Effect.delay("1 millis"), Effect.forkChild, Effect.asVoid);

/** One native Codex chat on a host, with the Core, gateway and Runtime fakes the index reads. */
const indexed = (mode: "paginated" | "legacy") =>
  Effect.gen(function* () {
    const host = mode === "legacy" ? "local" : "remote";
    const world = {
      revision: 1,
      running: false,
      offline: false,
      unreadable: false,
      listed: true,
      ready: mode !== "legacy",
      native: [message("one", "database 中文"), command, file],
      /** Native host history reads. */
      reads: 0,
      /** Core reads of every native chat, and of changed chats by identity. */
      scans: 0,
      lookups: 0,
      pruned: [] as (readonly string[])[],
      items: new Map<string, NativeSearchItem>(),
      state: { cursor: null, complete: false } as NativeSearchHistoryState,
    };
    let knownRevision = "";
    const invalidations = yield* PubSub.unbounded<ProjectSessionsChangeEvent>();
    const endpointEvents = yield* PubSub.unbounded<CodexEndpointEvent>();
    const base = row("native", "Other topic", "native");
    const current = () => ({
      ...base,
      task: {
        ...base.task,
        thread: {
          ...base.task.thread!,
          execution_host_id: host,
          updated_at: world.revision,
          status: { status_type: world.running ? "active" : "idle", active_flags: [] },
        },
      },
    });
    yield* make.pipe(
      Effect.provideService(CoreModules, {
        workspace: {
          read: (input: { archived: boolean; session_ids?: readonly string[] }) =>
            Effect.sync(() => {
              if (input.session_ids) world.lookups++;
              else world.scans++;
              const listed =
                world.listed && !input.archived && (input.session_ids?.includes("native") ?? true);
              return {
                value: {
                  kind: "session_window",
                  sessions: { items: listed ? [current()] : [], next_cursor: null },
                },
              };
            }),
        },
      } as never),
      Effect.provideService(DatabaseNotifierRuntime, {
        projectSessionInvalidations: Stream.fromPubSub(invalidations),
      } as never),
      Effect.provideService(AgentRuntimeApplication, {
        syncNativeSearchHistory: (input: NativeSearchHistoryInput) =>
          Effect.sync(() => {
            if (input.kind === "admit" && input.revision !== knownRevision) {
              knownRevision = input.revision;
              world.state = { ...world.state, complete: false };
            }
            if (input.kind === "page") {
              assert.isAtMost(input.items.length, 24);
              input.items.forEach((item) => world.items.set(item.itemId, item));
              world.state = { cursor: input.cursor, complete: input.complete };
            }
            if (input.kind === "reset") {
              world.items.clear();
              world.state = { cursor: null, complete: false };
            }
            if (input.kind === "prune") world.pruned.push(input.threadIds);
            return world.state;
          }),
      } as never),
      Effect.provideService(CodexMainConversationManagers, {
        get: (requested: string) =>
          Effect.sync(() => {
            assert.equal(requested, host);
            return { generation: 7, assertCurrent: () => undefined };
          }),
      } as never),
      Effect.provideService(CodexGateway, {
        localHostId: "local",
        events: Stream.fromPubSub(endpointEvents),
        awaitReady: () =>
          Effect.sync(() => {
            world.ready = true;
          }),
        connection: () =>
          Effect.succeed(
            world.offline
              ? { kind: "idle" }
              : world.ready
                ? { kind: "ready", generation: 7 }
                : { kind: "stopped" },
          ),
        requestOnHost: (
          requested: string,
          method: string,
          input: { cursor: string | null; limit: number },
          options: { expectedGeneration: number },
        ) =>
          Effect.gen(function* () {
            world.reads++;
            assert.equal(requested, host);
            if (world.unreadable) return yield* Effect.fail(new Error("History unavailable"));
            if (method === "thread/read") return { thread: { historyMode: mode } };
            if (mode === "legacy") {
              assert.equal(method, "thread/turns/list");
              return {
                data: [
                  {
                    id: "legacy-turn",
                    status: world.running ? "inProgress" : "completed",
                    items: world.native.map((entry) => entry.item),
                    startedAt: 1,
                    completedAt: world.running ? null : 2,
                  },
                ],
                nextCursor: null,
                backwardsCursor: "0",
              };
            }
            assert.equal(method, "thread/items/list");
            assert.equal(options.expectedGeneration, 7);
            if (world.offline) return yield* Effect.fail(new Error("Offline"));
            const start = input.cursor ? Number(input.cursor) : 0;
            const data = world.native.slice(start, start + input.limit);
            return {
              data,
              nextCursor:
                start + data.length < world.native.length ? String(start + data.length) : null,
              backwardsCursor: data.length ? String(start + data.length - 1) : null,
            };
          }),
      } as never),
    );
    /** Rounds run at most once a second; each reads at most one page per chat. */
    const round = TestClock.adjust("1 second");
    /** Core commits a change to the chat's row and notifies Main. */
    const changed = publish(invalidations, {
      summaryScopes: [{ kind: "project", projectId: "project" }],
      detailInvalidation: { kind: "sessions", sessionIds: ["native"] },
      changeType: "update",
    }).pipe(Effect.andThen(round));
    const connection = (value: CodexEndpointEvent & { kind: "connection" }) =>
      publish(endpointEvents, value).pipe(Effect.andThen(round));
    return { world, host, round, changed, connection };
  });

for (const mode of ["paginated", "legacy"] as const)
  it.effect(
    `backfills ${mode} native host history, defers streaming text and recovers a removed anchor`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { world, host, round, changed, connection } = yield* indexed(mode);
          yield* round;
          assert.isTrue(world.state.complete);
          assert.equal(world.items.get("one")?.text, "database 中文");
          assert.equal(world.items.get("command")?.text, "printf marigold");
          assert.equal(world.items.get("command")?.role, "command_execution");
          assert.equal(world.items.get("file")?.text, "new.ts\nold.ts");
          assert.equal(world.items.get("file")?.role, "file_change");
          assert.deepEqual(world.pruned, [[nativeSearchThreadId(host, "native")]]);
          const before = { reads: world.reads, scans: world.scans };
          yield* round;
          assert.deepEqual({ reads: world.reads, scans: world.scans }, before);
          world.revision++;
          world.running = true;
          world.native.push(message("two", "unfinished", false));
          yield* changed;
          assert.equal(world.scans, before.scans);
          assert.equal(world.lookups, 2);
          assert.isFalse(world.state.complete);
          assert.isFalse(world.items.has("two"));
          world.revision++;
          world.running = false;
          world.native = [...world.native.slice(0, 3), message("two", "finished")];
          yield* changed;
          assert.isTrue(world.state.complete);
          assert.equal(
            world.items.get("two")?.runId,
            mode === "legacy" ? "legacy-turn" : "turn:two",
          );
          // A host that drops leaves its chats partial; when it is ready again they catch up
          // without any change to their Core rows.
          world.offline = true;
          yield* connection({ kind: "connection", value: { kind: "closing", hostId: host } });
          assert.isFalse(world.state.complete);
          assert.equal(world.items.size, 4);
          world.offline = false;
          world.native = [message("replacement", "new history")];
          yield* connection({
            kind: "connection",
            value: { kind: "ready", hostId: host, generation: 7 },
          });
          assert.equal(world.items.size, 0);
          assert.isFalse(world.state.complete);
          yield* round;
          assert.isTrue(world.state.complete);
          assert.equal(world.items.get("replacement")?.text, "new history");
          world.revision++;
          world.native.push(
            ...Array.from({ length: 60 }, (_, i) => message(`bulk:${i}`, "more history")),
          );
          yield* changed;
          yield* round.pipe(Effect.repeat({ until: () => world.state.complete }));
          assert.equal(world.items.size, 61);
          world.revision++;
          world.unreadable = true;
          yield* changed;
          assert.isFalse(world.state.complete);
          assert.equal(world.items.size, 61);
          const failedReads = world.reads;
          yield* round;
          assert.equal(world.reads, failedReads);
          yield* TestClock.adjust("4 seconds");
          assert.isAbove(world.reads, failedReads);
          world.unreadable = false;
          world.revision++;
          yield* changed;
          assert.isTrue(world.state.complete);
          assert.notEqual(
            nativeSearchThreadId("remote", "native"),
            nativeSearchThreadId("local", "native"),
          );
        }),
      ),
  );

it.effect("stays idle without changes, and a periodic sweep catches up and prunes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { world, round } = yield* indexed("paginated");
      yield* round;
      assert.isTrue(world.state.complete);
      const settled = { reads: world.reads, scans: world.scans, lookups: world.lookups };
      yield* TestClock.adjust("4 minutes");
      assert.deepEqual({ reads: world.reads, scans: world.scans, lookups: world.lookups }, settled);
      // A change whose notice never reached Main waits for the next sweep.
      world.revision++;
      world.native.push(message("late", "swept history"));
      yield* TestClock.adjust("59 seconds");
      assert.isFalse(world.items.has("late"));
      assert.equal(world.scans, settled.scans);
      yield* TestClock.adjust("1 second");
      assert.equal(world.scans, settled.scans + 2);
      assert.equal(world.items.get("late")?.text, "swept history");
      assert.isTrue(world.state.complete);
      world.listed = false;
      yield* TestClock.adjust("5 minutes");
      assert.deepEqual(world.pruned.at(-1), []);
    }),
  ),
);
