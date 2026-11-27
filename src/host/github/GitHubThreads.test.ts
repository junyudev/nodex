import {
  GitHubApi,
  GitHubApiAuthenticationError,
  GitHubApiNotFoundError,
  GitHubApiRateLimitError,
  GitHubApiResponseError,
  PinnedGitHubCredential,
  SourceAccount,
  sourceApiLayer,
  type GitHubApiError,
  type GitHubGraphQlInput,
  type GitHubRestInput,
  type GitHubRestResponse,
} from "@nodex/agent-runtime/github-source";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { gitHubThreadKey, parseGitHubThreadUrl } from "../../shared/github-thread";
import { makeGitHubAccount } from "./GitHubAccount";
import { makeGitHubThreads } from "./GitHubThreads";
import issueFixture from "./fixtures/issue.json";
import prFixture from "./fixtures/pull-request.json";
import summariesFixture from "./fixtures/thread-summaries.json";

const host = "github.com";
const ref = { host, owner: "CLI", repo: "CLI", number: 15100 };
const headSha = prFixture.data.repository.pullRequest.headRefOid;
const account = { account_login: "octocat", account_id: "1" };
const prRepos = "repos/cli/cli/pulls/15100";
const json = (data: unknown): GitHubRestResponse => ({
  body: JSON.stringify(data),
  status: 200,
  headers: {},
  truncated: false,
  invalidUtf8: false,
});

const identity = (kind: "Issue" | "PullRequest") => ({
  data: {
    repository: {
      name: "cli",
      owner: { login: "cli" },
      issueOrPullRequest: { __typename: kind, id: "thread-node-id" },
    },
  },
});

const defaultGraphql = (input: GitHubGraphQlInput) =>
  Effect.succeed(input.operation === "thread.identity" ? identity("PullRequest") : prFixture);

const makeFixture = Effect.fnUntraced(function* (
  options: {
    readonly source?: typeof account | null;
    readonly graph?: (input: GitHubGraphQlInput) => Effect.Effect<unknown, GitHubApiError>;
    readonly rest?: (input: GitHubRestInput) => Effect.Effect<GitHubRestResponse, GitHubApiError>;
    readonly user?: { readonly login: string; readonly id: number };
    readonly authError?: GitHubApiError;
  } = {},
) {
  const requests: (GitHubGraphQlInput | GitHubRestInput)[] = [];
  const callsTo = (operation: string) => requests.filter((input) => input.operation === operation);
  const guard = (input: GitHubGraphQlInput | GitHubRestInput) =>
    Effect.gen(function* () {
      const pin = yield* PinnedGitHubCredential;
      expect(pin?.host).toBe(host);
      expect(pin?.credentialFingerprint).toBe("credential-fingerprint");
      expect(input.allowReserve).toBe(true);
      expect(input.allowPaused).toBe(false);
      requests.push(input);
    });
  const api: GitHubApi["Service"] = {
    credential: () =>
      Effect.gen(function* () {
        expect(yield* SourceAccount).toBe(account.account_login);
        if (options.authError) return yield* Effect.fail(options.authError);
        return { token: Redacted.make("private"), fingerprint: "credential-fingerprint" };
      }),
    graphql: (input) =>
      guard(input).pipe(
        Effect.andThen((options.graph ?? defaultGraphql)(input)),
        Effect.map((data) => JSON.stringify(data)),
      ),
    rest: (input) =>
      guard(input).pipe(
        Effect.andThen(() => {
          if (input.path === "user")
            return Effect.succeed(json(options.user ?? { login: account.account_login, id: 1 }));
          if (options.rest) return options.rest(input);
          return Effect.die("Unexpected REST request");
        }),
      ),
  };
  const threads = yield* makeGitHubThreads(api, yield* makeGitHubAccount(api), (requestedHost) =>
    Effect.succeed(
      requestedHost !== host || options.source === null ? undefined : (options.source ?? account),
    ),
  );
  return { ...threads, callsTo, requests };
});

