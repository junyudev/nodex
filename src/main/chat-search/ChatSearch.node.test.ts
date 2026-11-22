import { nativeSearchThreadId } from "@nodex/agent-runtime/orchestration/NativeSearchHistory";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { fixture, row, metadata, fact, type Fact } from "./ChatSearch.test-support";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import type { AgentRuntimeSessionActivityChange } from "../../shared/agent-runtime-api";
import {
  MEMBER_CHAT_CATALOG_MAX_ENTRIES,
  projectChat,
  type ChatListingItem,
} from "./ChatCatalogProjection";
import { makeFindService } from "../find/FindService";
import { HostInvocation } from "../../host/HostInvocation";

it.effect(
  "prefers the active Project before limiting and puts archived chats after equally strong hits",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const makeRow = (id: string, projectId: string, archived = false) => {
          const base = row(id, "Needle");
          return {
            ...base,
            task: {
              ...base.task,
              session: { ...base.task.session, project_id: projectId, archived },
            },
          };
        };
        const search = yield* fixture({
          rows: () => [
            ...Array.from({ length: 120 }, (_, index) => makeRow(`other-${index}`, "other")),
            makeRow("active-project", "preferred"),
            makeRow("archived-project", "preferred", true),
          ],
        }).service;
        yield* search.search({ query: "", limit: 1 });
        const base = {
          query: "needle",
          preferredProjectId: "preferred",
          includeArchived: true,
          instant: true,
        };
        const first = yield* search.search({ ...base, limit: 1 });
        assert.deepEqual(
          first.matches.map(({ chat }) => chat.sessionId),
          ["active-project"],
        );
        const scoped = yield* search.search({ ...base, projectId: "preferred", limit: 2 });
        assert.deepEqual(
          scoped.matches.map(({ chat }) => [chat.sessionId, chat.archived]),
          [
            ["active-project", false],
            ["archived-project", true],
          ],
        );
      }),
    ),
);

it.effect("finds strong archived titles before loose active matches in a dense catalog", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = (index: number) =>
        "quartz" + String.fromCharCode(97 + (index % 26), 97 + Math.floor(index / 26)) + "blue";
      const archive = Array.from({ length: 60 }, (_, index) => {
        const base = row(
          `archive-${index}`,
          `${token(index)} historical`,
          index % 2 ? "native" : "runtime",
        );
        return {
          ...base,
          task: { ...base.task, session: { ...base.task.session, archived: true } },
        };
      });
      const collisions = Array.from({ length: 19 }, (_, index) => {
        const query = token(index + 9);
        const strong = index >= 13;
        return Array.from({ length: index === 0 ? 110 : 30 }, (_, duplicate) =>
          row(`active-${index}-${duplicate}`, strong ? query : `un${query}post`),
        );
      }).flat();
      const rows = [
        ...archive,
        ...collisions,
        ...Array.from({ length: 1_900 - archive.length - collisions.length }, (_, index) =>
          row(`other-${index}`),
        ),
      ];
      const search = yield* fixture({ rows: () => rows }).service;
      const find = makeFindService({
        searchPages: () => Effect.die("not requested"),
        searchBlocks: () => Effect.die("not requested"),
        search: search.search,
        searchMessages: search.searchMessages,
      });
      const admitted = yield* search.search({
        query: "historical",
        includeArchived: true,
        limit: 60,
      });
      assert.sameMembers(
        admitted.matches.map(({ chat }) => chat.sessionId),
        archive.map(({ task }) => task.session.id),
      );

      const found = [];
      for (let index = 0; index < 28; index++) {
        const response = yield* find(
          {
            query: token(index),
            kinds: ["chat"],
            place: { kind: "everywhere" },
            preferredProjectId: "project",
            limit: 25,
          },
          "complete",
        );
        if (response.hits.some((hit) => hit.identity === `archive-${index}`)) found.push(index);
        if (index === 9) {
          assert.equal(response.hits[0]?.identity, "archive-9");
          assert.equal(response.topResult?.identity, "archive-9");
          assert.isTrue(response.truncated);
        }
      }
      assert.deepEqual(
        found,
        Array.from({ length: 22 }, (_, index) => index),
      );
    }),
  ),
);

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

