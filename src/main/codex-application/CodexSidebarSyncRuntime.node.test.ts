import { describe } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";

import * as Stream from "effect/Stream";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { make, type CodexSidebarSyncRuntimeOptions } from "./CodexSidebarSyncRuntime";
import { CodexThreadTargets } from "./CodexThreadTargets";
import { CodexClientThreadIdentity } from "./CodexClientThreadIdentity";
import { CodexPendingWorktreeRuntime } from "./CodexPendingWorktreeRuntime";
import { make as makeCodexCreatedThreadResolution } from "./CodexCreatedThreadResolution";
import type { CodexCreatedThreadResolution } from "../../shared/codex-child-thread-summary";
import * as TestClock from "effect/testing/TestClock";
import type { CodexCanonicalConversationState } from "../../shared/types";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import {
  CODEX_FORK_TITLE_CATALOG_DEADLINE,
  CODEX_FORK_TITLE_MAX_PAGES,
  make as makeCodexForkTitlePolicy,
} from "./CodexForkTitlePolicy";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import {
  make as makeCodexNativeThreadLookup,
  CodexNativeThreadLookupError,
} from "./CodexNativeThreadLookup";

describe("CodexSidebarSyncRuntime", () => {
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
        pinned_tasks: {
          items: [],
          total_count: next ? 1 : 0,
          next_cursor: next,
          authority: { projection_revision: 7 },
        },
      },
    }) as never;
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
        snoozed_until: null,
      },
      thread: {
        thread_id: `thread-${id}`,
        archived: true,
        parent_thread_id: null,
        backend_binding: { driver: "codex", instanceId: "codex" },
        updated_at: 1,
        created_at: 1,
        status: { status_type: "idle", active_flags: [] },
      },
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
});

describe("CodexCreatedThreadResolution", () => {
  const make = makeCodexCreatedThreadResolution;
  const clientThreadId = "client-new-thread:created";
  const fixture = (
    input: {
      pending?: boolean;
      fork?: boolean;
      duplicatePending?: boolean;
      state?: boolean;
      ambiguous?: boolean;
      foreign?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      let commands = 0;
      const targets = CodexThreadTargets.of({
        readSummary: () => Effect.die("Resolution must not read native metadata"),
        ensureOpen: () =>
          Effect.sync(() => {
            commands++;
            return null;
          }),
        resolveKnown: (threadId, hostId) =>
          Effect.succeed(
            input.foreign || hostId === "foreign"
              ? null
              : {
                  hostId: hostId ?? "ssh:owner",
                  threadId,
                  ready: true,
                  parentThreadId: threadId === "child" ? "root" : null,
                },
          ),
      });
      const pending = {
        list: () =>
          input.duplicatePending
            ? ["one", "two"].map((id) => ({
                id,
                launchMode: "start-conversation",
                clientThreadId,
                hostId: "ssh:owner",
              }))
            : input.fork
              ? [
                  {
                    id: "fork-pending",
                    launchMode: "fork-conversation",
                    clientThreadId,
                    hostId: "worktree-host",
                    sourceConversationId: "source",
                  },
                ]
              : input.pending
                ? [
                    {
                      launchMode: "start-conversation",
                      id: "actual-pending",
                      clientThreadId,
                      hostId: "local",
                      threadStartHostId: "ssh:owner",
                    },
                  ]
                : [],
        resolveThread: () =>
          input.pending || input.fork || input.state ? { state: "starting" } : null,
      } as unknown as CodexPendingWorktreeRuntime["Service"];
      const identities = {
        candidates: (_id: string, host?: string) =>
          Effect.succeed(
            input.ambiguous
              ? [
                  { hostId: "ssh:owner", threadId: "one", clientThreadId },
                  { hostId: "ssh:owner", threadId: "two", clientThreadId },
                ]
              : [{ hostId: host ?? "ssh:owner", threadId: "child", clientThreadId }],
          ),
      } as unknown as CodexClientThreadIdentity["Service"];
      const service = yield* make.pipe(
        Effect.provideService(CodexThreadTargets, targets),
        Effect.provideService(CodexPendingWorktreeRuntime, pending),
        Effect.provideService(CodexClientThreadIdentity, identities),
      );
      return { service, commands: () => commands };
    });

  it.effect(
    "keeps pending launch unready even after its actual host/native identity is persisted",
    () =>
      Effect.gen(function* () {
        const { service, commands } = yield* fixture({ pending: true });
        assert.deepStrictEqual(yield* service.read({ clientThreadId }), {
          hostId: "ssh:owner",
          threadId: "child",
          clientThreadId,
          pendingWorktreeId: "actual-pending",
          ready: false,
          parentThreadId: "root",
        } satisfies CodexCreatedThreadResolution);
        assert.isNull(yield* service.read({ clientThreadId, expectedHostId: "foreign" }));
        assert.strictEqual(commands(), 0);
      }),
  );
  it.effect("preserves retained launch ownership after the visible pending row was removed", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture({ state: true });
      assert.strictEqual((yield* service.read({ clientThreadId }))?.ready, false);
    }),
  );
  it.effect(
    "resolves a pending fork from its native source binding instead of the worktree filesystem host",
    () =>
      Effect.gen(function* () {
        const { service } = yield* fixture({ fork: true });
        assert.strictEqual((yield* service.read({ clientThreadId }))?.hostId, "ssh:owner");
        assert.isNull(yield* service.read({ clientThreadId, expectedHostId: "worktree-host" }));
      }),
  );
  it.effect("rejects two active launch owners for one client identity", () =>
    Effect.gen(function* () {
      const { service, commands } = yield* fixture({ duplicatePending: true });
      assert.isNull(yield* service.read({ clientThreadId }));
      assert.strictEqual(commands(), 0);
    }),
  );
  it.effect(
    "admits one completed Core-confirmed coordinate and rejects ambiguity or foreign binding",
    () =>
      Effect.gen(function* () {
        const complete = yield* fixture();
        assert.strictEqual((yield* complete.service.read({ clientThreadId }))?.ready, true);
        const ambiguous = yield* fixture({ ambiguous: true });
        assert.isNull(yield* ambiguous.service.read({ clientThreadId }));
        const foreign = yield* fixture({ foreign: true });
        assert.isNull(yield* foreign.service.read({ clientThreadId }));
        assert.isNull(
          yield* foreign.service.read({ threadId: "child", expectedHostId: "foreign" }),
        );
      }),
  );
});

