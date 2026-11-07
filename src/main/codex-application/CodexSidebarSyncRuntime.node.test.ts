import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { CoreModules } from "../core-runtime/CoreModules";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { make, type CodexSidebarSyncRuntimeOptions } from "./CodexSidebarSyncRuntime";
const setup = (
  read: CoreModules["Service"]["workspace"]["read"],
  options: CodexSidebarSyncRuntimeOptions = {},
  events: Stream.Stream<unknown> = Stream.never,
) =>
  make(options).pipe(
    Effect.provideService(CoreModules, {
      workspace: { read, apply: () => Effect.die("Catalog observation cannot write ownership") },
    } as never),
    Effect.provideService(DatabaseNotifierRuntime, {
      projectSessionInvalidations: events,
    } as never),
    Effect.provideService(CodexApplicationEventHub, { publish: () => {} } as never),
    Effect.provideService(ExecutionHostRuntime, { hosts: () => Effect.succeed([]) } as never),
  );
const page = (next: string | null = null) =>
  ({
    value: {
      kind: "sidebar_overview",
      pinned_tasks: { items: [], next_cursor: next, authority: { projection_revision: 7 } },
    },
  }) as never;
it.effect("mount, focus, forced refresh and notifications only project stored Core metadata", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const catalog = yield* setup((input) =>
      Effect.sync(() => {
        calls.push(input);
        return page();
      }),
    );
    const first = yield* catalog.sync({ policy: "stale", reason: "mount" });
    assert.equal(first.source, "core");
    assert.isFalse(first.refreshed);
    assert.equal(first.snapshot.revision, 7);
    yield* catalog.sync({ policy: "stale", reason: "focus" });
    assert.equal(calls.length, 1);
    yield* catalog.sync({ policy: "force", reason: "manual" });
    assert.equal(calls.length, 2);
    catalog.scheduleNotification({
      threadId: "native-engine-thread",
      notificationMethod: "thread/started",
    });
    yield* Effect.yieldNow;
    assert.equal(calls.length, 2);
    yield* catalog.sync({ policy: "read" });
    assert.equal(calls.length, 3);
    assert.isTrue(calls.every((input) => (input as { kind: string }).kind === "sidebar_overview"));
  }),
);
it.effect(
  "Core invalidations refresh the bounded stored projection without any native endpoint service",
  () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<unknown>();
      let reads = 0;
      const catalog = yield* setup(
        () =>
          Effect.sync(() => {
            reads++;
            return page();
          }),
        {},
        Stream.fromPubSub(events),
      );
      yield* catalog.sync();
      yield* PubSub.publish(events, {});
      yield* Effect.yieldNow;
      yield* catalog.sync();
      assert.equal(reads, 2);
    }),
);
it.effect(
  "pinned windows reject repeated cursors and page-budget overflow without partial metadata",
  () =>
    Effect.gen(function* () {
      for (const options of [{ maxPages: 3 }, { maxPages: 1 }]) {
        let reads = 0;
        const catalog = yield* setup(
          () =>
            Effect.sync(() => {
              reads++;
              return page("same-cursor");
            }),
          options,
        );
        assert.equal((yield* Effect.exit(catalog.sync({ policy: "force" })))._tag, "Failure");
        assert.equal(reads, options.maxPages === 1 ? 1 : 2);
      }
    }),
);

const archivedTask = (id: string, pinned: boolean) => ({
  task: {
    session: {
      id,
      archived: true,
      pinned,
      pinned_order: pinned ? 0 : null,
      project_id: null,
      display_title: id,
      activity_at: 1,
      unread: false,
      remind_at: null,
    },
    thread: {
      thread_id: `thread-${id}`,
      archived: true,
      parent_thread_id: null,
      backend_binding: { kind: "codex" },
      updated_at: 1,
      created_at: 1,
      status: { status_type: "idle", active_flags: [] },
    },
  },
});
const archivedRuntimeTask = (id: string) => ({
  task: {
    session: {
      id,
      archived: true,
      pinned: false,
      pinned_order: null,
      project_id: "project-a",
      display_title: id,
      activity_at: 5,
      unread: false,
      remind_at: null,
      created_at: "2026-11-01T00:00:00.000Z",
      updated_at: "2026-11-02T00:00:00.000Z",
      execution_ref: { runtime_id: "runtime-a", thread_id: `runtime-thread-${id}` },
    },
    thread: null,
  },
});
const archivedPage = (items: readonly unknown[], next: string | null = null) =>
  ({
    value: {
      kind: "session_window",
      search_revision: 1,
      sessions: { items, next_cursor: next, authority: { projection_revision: 9 } },
    },
  }) as never;

