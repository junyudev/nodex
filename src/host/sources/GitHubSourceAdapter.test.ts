import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  type GitHubApi,
  type GitHubRestInput,
  type GitHubRestResponse,
  SourceAccount,
  PinnedGitHubCredential,
} from "@nodex/agent-runtime/github-source";
import {
  makeGitHubSourceAdapter,
  responseDelay,
  overlapStart,
  nextPage,
  type PollInput,
  type Position,
  type Source,
} from "./GitHubSourceAdapter";
const boundary = Date.parse("2026-11-05T00:00:00Z");
const user = { login: "alice", id: 1, type: "User" };
const repository = { id: "10", name: "alice/repo", enabled: true };
const source: Source = {
  id: "github",
  kind: "github",
  library_id: "library",
  revision: 1,
  enabled: true,
  enabled_at_ms: boundary,
  config: {
    host: "github.com",
    account_login: "alice",
    account_id: "1",
    credential_ref: "gh:github.com:alice",
    repositories: [repository],
    discovery: { assigned: true, review_requests: true, mentions: true },
  },
};
const position: Position = {
  source_id: "github",
  partition: "repo:10",
  revision: 0,
  baseline: false,
  cursor: { baseline_at_ms: boundary, watermark_ms: boundary, validators: {}, continuation: null },
  next_poll_at_ms: 0,
  consecutive_failures: 0,
};
const pr = {
  id: 101,
  number: 7,
  title: "Work",
  state: "open",
  html_url: "https://github.com/alice/repo/pull/7",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-11-05T00:00:10Z",
  user,
  pull_request: {},
  head: { sha: "abc" },
  draft: false,
};
const event = (id: number) => ({
  id,
  body: `Comment ${id}`,
  user,
  created_at: "2026-11-05T00:00:10Z",
  updated_at: "2026-11-05T00:00:10Z",
});
const response = (
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
): GitHubRestResponse => ({
  status,
  body: JSON.stringify(body),
  headers,
  truncated: false,
  invalidUtf8: false,
});
function fake(handler?: (input: GitHubRestInput) => GitHubRestResponse, repositoryId = 10) {
  const requests: GitHubRestInput[] = [];
  const pins: string[] = [];
  const accounts: (string | undefined)[] = [];
  const api: GitHubApi["Service"] = {
    credential: () =>
      Effect.gen(function* () {
        accounts.push(yield* SourceAccount);
        return { token: Redacted.make("private-token"), fingerprint: "digest" };
      }),
    graphql: () => Effect.die("Unexpected GraphQL"),
    rest: (input) =>
      Effect.gen(function* () {
        requests.push(input);
        const pin = yield* PinnedGitHubCredential;
        if (pin) pins.push(pin.host);
        if (input.path === "user") return response(user);
        if (input.path === "repos/alice/repo")
          return response({ id: repositoryId, full_name: "alice/repo" });
        if (handler) return handler(input);
        return response([]);
      }),
  };
  return { api, adapter: makeGitHubSourceAdapter(api), requests, pins, accounts };
}
const input = (patch: Partial<PollInput> = {}): PollInput => ({
  source,
  repository,
  position,
  known: [],
  pullRequestNumbers: [7],
  nowMs: boundary + 20000,
  ...patch,
});
describe("GitHub Source polling", () => {
  it.effect(
    "walks all pages, overlaps comment reads, includes bodyless reviews and quarantines malformed items",
    () =>
      Effect.gen(function* () {
        const f = fake(({ path }) => {
          if (path.startsWith("search/"))
            return response({ total_count: 1, incomplete_results: false, items: [pr] });
          if (path === "repos/alice/repo/pulls/7")
            return response(pr, { etag: '"pr"', "x-poll-interval": "120" });
          if (path.includes("issues/7/comments") && !path.includes("page=2"))
            return response([event(1), { bad: true }], {
              link: '<https://api.github.com/repos/alice/repo/issues/7/comments?page=2>; rel="next"',
            });
          if (path.includes("comments?page=2")) return response([event(2)]);
          if (path.includes("/reviews?"))
            return response([
              { id: 3, user, state: "APPROVED", body: "", submitted_at: "2026-11-05T00:00:12Z" },
            ]);
          if (path.includes("/check-runs"))
            return response({
              check_runs: [
                {
                  id: 4,
                  status: "completed",
                  conclusion: "failure",
                  completed_at: "2026-11-05T00:00:13Z",
                },
              ],
            });
          return response([]);
        });
        const result = yield* f.adapter.poll(
          input({
            position: {
              ...position,
              baseline: true,
              cursor: { ...position.cursor, watermark_ms: boundary + 10000 },
            },
          }),
        );
        expect(result.triggers.filter((t) => t.kind === "comment")).toHaveLength(2);
        expect(result.triggers.find((t) => t.kind === "review")?.metadata).toMatchObject({
          state: "APPROVED",
        });
        expect(result.quarantine).toHaveLength(1);
        expect(result.delayMs).toBe(120000);
        expect(
          f.requests
            .filter((r) => r.path.startsWith("search/"))
            .map((r) => decodeURIComponent(r.path)),
        ).toEqual(
          expect.arrayContaining([
            expect.stringContaining("assignee:alice"),
            expect.stringContaining("review-requested:alice"),
            expect.stringContaining("mentions:alice"),
          ]),
        );
        expect(f.requests.some((r) => r.path.includes("since=2026-11-05T00%3A00%3A05"))).toBe(true);
        expect(new Set(f.pins)).toEqual(new Set(["github.com"]));
        expect(f.accounts).toEqual(["alice"]);
      }),
  );
  it.effect("revalidates saved validators after restart and records no observations twice", () =>
    Effect.gen(function* () {
      const f = fake(({ path, ifNoneMatch }) => {
        if (path.startsWith("search/"))
          return response({ total_count: 0, incomplete_results: false, items: [] });
        if (ifNoneMatch) return response(null, { etag: '"same"' }, 304);
        if (path === "repos/alice/repo/pulls/7") return response(pr, { etag: '"same"' });
        if (path.includes("/check-runs"))
          return response(
            {
              check_runs: [
                {
                  id: 4,
                  status: "completed",
                  conclusion: "failure",
                  completed_at: "2026-11-05T00:00:13Z",
                },
              ],
            },
            { etag: '"same"' },
          );
        return response([], { etag: '"same"' });
      });
      const first = yield* f.adapter.poll(input());
      expect(first.triggers).toHaveLength(1);
      const restarted = yield* makeGitHubSourceAdapter(f.api).poll(
        input({
          known: first.threads,
          position: { ...position, baseline: true, revision: 1, cursor: first.cursor },
        }),
      );
      expect(restarted.triggers).toHaveLength(0);
      expect(f.requests.some((r) => r.ifNoneMatch === '"same"')).toBe(true);
    }),
  );
  it.effect(
    "preserves repeated CI transitions and deduplicates snapshot lifecycle against timeline",
    () =>
      Effect.gen(function* () {
        let state = "failure";
        let closed = false;
        const f = fake(({ path }) => {
          if (path.startsWith("search/"))
            return response({ total_count: 0, incomplete_results: false, items: [] });
          if (path === "repos/alice/repo/pulls/7")
            return response({ ...pr, state: closed ? "closed" : "open" });
          if (path.includes("/timeline"))
            return response(
              closed
                ? [{ id: 44, event: "closed", actor: user, created_at: "2026-11-05T00:01:00Z" }]
                : [],
            );
          if (path.includes("/check-runs"))
            return response({
              check_runs: [
                {
                  id: 4,
                  status: "completed",
                  conclusion: state,
                  completed_at: "2026-11-05T00:00:13Z",
                },
              ],
            });
          return response([]);
        });
        const first = yield* f.adapter.poll(input());
        state = "success";
        const second = yield* f.adapter.poll(
          input({
            known: first.threads,
            position: { ...position, baseline: true, revision: 1, cursor: first.cursor },
          }),
        );
        state = "failure";
        closed = true;
        const third = yield* f.adapter.poll(
          input({
            nowMs: boundary + 90000,
            known: second.threads,
            position: { ...position, baseline: true, revision: 2, cursor: second.cursor },
          }),
        );
        expect(
          [first, second, third].map(
            (p) => p.triggers.find((t) => t.kind === "check")?.semantic_key,
          ),
        ).toEqual([
          expect.stringContaining(":failure:1"),
          expect.stringContaining(":success:2"),
          expect.stringContaining(":failure:3"),
        ]);
        expect(third.triggers.filter((t) => t.kind === "closed")).toHaveLength(1);
      }),
  );
  it.effect("never accepts another account or an incomplete discovery window", () =>
    Effect.gen(function* () {
      const f = fake(() => response({ total_count: 0, incomplete_results: true, items: [] }));
      expect(yield* f.adapter.poll(input()).pipe(Effect.flip)).toMatchObject({
        reason: "discovery_incomplete",
      });
      expect(
        yield* f.adapter
          .poll(input({ source: { ...source, config: { ...source.config, account_id: "2" } } }))
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "account_changed" });
    }),
  );
  it.effect(
    "shares transition identities across overlapping Sources with different poll histories",
    () =>
      Effect.gen(function* () {
        let state = "failure";
        const f = fake(({ path }) => {
          if (path.startsWith("search/"))
            return response({ total_count: 0, incomplete_results: false, items: [] });
          if (path === "repos/alice/repo/pulls/7") return response(pr);
          if (path.includes("/check-runs"))
            return response({
              check_runs: [
                {
                  id: 4,
                  status: "completed",
                  conclusion: state,
                  completed_at: "2026-11-05T00:00:13Z",
                },
              ],
            });
          if (path.includes("/timeline"))
            return response([{ event: "committed", sha: "commit-with-no-numeric-id" }]);
          return response([]);
        });
        const first = yield* f.adapter.poll(input());
        const overlap = yield* f.adapter.poll(
          input({ source: { ...source, id: "overlap" }, known: first.threads }),
        );
        expect(overlap.triggers).toHaveLength(0);
        expect(overlap.quarantine).toHaveLength(0);
        state = "success";
        const second = yield* f.adapter.poll(
          input({
            known: first.threads,
            position: { ...position, baseline: true, cursor: first.cursor },
          }),
        );
        state = "failure";
        const fromOriginal = yield* f.adapter.poll(
          input({
            known: second.threads,
            position: { ...position, baseline: true, cursor: second.cursor },
          }),
        );
        const fromOverlap = yield* f.adapter.poll(
          input({
            source: { ...source, id: "overlap" },
            known: second.threads,
            position: { ...position, baseline: true, cursor: overlap.cursor },
          }),
        );
        expect(fromOverlap.triggers.find((t) => t.kind === "check")?.semantic_key).toBe(
          fromOriginal.triggers.find((t) => t.kind === "check")?.semantic_key,
        );
        expect(fromOverlap.triggers.find((t) => t.kind === "check")?.semantic_key).toContain(
          ":failure:3",
        );
      }),
  );
  it.effect("baselines a newly watched repository independently of an older Source", () =>
    Effect.gen(function* () {
      const f = fake(({ path }) => {
        if (path.startsWith("search/"))
          return response({ total_count: 1, incomplete_results: false, items: [pr] });
        if (path === "repos/alice/repo/pulls/7") return response(pr);
        if (path.includes("/issues/7/comments")) return response([event(1)]);
        if (path.includes("/check-runs")) return response({ check_runs: [] });
        return response([]);
      });
      const result = yield* f.adapter.poll(
        input({
          position: {
            ...position,
            cursor: {
              ...position.cursor,
              baseline_at_ms: boundary + 15000,
              watermark_ms: boundary + 15000,
            },
          },
        }),
      );
      expect(result.triggers).toHaveLength(0);
      expect(result.cursor.baseline_at_ms).toBe(boundary + 15000);
    }),
  );
  it("honors poll and retry floors and rejects credential redirection", () => {
    expect(overlapStart(10000, 8000)).toBe(8000);
    expect(responseDelay({ "x-poll-interval": "120", "retry-after": "180" }, boundary)).toBe(
      180000,
    );
    expect(responseDelay({ "retry-after": "Thu, 05 Nov 2026 00:04:00 GMT" }, boundary)).toBe(
      240000,
    );
    expect(() =>
      nextPage('<https://evil.example/api/v3/repos?page=2>; rel="next"', "github.com"),
    ).toThrow("Invalid GitHub pagination target");
  });
});
it.effect(
  "verifies a context URL with pinned account and immutable repository identity before following",
  () =>
    Effect.gen(function* () {
      const f = fake(({ path }) =>
        path === "repos/alice/repo"
          ? response({ id: 10, full_name: "alice/repo" })
          : response({
              ...pr,
              head: { sha: "abc", ref: "nodex-1-work", repo: { id: 10, full_name: "alice/repo" } },
            }),
      );
      const verified = yield* f.adapter.verifyThread(source, pr.html_url);
      expect(verified.id).toBe("github:github.com:10:7");
      expect(verified.head).toEqual({
        repository_id: "10",
        repository: "alice/repo",
        branch: "nodex-1-work",
        sha: "abc",
      });
      expect(f.pins.every((pin) => pin === "github.com")).toBe(true);
      const before = f.requests.length;
      for (const url of [
        "https://evil.example/alice/repo/pull/7",
        "https://alice:password@github.com/alice/repo/pull/7",
        "https://github.com/alice/repo/pull/7?redirect=elsewhere",
        "https://github.com/unwatched/repo/pull/7",
      ]) {
        const result = yield* f.adapter.verifyThread(source, url).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
      expect(f.requests.length).toBe(before);
      const changed = fake(undefined, 20);
      expect(
        (yield* changed.adapter.verifyThread(source, pr.html_url).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(changed.requests.some((r) => r.path.includes("pulls/7"))).toBe(false);
    }),
);
it.effect(
  "discovers a Workspace PR by exact branch and keeps only the reviewer's effective decision",
  () =>
    Effect.gen(function* () {
      const head = { sha: "abc", ref: "nodex-1-work", repo: { id: 10, full_name: "alice/repo" } };
      const f = fake(({ path }) => {
        if (path.startsWith("search/"))
          return response({ total_count: 0, incomplete_results: false, items: [] });
        if (path.startsWith("repos/alice/repo/pulls?"))
          return response([
            { ...pr, head },
            { ...pr, number: 8, head: { ...head, repo: { id: 20, full_name: "fork/repo" } } },
          ]);
        if (path === "repos/alice/repo/pulls/7") return response({ ...pr, head });
        if (path.includes("/reviews?"))
          return response([
            { id: 1, user, state: "CHANGES_REQUESTED", submitted_at: "2026-11-05T00:00:10Z" },
            { id: 2, user, state: "APPROVED", submitted_at: "2026-11-05T00:00:11Z" },
          ]);
        if (path.includes("check-runs")) return response({ check_runs: [] });
        return response([]);
      });
      const result = yield* f.adapter.poll(
        input({ pullRequestNumbers: [], workspaceBranches: ["nodex-1-work"] }),
      );
      expect(result.threads.map((t) => t.number)).toEqual([7]);
      expect(result.triggers.filter((t) => t.kind === "review").map((t) => t.metadata)).toEqual([
        expect.objectContaining({ state: "CHANGES_REQUESTED", effective: false }),
        expect.objectContaining({ state: "APPROVED", effective: true }),
      ]);
    }),
);
it.effect("refuses a replacement repository before reading or delivering its threads", () =>
  Effect.gen(function* () {
    const f = fake(undefined, 20);
    expect((yield* f.adapter.poll(input()).pipe(Effect.result))._tag).toBe("Failure");
    expect(f.requests.map((r) => r.path)).toEqual(["user", "repos/alice/repo"]);
  }),
);

it.effect(
  "event Automations discover unaddressed new threads and retain label and root evidence",
  () =>
    Effect.gen(function* () {
      const issue = {
        ...pr,
        number: 8,
        pull_request: undefined,
        html_url: "https://github.com/alice/repo/issues/8",
        created_at: "2026-11-05T00:00:05Z",
        body: "Please fix this concrete failure",
        labels: [{ name: "bug" }],
      };
      const f = fake(({ path }) => {
        if (path.startsWith("search/"))
          return response({ total_count: 1, incomplete_results: false, items: [issue] });
        if (path === "repos/alice/repo/issues/8") return response(issue);
        if (path.includes("issues/8/timeline"))
          return response([
            {
              id: 45,
              event: "labeled",
              label: { name: "bug" },
              actor: user,
              created_at: "2026-11-05T00:00:10Z",
            },
          ]);
        return response([]);
      });
      const result = yield* f.adapter.poll(
        input({
          watchRepositoryEvents: true,
          pullRequestNumbers: [],
          source: {
            ...source,
            config: {
              ...source.config,
              discovery: { assigned: false, mentions: false, review_requests: false },
            },
          },
        }),
      );
      expect(result.triggers.find((t) => t.kind === "opened")).toMatchObject({
        actor_class: "person",
        text: "Please fix this concrete failure",
        metadata: { labels: ["bug"] },
      });
      expect(result.triggers.find((t) => t.kind === "labeled")).toMatchObject({
        metadata: {
          label: "bug",
          labels: ["bug"],
          thread_root: { text: "Please fix this concrete failure", actor_login: "alice" },
        },
      });
      expect(result.triggers.some((t) => t.kind.startsWith("discovery_"))).toBe(false);
    }),
);