describe("CodexForkTitlePolicy", () => {
  const make = makeCodexForkTitlePolicy;
  const source = {
    threadId: "thread-source",
    projectId: "project-a",
    forkedFromId: null,
    threadName: "Plan work",
    canonical: { turns: [] } as unknown as CodexCanonicalConversationState,
  };

  const taskWindow = (
    items: readonly {
      readonly session: Record<string, never>;
      readonly thread: {
        readonly thread_id: string;
        readonly forked_from_id: string | null;
        readonly thread_name: string | null;
      };
    }[],
    nextCursor: string | null,
  ) =>
    ({
      value: {
        kind: "task_window",
        tasks: {
          items,
          total_count: items.length + (nextCursor === null ? 0 : 1),
          next_cursor: nextCursor,
          authority: { projection_revision: 1 },
        },
      },
    }) as unknown as ProjectWorkspaceReadSnapshot;

  const task = (threadId: string, title: string | null, forkedFromId: string | null = null) => ({
    session: {},
    thread: {
      thread_id: threadId,
      forked_from_id: forkedFromId,
      thread_name: title,
    },
  });

  const policy = (
    read: (request: {
      readonly kind: string;
      readonly window?: { readonly after: string | null };
    }) => Effect.Effect<ProjectWorkspaceReadSnapshot>,
  ) =>
    make.pipe(
      Effect.provideService(
        CoreModules,
        CoreModules.of({ workspace: { read } } as unknown as CoreModuleClients),
      ),
    );

  it.effect("derives a sibling suffix from a complete bounded catalog", () =>
    Effect.gen(function* () {
      const runtime = yield* policy(() =>
        Effect.succeed(
          taskWindow(
            [
              task("thread-source", "Plan work"),
              task("thread-child", "Plan work (2)", "thread-source"),
            ],
            null,
          ),
        ),
      );
      const result = yield* runtime.derive(source);

      assert.deepEqual(result, { sourceTitle: "Plan work", childTitle: "Plan work (3)" });
    }),
  );

  it.effect("stops at the catalog page budget and does not block a fork for a cosmetic title", () =>
    Effect.gen(function* () {
      let calls = 0;
      const runtime = yield* policy(() =>
        Effect.sync(() => {
          calls += 1;
          return taskWindow([task(`thread-${calls}`, "Plan work")], `cursor-${calls}`);
        }),
      );
      const result = yield* runtime.derive(source);

      assert.strictEqual(calls, CODEX_FORK_TITLE_MAX_PAGES);
      assert.deepEqual(result, { sourceTitle: "Plan work", childTitle: null });
    }),
  );

  it.effect("drops only the child title when a single catalog page exceeds its byte budget", () =>
    Effect.gen(function* () {
      let calls = 0;
      const runtime = yield* policy(() =>
        Effect.sync(() => {
          calls += 1;
          return taskWindow([task("thread-large", "x".repeat(3 * 1024 * 1024))], null);
        }),
      );
      const result = yield* runtime.derive(source);

      assert.strictEqual(calls, 1);
      assert.deepEqual(result, { sourceTitle: "Plan work", childTitle: null });
    }),
  );

  it.effect("keeps the local source title when the complete catalog misses its 250 ms budget", () =>
    Effect.gen(function* () {
      const runtime = yield* policy(() => Effect.never);
      const pending = yield* Effect.forkChild(runtime.derive(source));

      yield* TestClock.adjust(CODEX_FORK_TITLE_CATALOG_DEADLINE);

      assert.deepEqual(yield* Fiber.join(pending), { sourceTitle: "Plan work", childTitle: null });
    }),
  );
});