it.effect("keeps the catalog current by reading only the chats each change names", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changed = yield* PubSub.unbounded<ProjectSessionsChangeEvent>();
      const activity = yield* PubSub.unbounded<AgentRuntimeSessionActivityChange>();
      let rows = [row("first", "First plan"), row("second", "Second draft")];
      const { service, reads } = fixture({
        rows: () => rows,
        invalidations: Stream.fromPubSub(changed),
        activityChanges: Stream.fromPubSub(activity),
      });
      const search = yield* service;
      const titles = (query: string) =>
        search
          .search({ query, limit: 5 })
          .pipe(Effect.map((result) => result.matches.map(({ chat }) => chat.title)));
      assert.deepEqual(yield* titles("Second"), ["Second draft"]);
      const whole = reads.length;

      rows = [row("first", "First plan"), row("second", "Second revision")];
      yield* PubSub.publish(changed, {
        summaryScopes: [],
        detailInvalidation: { kind: "sessions", sessionIds: ["second"] },
        changeType: "update",
      });
      yield* titles("revision").pipe(Effect.repeat({ until: (found) => found.length > 0 }));

      // An Agent's activity names its chat too, and a chat gone from the list leaves the catalog.
      rows = [row("second", "Second revision")];
      yield* PubSub.publish(activity, { type: "remove", sequence: 1, sessionId: "first" });
      yield* titles("First").pipe(Effect.repeat({ until: (found) => found.length === 0 }));

      // After the first read, no change makes the catalog read every chat again.
      const later = reads.slice(whole);
      assert.isAbove(later.length, 0);
      for (const read of later)
        assert.includeMembers(
          ["first", "second"],
          [...((read.kind === "session_window" && read.session_ids) || ["every chat"])],
        );
    }),
  ),
);

const runtimePage = (facts: readonly Fact[]) => ({
  runtimeId: "runtime",
  items: facts,
  nextCursor: null,
  coverage: "indexed" as const,
  startCursor: null,
  strongWords: [],
  truncated: false,
});
const resolveFacts = (facts: readonly Fact[]) =>
  Effect.succeed({ runtimeId: "runtime", items: facts });
it.effect(
  "ranks native and Runtime item coordinates from the same index and scopes them to Core",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeId = nativeSearchThreadId("local", "native");
        let scans = 0;
        const facts = [
          fact("runtime"),
          fact(nativeId, "needle from native history", { runId: "native-turn" }),
          fact("unknown"),
        ];
        const search = yield* fixture({
          rows: () => [row("native", "Other topic", "native"), row("runtime")],
          search: (input) =>
            Effect.sync(() => {
              scans++;
              assert.deepEqual(new Set(input.threadIds), new Set(["runtime", nativeId]));
              return runtimePage(facts);
            }),
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
          new Set(first.matches.map(({ chat }) => chat.sessionId)),
          new Set(["native", "runtime"]),
        );
        assert.deepEqual(
          first.matches.find(({ chat }) => chat.sessionId === "native")?.historyMatch,
          {
            sessionId: "native",
            sourceThreadId: "native",
            itemId: `item:${nativeId}`,
            runId: "native-turn",
            matchedText: "needle",
          },
        );
        assert.equal(scans, 1);
      }),
    ),
);