describe("GitHub thread data", () => {
  it.effect(
    "resolves an issues link to a PR and projects activity, reviewers, checks, and merge methods",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const link = parseGitHubThreadUrl("https://github.com/CLI/CLI/issues/15100");
        if (!link) throw new Error("Expected the issue link to parse");
        const result = yield* f.read(link.ref);
        if (result.status !== "ready" || result.detail.kind !== "pull_request")
          throw new Error(JSON.stringify(result));
        const { detail } = result;
        expect(detail.ref).toEqual({ ...ref, owner: "cli", repo: "cli" });
        expect(detail).toMatchObject({
          state: "merged",
          headSha,
          baseBranch: "trunk",
          checksTruncated: true,
          timelineTruncated: true,
        });
        expect(detail.viewer.mergeMethods).toEqual(["squash", "merge"]);
        expect(detail.checks[0]).toMatchObject({
          name: "govulncheck",
          status: "failure",
          required: true,
        });
        expect(detail.reviewers.map(({ name, state }) => [name, state])).toEqual([
          ["babakks", "approved"],
          ["cli/reviewers", "pending"],
        ]);
        expect(detail.timeline.map((item) => item.kind)).toEqual([
          "commit",
          "review",
          "event",
          "event",
        ]);
        expect(detail.timeline[1]).toMatchObject({
          anchor: "pullrequestreview-5966695841",
          comments: [
            {
              anchor: "discussion_r4622141622",
              resolved: true,
              outdated: true,
              line: null,
              side: "right",
            },
          ],
        });
        expect(detail.timeline[2]).toMatchObject({
          event: { type: "cross_referenced", source: { ref: { number: 15152 } } },
        });
        expect(detail.timeline[3]).toMatchObject({
          event: { type: "merged", baseBranch: "trunk" },
        });
        expect(f.callsTo("thread.identity")).toHaveLength(1);
        expect(f.callsTo("thread.pull_request")).toHaveLength(1);
      }),
  );

  it.effect("projects issue state and permissions, hiding minimized comments", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        graph: (input) =>
          Effect.succeed(input.operation === "thread.identity" ? identity("Issue") : issueFixture),
      });
      const result = yield* f.read({ ...ref, number: 15176 });
      expect(result).toMatchObject({
        status: "ready",
        detail: {
          kind: "issue",
          state: "closed",
          stateReason: "not_planned",
          locked: true,
          viewer: { login: account.account_login, canComment: false, canChangeState: false },
        },
      });
      if (result.status !== "ready") throw new Error(JSON.stringify(result));
      expect(result.detail.timeline).toHaveLength(1);
      expect(result.detail.timeline[0]).toMatchObject({
        kind: "comment",
        anchor: expect.stringMatching(/^issuecomment-\d+$/),
      });
    }),
  );

  it.effect("shares in-flight case-insensitive lookups without retaining thread data", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const f = yield* makeFixture({
        graph: (input) =>
          input.operation === "thread.identity"
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(defaultGraphql(input)),
              )
            : defaultGraphql(input),
      });
      const results = yield* Effect.all(
        [
          f.read(ref),
          f.read({ ...ref, owner: "cli", repo: "cli" }),
          Deferred.await(entered).pipe(
            Effect.andThen(Effect.yieldNow),
            Effect.andThen(Deferred.succeed(release, undefined)),
          ),
        ],
        { concurrency: "unbounded" },
      );
      expect(results[0]).toEqual(results[1]);
      expect(results[0].status).toBe("ready");
      expect(f.callsTo("thread.identity")).toHaveLength(1);
      expect((yield* f.read(ref)).status).toBe("ready");
      expect(f.callsTo("thread.identity")).toHaveLength(2);
      expect(f.callsTo("source.verify")).toHaveLength(1);
    }),
  );

  it.effect("shares a batch and keeps found summaries when GitHub reports a missing field", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request.url);
          expect(request.headers.authorization).toBe("Bearer source-token");
          if (request.url.endsWith("/user")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ login: account.account_login, id: 1 }),
            );
          }
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return HttpClientResponse.fromWeb(request, Response.json(summariesFixture));
        }),
      );
      const apiLayer = sourceApiLayer(() =>
        Effect.succeed({ token: Redacted.make("source-token"), fingerprint: "source-fingerprint" }),
      ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)));
      const api = yield* Effect.service(GitHubApi).pipe(Effect.provide(apiLayer));
      const threads = yield* makeGitHubThreads(api, yield* makeGitHubAccount(api), () =>
        Effect.succeed(account),
      );
      const issue = { ...ref, number: 15170 };
      const missing = { ...ref, repo: "go-gh", number: 2147483647 };
      const [result, reordered] = yield* Effect.all(
        [
          threads.summaries([ref, issue, missing]),
          threads.summaries([missing, issue, { ...ref, owner: "cli", repo: "cli" }]),
          Deferred.await(entered).pipe(
            Effect.andThen(Effect.yieldNow),
            Effect.andThen(Deferred.succeed(release, undefined)),
          ),
        ],
        { concurrency: "unbounded" },
      );
      expect(result).toEqual({
        status: "ready",
        summaries: {
          [gitHubThreadKey(ref)]: {
            ref: { ...ref, owner: "cli", repo: "cli" },
            kind: "pull_request",
            url: "https://github.com/cli/cli/pull/15100",
            title: "Revoke CLI OAuth tokens on logout",
            state: "merged",
            draft: false,
          },
          [gitHubThreadKey(issue)]: {
            ref: { ...issue, owner: "cli", repo: "cli" },
            kind: "issue",
            url: "https://github.com/cli/cli/issues/15170",
            title: "gh ssh-key list",
            state: "closed",
            draft: false,
            stateReason: "not_planned",
          },
          [gitHubThreadKey(missing)]: null,
        },
      });
      expect(reordered).toEqual(result);
      expect(requests.filter((url) => url.endsWith("/graphql"))).toHaveLength(1);
    }),
  );

  it.effect(
    "refuses mixed hosts and hosts without a connected Source before making a request",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const other = { ...ref, host: "github.example.com" };
        const noSource = yield* makeFixture({ source: null });
        for (const result of [
          yield* f.summaries([other]),
          yield* f.summaries([ref, other]),
          yield* noSource.summaries([ref]),
        ]) {
          expect(result).toMatchObject({ status: "unavailable", reason: "not_connected" });
        }
        expect(f.requests).toEqual([]);
        expect(noSource.requests).toEqual([]);
      }),
  );

  it.effect("distinguishes disconnected, refused, mismatched, missing and paused outcomes", () =>
    Effect.gen(function* () {
      const context = { host, operation: "thread.identity" };
      const disconnected = yield* makeFixture({ source: null });
      const revoked = yield* makeFixture({ authError: new GitHubApiAuthenticationError(context) });
      const changed = yield* makeFixture({ user: { login: account.account_login, id: 2 } });
      const missing = yield* makeFixture({
        graph: () => Effect.fail(new GitHubApiNotFoundError(context)),
      });
      const retryAt = "2026-11-27T12:00:00.000Z";
      const limited = yield* makeFixture({
        graph: () =>
          Effect.fail(new GitHubApiRateLimitError({ ...context, retryAt: Date.parse(retryAt) })),
      });
      expect(yield* disconnected.read(ref)).toMatchObject({
        status: "unavailable",
        reason: "not_connected",
      });
      expect(disconnected.requests).toHaveLength(0);
      expect(yield* revoked.read(ref)).toMatchObject({
        status: "unavailable",
        reason: "reconnect",
      });
      expect(yield* changed.read(ref)).toMatchObject({
        status: "unavailable",
        reason: "reconnect",
      });
      expect(changed.callsTo("thread.identity")).toHaveLength(0);
      expect(yield* missing.read(ref)).toMatchObject({
        status: "unavailable",
        reason: "not_found",
      });
      expect(yield* limited.read(ref)).toMatchObject({
        status: "unavailable",
        reason: "rate_limited",
        retryAt,
      });
    }),
  );

  it.effect("fences merges by the expected head and shows GitHub's refusal", () =>
    Effect.gen(function* () {
      const message = "Base branch requirements have not been met";
      const merge = { type: "merge", method: "squash", expectedHeadSha: headSha } as const;
      let status = 409;
      const f = yield* makeFixture({
        rest: (input) => {
          expect(input).toMatchObject({
            method: "PUT",
            path: "repos/CLI/CLI/pulls/15100/merge",
            body: { merge_method: "squash", sha: headSha },
          });
          return Effect.fail(
            new GitHubApiResponseError({
              host,
              operation: input.operation,
              status,
              githubErrors: [message],
            }),
          );
        },
      });
      expect(yield* f.command(ref, merge)).toEqual({ status: "head_changed" });
      status = 422;
      expect(yield* f.command(ref, merge)).toEqual({ status: "rejected", message });
    }),
  );

  it.effect(
    "routes close and reopen to the resolved kind and gives only issues a state reason",
    () =>
      Effect.gen(function* () {
        const issueRef = { ...ref, number: 15176 };
        const f = yield* makeFixture({
          graph: (input) =>
            Effect.succeed(
              identity(input.variables?.number === issueRef.number ? "Issue" : "PullRequest"),
            ),
          rest: () => Effect.succeed(json({ html_url: "https://github.com/cli/cli" })),
        });

        expect(
          yield* f.command(issueRef, { type: "set_state", state: "closed", reason: "not_planned" }),
        ).toMatchObject({ status: "applied" });
        expect(yield* f.command(issueRef, { type: "set_state", state: "open" })).toMatchObject({
          status: "applied",
        });
        expect(yield* f.command(ref, { type: "set_state", state: "closed" })).toMatchObject({
          status: "applied",
        });
        expect(f.callsTo("thread.state")).toMatchObject([
          {
            method: "PATCH",
            path: "repos/cli/cli/issues/15176",
            body: { state: "closed", state_reason: "not_planned" },
          },
          {
            method: "PATCH",
            path: "repos/cli/cli/issues/15176",
            body: { state: "open", state_reason: "reopened" },
          },
          { method: "PATCH", path: prRepos, body: { state: "closed" } },
        ]);
        expect(f.callsTo("thread.state").at(-1)).not.toHaveProperty("body.state_reason");
      }),
  );

  it.effect("returns three bounded file pages and a null patch when GitHub omits it", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        rest: ({ path }) => {
          if (path === prRepos)
            return Effect.succeed(
              json({ head: { sha: headSha }, base: { sha: "base" }, changed_files: 320 }),
            );
          const page = new URLSearchParams(path.split("?").at(-1)).get("page");
          return Effect.succeed(
            json(
              Array.from({ length: 100 }, (_, index) => ({
                filename: `page-${page}-file-${index}`,
                status: "modified",
                additions: 1,
                deletions: 2,
                ...(index === 0 ? {} : { patch: "@@ -1,2 +1 @@\n-old\n-old\n+new" }),
              })),
            ),
          );
        },
      });
      const response = yield* f.files(ref);
      expect(response).toMatchObject({ status: "ready", files: { headSha, truncated: true } });
      if (response.status !== "ready") throw new Error(JSON.stringify(response));
      expect(response.files.files).toHaveLength(300);
      expect(response.files.files[0]).toMatchObject({ path: "page-1-file-0", patch: null });
      expect(response.files.files[1]?.patch).toContain("+new");
      expect(f.callsTo("thread.files")).toHaveLength(3);
    }),
  );
  it.effect("refuses to publish file pages when the PR changes during the read", () =>
    Effect.gen(function* () {
      let observedHead = headSha;
      const f = yield* makeFixture({
        rest: ({ path }) => {
          if (path === prRepos)
            return Effect.succeed(
              json({ head: { sha: observedHead }, base: { sha: "base" }, changed_files: 1 }),
            );
          observedHead = "0".repeat(40);
          return Effect.succeed(
            json([{ filename: "README.md", status: "modified", additions: 1, deletions: 1 }]),
          );
        },
      });
      expect(yield* f.files(ref)).toMatchObject({ status: "unavailable", reason: "failed" });
    }),
  );
});
