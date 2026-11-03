import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { fixture, row, metadata, fact, type Fact } from "./ChatSearch.test-support";
import { projectChat, type ChatListingItem } from "./ChatCatalogProjection";

it.effect("searches all 250 chats across Providers and returns bounded ranked rows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const rows = Array.from({ length: 250 }, (_, index) => ({
        ...row(
          String(index),
          index === 249 ? "帮我把我的服务器配置一下" : `Chat ${index}`,
          index % 2 ? "runtime" : "native",
        ),
        project_name: `Project ${index}`,
      }));
      const { service, reads } = fixture({ rows: () => rows });
      const search = yield* service;
      const result = yield* search.search({ query: "服务器", limit: 10 });
      assert.equal(result.complete, true);
      assert.deepEqual(
        result.matches.map(({ chat }) => chat.sessionId),
        ["249"],
      );
      assert.equal(reads.length, 3);
      assert.equal(result.matches[0]!.chat.projectName, "Project 249");
      assert.deepEqual(result.matches[0]!.titleRanges, [{ start: 5, end: 8 }]);
      const recent = yield* search.search({ query: "", limit: 5 });
      assert.equal(recent.matches.length, 5);
      assert.equal(reads.length, 3);
      assert.equal("preview" in recent.matches[0]!.chat, false);
      assert.equal("opens" in recent.matches[0]!.chat, false);
      assert.equal("binding" in recent.matches[0]!.chat, false);
      assert.equal("backend" in recent.matches[0]!.chat, false);
    }),
  ),
);

it.effect(
  "orders pinned chats first and metadata before prompt-only matches; startedOnly precedes limit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const empty = row("empty", "needle", "empty");
        const native = row("native", "needle", "native");
        const pinned = {
          ...row("pinned", "Other"),
          task: {
            ...row("pinned").task,
            session: { ...row("pinned").task.session, pinned: true, pinned_order: 2, unread: true },
          },
        };
        const firstPinned = {
          ...pinned,
          task: {
            ...pinned.task,
            session: {
              ...pinned.task.session,
              id: "first",
              execution_ref: { runtime_id: "runtime", thread_id: "first" },
              pinned_order: 1,
            },
          },
        };
        const search = yield* fixture({
          rows: () => [empty, native, pinned, firstPinned],
          metadata: (id) => metadata(id, { preview: "Earlier words. A needle\ninside the prompt" }),
        }).service;
        const recent = yield* search.search({ query: "", limit: 4 });
        assert.isTrue(recent.matches.find(({ chat }) => chat.sessionId === "pinned")?.chat.unread);
        assert.deepEqual(
          recent.matches.slice(0, 2).map(({ chat }) => chat.sessionId),
          ["first", "pinned"],
        );
        assert.ok(
          recent.matches.every(
            (match) => !match.excerpt && !match.hint && match.titleRanges.length === 0,
          ),
        );
        const matches = (yield* search.search({ query: "needle", limit: 4 })).matches;
        assert.deepEqual(
          matches.slice(0, 2).map(({ chat }) => chat.sessionId),
          ["empty", "native"],
        );
        assert.equal(matches[2]!.excerpt?.role, "user");
        assert.equal(matches[2]!.excerpt?.text.includes("\n"), false);
        assert.deepEqual(
          (yield* search.search({ query: "needle", limit: 1, startedOnly: true })).matches.map(
            ({ chat }) => chat.sessionId,
          ),
          ["native"],
        );
      }),
    ),
);

it.effect(
  "excludes archived, parent-linked and Runtime subagent rows and normalizes activity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archivedBase = row("archived");
        const archived = {
          ...archivedBase,
          task: { ...archivedBase.task, session: { ...archivedBase.task.session, archived: true } },
        };
        const withNative = (
          id: string,
          status: NonNullable<ChatListingItem["task"]["thread"]>["status"]["status_type"],
          flags: ("waitingOnApproval" | "waitingOnUserInput")[] = [],
        ): ChatListingItem => {
          const base = row(id, id, "native");
          return {
            ...base,
            task: {
              ...base.task,
              thread: {
                ...base.task.thread!,
                status: { status_type: status, active_flags: flags },
              },
            },
          };
        };
        const childBase = row("child", "Child", "native");
        const child = {
          ...childBase,
          task: {
            ...childBase.task,
            thread: { ...childBase.task.thread!, parent_thread_id: "parent" },
          },
        };
        const rows = [
          archived,
          child,
          row("subagent"),
          row("failed"),
          row("running"),
          withNative("approval", "active", ["waitingOnApproval"]),
          withNative("input", "active", ["waitingOnUserInput"]),
          withNative("error", "systemError"),
        ];
        const search = yield* fixture({
          rows: () => rows,
          metadata: (id) =>
            metadata(
              id,
              id === "subagent"
                ? { relationshipToParent: "subagent" }
                : {
                    activityRunStatus: id === "failed" ? null : "running",
                    runStatus: id === "failed" ? "failed" : "running",
                  },
            ),
        }).service;
        const matches = (yield* search.search({ query: "", limit: 60 })).matches;
        assert.deepEqual(
          Object.fromEntries(matches.map(({ chat }) => [chat.sessionId, chat.activity])),
          {
            approval: "waitingOnApproval",
            error: "error",
            failed: "error",
            input: "waitingOnUserInput",
            running: "running",
          },
        );
        const preview = projectChat(
          row("emoji"),
          metadata("emoji", {
            preview: "😀".repeat(300),
            branch: "feature/needle",
            pullRequests: [
              {
                number: 42,
                title: "PR",
                url: "https://example.com/pr/42",
                repository: "org/repo",
                host: null,
                source: "git",
                state: null,
              },
            ],
          }),
        );
        assert.equal(Array.from(preview!.preview).length, 240);
        assert.equal(preview!.branch, "feature/needle");
        assert.equal(preview!.pullRequests[0]!.number, 42);
      }),
    ),
);