it.effect("the archived snapshot lists every archived chat, not only pinned ones", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const catalog = yield* setup((input) =>
      Effect.sync(() => {
        calls.push(input);
        return archivedPage([archivedTask("kept", false), archivedTask("pinned", true)]);
      }),
    );
    const { snapshot } = yield* catalog.sync({ includeArchived: true, policy: "force" });
    assert.deepEqual(
      snapshot.items.map((item) => [item.sessionId, item.archived, item.pinned]),
      [
        ["kept", true, false],
        ["pinned", true, true],
      ],
    );
    assert.deepEqual(snapshot.pinnedThreadIds, ["thread-pinned"]);
    assert.equal((calls[0] as { kind: string; archived: boolean }).kind, "session_window");
    assert.isTrue((calls[0] as { archived: boolean }).archived);
  }),
);

it.effect("the archived snapshot lists Runtime-bound chats and skips unused drafts", () =>
  Effect.gen(function* () {
    const draft = {
      task: {
        session: { ...archivedRuntimeTask("draft").task.session, execution_ref: null },
        thread: null,
      },
    };
    const catalog = yield* setup(() =>
      Effect.sync(() => archivedPage([archivedRuntimeTask("runtime"), draft])),
    );
    const { snapshot } = yield* catalog.sync({ includeArchived: true, policy: "force" });
    assert.deepEqual(
      snapshot.items.map((item) => [
        item.sessionId,
        item.threadId,
        item.projectId,
        item.runtimeBound,
        item.archived,
      ]),
      [["runtime", "runtime-thread-runtime", "project-a", true, true]],
    );
  }),
);

it.effect("the live snapshot leaves Runtime-bound chats to their Session rows", () =>
  Effect.gen(function* () {
    const catalog = yield* setup(() =>
      Effect.sync(
        () =>
          ({
            value: {
              kind: "sidebar_overview",
              pinned_tasks: {
                items: [archivedRuntimeTask("runtime").task],
                next_cursor: null,
                authority: { projection_revision: 7 },
              },
            },
          }) as never,
      ),
    );
    const { snapshot } = yield* catalog.sync({ policy: "force" });
    assert.deepEqual(snapshot.items, []);
  }),
);

it.effect("a long archive keeps its most recent chats when it outgrows the read budget", () =>
  Effect.gen(function* () {
    let reads = 0;
    const catalog = yield* setup(
      () =>
        Effect.sync(() => {
          reads += 1;
          return archivedPage([archivedTask(`chat-${reads}`, false)], `cursor-${reads}`);
        }),
      { maxPages: 2 },
    );
    const { snapshot } = yield* catalog.sync({ includeArchived: true, policy: "force" });
    assert.deepEqual(
      snapshot.items.map((item) => item.sessionId),
      ["chat-1", "chat-2"],
    );
  }),
);

it.effect("an invalidation during a metadata read cannot mark its older projection current", () =>
  Effect.gen(function* () {
    const admitted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    const catalog = yield* setup(() =>
      Effect.gen(function* () {
        reads++;
        if (reads === 1) {
          yield* Deferred.succeed(admitted, undefined);
          yield* Deferred.await(release);
        }
        return page();
      }),
    );
    const first = yield* catalog.sync().pipe(Effect.forkScoped);
    yield* Deferred.await(admitted);
    catalog.invalidate();
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* catalog.sync();
    assert.equal(reads, 2);
  }),
);