it.effect("reports source failures independently and rejects invalid requests before I/O", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { service, reads } = fixture({
        search: () => Effect.fail(new Error("Runtime unavailable")) as never,
      });
      const search = yield* service;
      yield* search.search({ query: "", limit: 1 });
      const startupReads = reads.length;
      assert.equal(
        (yield* search.search({ query: "x", limit: 0 }).pipe(Effect.flip)).reason,
        "invalid_input",
      );
      assert.equal(
        (yield* search.searchMessages({ query: " ", limit: 1 }).pipe(Effect.flip)).reason,
        "invalid_input",
      );
      assert.equal(reads.length, startupReads);
      const result = yield* search.searchMessages({ query: "needle", limit: 10 });
      assert.deepEqual(result.sources, [{ source: "runtime", state: "unavailable" }]);
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
  "searches a Member's chats through the host with their own authority, fresh and bounded",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rows = [row("deploy", "Deploy the app"), row("other", "Other subject")];
        const { service, invocations } = fixture({
          rows: () => rows,
          search: () =>
            Effect.succeed({
              runtimeId: "runtime",
              items: [fact("other", "the deploy checklist")],
              nextCursor: null,
              coverage: "indexed",
              startCursor: null,
              strongWords: [],
              truncated: false,
            }),
          resolve: () =>
            Effect.succeed({
              runtimeId: "runtime",
              items: [fact("other", "the deploy checklist")],
            }),
        });
        const search = yield* service;
        const asMember = <A, E, R>(effect: Effect.Effect<A, E, R>, proof: string) =>
          effect.pipe(Effect.provideService(HostInvocation, proof));

        // The desktop's own search warms its catalog; a Member's never reuses it.
        yield* search.search({ query: "deploy", limit: 5 });
        const desktopReads = invocations.length;
        const alice = yield* asMember(search.search({ query: "deploy", limit: 5 }), "alice-proof");
        assert.deepEqual(
          alice.matches.map(({ chat }) => chat.sessionId),
          ["deploy"],
        );
        yield* asMember(search.search({ query: "deploy", limit: 5 }), "bob-proof");
        assert.deepEqual(invocations.slice(desktopReads), ["alice-proof", "bob-proof"]);

        // Message history comes from the host's Runtime; it runs no native Codex of its own.
        const messages = yield* asMember(
          search.searchMessages({ query: "deploy", limit: 5 }),
          "alice-proof",
        );
        assert.deepEqual(
          messages.matches.map(({ chat }) => chat.sessionId),
          ["other"],
        );
        assert.deepEqual(messages.sources, [{ source: "runtime", state: "complete" }]);
      }),
    ),
);

it.effect("bounds a Member's catalog to their most recent chats", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const rows = Array.from({ length: MEMBER_CHAT_CATALOG_MAX_ENTRIES + 1 }, (_, index) =>
        row(String(index), `Chat ${index}`),
      );
      const { service } = fixture({ rows: () => rows });
      const search = yield* service;
      const result = yield* search
        .search({ query: "", limit: 5 })
        .pipe(Effect.provideService(HostInvocation, "alice-proof"));
      assert.equal(result.complete, false);
      assert.equal((yield* search.search({ query: "", limit: 5 })).complete, true);
    }),
  ),
);

it.effect("ranks all available Runtime pages before applying the picker limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const weak = Array.from({ length: 21 }, (_, index) =>
        fact(`weak:${index}`, "semimarigold", { quality: 0.3, wordQuality: 0.3 }),
      );
      const older = fact("older", "Marigold", {
        messageAt: "2025-01-01",
        matchedText: "Marigold",
      });
      const search = yield* fixture({
        rows: () => [row("older"), ...weak.map((hit) => row(hit.threadId))],
        search: ({ cursor }) =>
          Effect.succeed(
            cursor ? runtimePage([older]) : { ...runtimePage(weak), nextCursor: "more" },
          ),
        resolve: ({ references }) =>
          resolveFacts(
            [...weak, older].filter((hit) =>
              references.some((reference) => reference.itemId === hit.itemId),
            ),
          ),
      }).service;
      const result = yield* search.searchMessages({ query: "marigold", limit: 5 });
      assert.equal(result.matches[0]?.chat.sessionId, "older");
      assert.equal(result.matches.length, 5);
      assert.deepEqual(result.sources[0], { source: "runtime", state: "complete" });
      assert.isTrue(result.truncated);
      assert.deepEqual(result.matches[0]?.historyMatch, {
        sessionId: "older",
        sourceThreadId: "older",
        itemId: "item:older",
        runId: null,
        matchedText: "Marigold",
      });
    }),
  ),
);

it.effect("keeps the first Runtime hit on a later failure and retries partial answers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let calls = 0;
      const hit = fact("first");
      const search = yield* fixture({
        rows: () => [row("first")],
        search: ({ cursor }) =>
          Effect.suspend(() => {
            calls++;
            return cursor
              ? (Effect.fail(new Error("Runtime disconnected")) as never)
              : Effect.succeed({ ...runtimePage([hit]), nextCursor: "lost" });
          }),
        resolve: () => resolveFacts([hit]),
      }).service;
      const input = { query: "needle", limit: 5 };
      const first = yield* search.searchMessages(input);
      assert.equal(first.matches[0]?.chat.sessionId, "first");
      assert.deepEqual(first.sources[0], { source: "runtime", state: "partial" });
      assert.isFalse(first.truncated);
      yield* search.searchMessages(input);
      assert.equal(calls, 4);
    }),
  ),
);