it.effect(
  "coalesces catalog builds, clears Agent provenance, and refreshes after a Session change or TTL",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changed = yield* PubSub.unbounded<void>();
        let rows = [row("first", "First")];
        const { service, reads, agents } = fixture({
          rows: () => rows,
          invalidations: Stream.fromPubSub(changed),
        });
        const search = yield* service;
        yield* Effect.all(
          [search.search({ query: "", limit: 1 }), search.search({ query: "First", limit: 1 })],
          { concurrency: "unbounded" },
        ).pipe(Effect.provideService(CoreApplicationAgent, {} as never));
        assert.equal(reads.length, 1);
        assert.deepEqual(agents, [null]);
        rows = [row("second", "Second")];
        yield* PubSub.publish(changed, undefined);
        yield* Effect.yieldNow;
        yield* search.search({ query: "", limit: 1 });
        const refreshed = yield* search
          .search({ query: "Second", limit: 1 })
          .pipe(Effect.repeat({ until: (result) => result.matches.length > 0 }));
        assert.deepEqual(
          refreshed.matches.map(({ chat }) => chat.sessionId),
          ["second"],
        );
        assert.equal(reads.length, 2);
        yield* TestClock.adjust("16 seconds");
        yield* search.search({ query: "", limit: 1 });
        yield* Effect.yieldNow;
        assert.equal(reads.length, 3);
      }),
    ),
);

const runtimePage = (facts: readonly Fact[]) => ({
  runtimeId: "runtime",
  items: facts,
  nextCursor: null,
  coverage: "indexed" as const,
  startCursor: null,
});
const resolveFacts = (facts: readonly Fact[]) =>
  Effect.succeed({ runtimeId: "runtime", items: facts });
const nativeHit = (id: string, snippet = "needle from native history") => ({
  thread: { id, threadSource: "user", ephemeral: false, parentThreadId: null },
  snippet,
});

it.effect(
  "keeps Runtime message matches when Codex times out and excludes catalog matches and unknown Sessions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const facts = [
          fact("runtime"),
          fact("metadata"),
          fact("prompt"),
          fact("unknown"),
          fact("runtime", "needle twice", { messageId: "duplicate" }),
        ];
        const started = yield* Deferred.make<void>();
        const search = yield* fixture({
          rows: () => [row("runtime"), row("metadata", "needle title"), row("prompt")],
          metadata: (id) =>
            metadata(id, { preview: id === "prompt" ? "needle opening" : "Other prompt" }),
          search: () => Effect.succeed(runtimePage(facts)),
          resolve: () => resolveFacts(facts),
          codex: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) as never,
        }).service;
        const pending = yield* search
          .searchMessages({ query: "needle", limit: 10 })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("12 seconds");
        const result = yield* Fiber.join(pending);
        assert.deepEqual(
          result.matches.map(({ chat }) => chat.sessionId),
          ["runtime"],
        );
        assert.deepEqual(result.sources, [
          { source: "runtime", state: "complete" },
          { source: "codex", state: "timed_out" },
        ]);
        assert.equal(result.matches[0]!.excerpt?.role, "user");
      }),
    ),
);

it.effect("drops native hits absent from Core and dedupes cached concurrent queries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let scans = 0;
      const search = yield* fixture({
        rows: () => [row("native", "Other topic", "native")],
        codex: () =>
          Effect.sync(() => {
            scans++;
            return {
              data: [nativeHit("unknown"), nativeHit("native"), nativeHit("native")],
              nextCursor: null,
            };
          }) as never,
      }).service;
      const [first, second] = yield* Effect.all(
        [
          search.searchMessages({ query: "needle", limit: 10 }),
          search.searchMessages({ query: "needle", limit: 10 }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(first, second);
      assert.deepEqual(
        first.matches.map(({ chat }) => chat.sessionId),
        ["native"],
      );
      assert.equal(first.matches[0]!.excerpt?.role, null);
      yield* search.searchMessages({ query: " needle ", limit: 10 });
      assert.equal(scans, 1);
      yield* TestClock.adjust("31 seconds");
      yield* search.searchMessages({ query: "needle", limit: 10 });
      assert.equal(scans, 2);
    }),
  ),
);

