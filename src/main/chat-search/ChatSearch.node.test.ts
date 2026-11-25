import { describe } from "vite-plus/test";
import {
  nativeSearchThreadId,
  type NativeSearchHistoryInput,
  type NativeSearchHistoryState,
  type NativeSearchItem,
} from "@nodex/agent-runtime/orchestration/NativeSearchHistory";
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
import type { ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import { CoreModules } from "../core-runtime/CoreModules";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { CodexMainConversationManagers } from "../codex-application/CodexMainConversationManagers";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { make } from "./NativeChatSearchIndex";

describe("ChatSearch", () => {
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
              session: {
                ...row("pinned").task.session,
                pinned: true,
                pinned_order: 2,
                unread: true,
              },
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
            metadata: (id) =>
              metadata(id, { preview: "Earlier words. A needle\ninside the prompt" }),
          }).service;
          const recent = yield* search.search({ query: "", limit: 4 });
          assert.isTrue(
            recent.matches.find(({ chat }) => chat.sessionId === "pinned")?.chat.unread,
          );
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
            task: {
              ...archivedBase.task,
              session: { ...archivedBase.task.session, archived: true },
            },
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
          const alice = yield* asMember(
            search.search({ query: "deploy", limit: 5 }),
            "alice-proof",
          );
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
        assert.isNotTrue(
          result.coverage.find(({ source }) => source === "chat_catalog")?.truncated,
        );
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
});

describe("NativeChatSearchIndex", () => {
  const message = (id: string, text: string, completed = true): ThreadItemEntry => ({
    turnId: `turn:${id}`,
    item: {
      type: "agentMessage",
      moderation: null,
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
                  world.listed &&
                  !input.archived &&
                  (input.session_ids?.includes("native") ?? true);
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
        assert.deepEqual(
          { reads: world.reads, scans: world.scans, lookups: world.lookups },
          settled,
        );
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
});