it.effect("reports partial history without truncating a zero-hit Find answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const search = yield* fixture({
        rows: () => [row("first")],
        search: () => Effect.succeed({ ...runtimePage([]), truncated: true }),
      }).service;
      const find = makeFindService({
        searchPages: () => Effect.die("not requested"),
        searchBlocks: () => Effect.die("not requested"),
        search: search.search,
        searchMessages: search.searchMessages,
      });
      const result = yield* find(
        { query: "needle", kinds: ["chat"], place: { kind: "everywhere" }, limit: 25 },
        "complete",
      );
      assert.isEmpty(result.hits);
      assert.isNull(result.nextCursor);
      assert.isFalse(result.truncated);
      assert.deepInclude(result.coverage, { source: "runtime", state: "partial" });
      assert.isNotTrue(result.coverage.find(({ source }) => source === "chat_catalog")?.truncated);
    }),
  ),
);

it.effect("passes title evidence into Runtime and preserves split-query coordinates", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const conclusion = fact("orchard", "The Conclusion stood", {
        matchedWord: 1,
        matchedText: "Conclusion",
        runId: "run:reply",
      });
      const search = yield* fixture({
        rows: () => [row("orchard", "Semaphoric Orchard")],
        search: ({ threadIds, metadata }) =>
          Effect.sync(() => {
            assert.deepEqual(threadIds, ["orchard"]);
            assert.deepEqual(metadata, [
              { threadId: "orchard", withoutTypos: [0, null], withTypos: [0, null] },
            ]);
            return { ...runtimePage([conclusion]), truncated: true };
          }),
      }).service;
      const query = "semaphoric conclusion";
      assert.isEmpty((yield* search.search({ query, limit: 5 })).matches);
      const result = yield* search.searchMessages({ query, limit: 5 });
      assert.deepEqual(result.matches[0]?.historyMatch, {
        sessionId: "orchard",
        sourceThreadId: "orchard",
        itemId: "item:orchard",
        runId: "run:reply",
        matchedText: "Conclusion",
      });
      assert.deepEqual(result.matches[0]?.titleRanges, [{ start: 0, end: 10 }]);
      assert.deepEqual(result.sources[0], { source: "runtime", state: "partial" });
    }),
  ),
);

it.effect("drops deferred catalog typos when Runtime has a strong word match", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const exact = fact("body", "The migartion marker", {
        wordQuality: 0.75,
        quality: 0.75,
        matchedText: "migartion",
      });
      const search = yield* fixture({
        rows: () => [row("catalog", "Migration"), row("body", "Migration Archives")],
        search: () => Effect.succeed({ ...runtimePage([exact]), strongWords: [true] }),
      }).service;
      const result = yield* search.searchMessages({ query: "migartion", limit: 5 });
      assert.deepEqual(
        result.matches.map(({ chat }) => chat.sessionId),
        ["body"],
      );
      assert.isEmpty(result.matches[0]?.titleRanges);
    }),
  ),
);

it.effect(
  "keeps reading an ordered history window when a stronger catalog hit hides its excerpt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hidden = fact("hidden");
        const visible = fact("visible");
        const search = yield* fixture({
          rows: () => [row("hidden", "needle"), row("visible", "Different subject")],
          search: ({ cursor }) =>
            Effect.succeed({
              ...runtimePage(cursor ? [visible] : [hidden]),
              pickerOrdered: true,
              nextCursor: cursor ? null : "more",
            }),
        }).service;
        const result = yield* search.searchMessages({ query: "needle", limit: 2 });
        assert.equal(
          result.matches.find(({ chat }) => chat.sessionId === "visible")?.historyMatch?.itemId,
          visible.itemId,
        );
        assert.deepEqual(result.sources, [{ source: "runtime", state: "complete" }]);
      }),
    ),
);