it.effect("runs at most one Codex scan and supersedes the previous pending query", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const scans: string[] = [];
      const search = yield* fixture({
        codex: (_method, input) =>
          Effect.gen(function* () {
            const query = (input as { searchTerm: string }).searchTerm;
            scans.push(query);
            if (query === "first") {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            return { data: [], nextCursor: null };
          }) as never,
      }).service;
      const first = yield* search
        .searchMessages({ query: "first", limit: 10 })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* search
        .searchMessages({ query: "second", limit: 10 })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const third = yield* search
        .searchMessages({ query: "third", limit: 10 })
        .pipe(Effect.forkChild);
      const superseded = yield* Fiber.join(second);
      assert.deepEqual(superseded.sources[1], { source: "codex", state: "unavailable" });
      assert.deepEqual(scans, ["first"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(third);
      assert.deepEqual(scans, ["first", "third"]);
    }),
  ),
);

it.effect("reports source failures independently and rejects invalid requests before I/O", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { service, reads } = fixture({
        ready: false,
        search: () => Effect.fail(new Error("Runtime unavailable")) as never,
      });
      const search = yield* service;
      assert.equal(
        (yield* search.search({ query: "x", limit: 0 }).pipe(Effect.flip)).reason,
        "invalid_input",
      );
      assert.equal(
        (yield* search.searchMessages({ query: " ", limit: 1 }).pipe(Effect.flip)).reason,
        "invalid_input",
      );
      assert.equal(reads.length, 0);
      const result = yield* search.searchMessages({ query: "needle", limit: 10 });
      assert.deepEqual(result.sources, [
        { source: "runtime", state: "unavailable" },
        { source: "codex", state: "unavailable" },
      ]);
    }),
  ),
);

it.effect("marks the catalog incomplete only when more than 10,000 admitted chats exist", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const rows = Array.from({ length: 10_001 }, (_, index) =>
        row(String(index), `Unique ${index}`, "empty"),
      );
      const exact = yield* fixture({ rows: () => rows.slice(0, 10_000) }).service;
      assert.equal((yield* exact.search({ query: "", limit: 1 })).complete, true);
      const capped = yield* fixture({ rows: () => rows }).service;
      assert.equal((yield* capped.search({ query: "", limit: 1 })).complete, false);
    }),
  ),
);

it.effect(
  "refreshes cached message projections after catalog invalidation and keeps native hits when Runtime fails",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changed = yield* PubSub.unbounded<void>();
        let title = "Other subject";
        let scans = 0;
        const search = yield* fixture({
          rows: () => [row("native", title, "native")],
          invalidations: Stream.fromPubSub(changed),
          search: () => Effect.fail(new Error("Runtime unavailable")) as never,
          codex: () =>
            Effect.sync(() => {
              scans++;
              return { data: [nativeHit("native")], nextCursor: null };
            }) as never,
        }).service;
        const before = yield* search.searchMessages({ query: "needle", limit: 10 });
        assert.equal(before.matches.length, 1);
        assert.deepEqual(before.sources, [
          { source: "runtime", state: "unavailable" },
          { source: "codex", state: "complete" },
        ]);
        yield* search.searchMessages({ query: " NEEDLE ", limit: 10 });
        assert.equal(scans, 1);
        title = "needle renamed chat";
        yield* PubSub.publish(changed, undefined);
        yield* search
          .search({ query: "needle", limit: 10 })
          .pipe(Effect.repeat({ until: (result) => result.matches.length > 0 }));
        const after = yield* search.searchMessages({ query: "needle", limit: 10 });
        assert.deepEqual(after.matches, []);
      }),
    ),
);

it.effect("includes time waiting in the Codex queue in each query's deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const scans: string[] = [];
      const search = yield* fixture({
        codex: (_method, input) =>
          Effect.gen(function* () {
            scans.push((input as { searchTerm: string }).searchTerm);
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }) as never,
      }).service;
      const first = yield* search
        .searchMessages({ query: "first", limit: 1 })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* search
        .searchMessages({ query: "second", limit: 1 })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("12 seconds");
      assert.equal((yield* Fiber.join(first)).sources[1]!.state, "timed_out");
      assert.equal((yield* Fiber.join(second)).sources[1]!.state, "timed_out");
      assert.deepEqual(scans, ["first"]);
    }),
  ),
);