describe("CodexNativeThreadLookup", () => {
  const make = makeCodexNativeThreadLookup;
  const harness = (readable: readonly string[]) =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const activeSshHosts = yield* SubscriptionRef.make(new Map([["remote", {}]]));
      const lookup = yield* make.pipe(
        Effect.provideService(ExecutionHostRuntime, {
          activeSshHosts,
        } as unknown as ExecutionHostRuntime["Service"]),
        Effect.provideService(CodexMainConversationManagers, {
          get: (hostId: string) =>
            Effect.succeed({ hostId, generation: 1, assertCurrent: () => {} }),
        } as unknown as CodexMainConversationManagers["Service"]),
        Effect.provideService(CodexGateway, {
          localHostId: "local",
          requestOnHost: (hostId: string) =>
            Effect.suspend(() => {
              calls.push(hostId);
              return readable.includes(hostId)
                ? Effect.succeed({ thread: { id: "unloaded-native-task" } })
                : Effect.fail(
                    new CodexNativeThreadLookupError({
                      threadId: "unloaded-native-task",
                      cause: new Error("not found"),
                    }),
                  );
            }),
        } as unknown as CodexGateway["Service"]),
      );
      return { lookup, calls };
    });
  it.effect("finds an unloaded native task without a durable directory lookup", () =>
    Effect.gen(function* () {
      const h = yield* harness(["remote"]);
      const match = yield* h.lookup.resolve("unloaded-native-task");
      assert.strictEqual(match.hostId, "remote");
      assert.deepEqual(h.calls, ["local", "remote"]);
    }),
  );
  it.effect("a readable preferred host wins without probing other hosts", () =>
    Effect.gen(function* () {
      const h = yield* harness(["local", "remote"]);
      assert.strictEqual(
        (yield* h.lookup.resolve("unloaded-native-task", "remote")).hostId,
        "remote",
      );
      assert.deepEqual(h.calls, ["remote"]);
    }),
  );
  it.effect("failed preferred hosts are not retried and ambiguous matches are rejected", () =>
    Effect.gen(function* () {
      const h = yield* harness(["remote"]);
      assert.strictEqual(
        (yield* h.lookup.resolve("unloaded-native-task", "local")).hostId,
        "remote",
      );
      assert.deepEqual(h.calls, ["local", "remote"]);
      const ambiguous = yield* harness(["local", "remote"]);
      const error = yield* ambiguous.lookup.resolve("unloaded-native-task").pipe(Effect.flip);
      assert.include(
        String(error.cause),
        "Ambiguous Codex thread id unloaded-native-task; matching hosts: local, remote",
      );
    }),
  );
});
