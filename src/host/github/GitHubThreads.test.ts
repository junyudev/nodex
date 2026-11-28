import {
  GitHubApi,
  GitHubApiAuthenticationError,
  GitHubApiNotFoundError,
  GitHubApiRateLimitError,
  GitHubApiResponseError,
  PinnedGitHubCredential,
  SourceAccount,
  type GitHubApiError,
  type GitHubGraphQlInput,
  type GitHubRestInput,
  type GitHubRestResponse,
} from "@nodex/agent-runtime/github-source";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  gitHubThreadKey,
  parseGitHubThreadUrl,
  type GitHubThreadCommand,
} from "../../shared/github-thread";
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

const pullRequestId = "thread-node-id";
const pendingReview = { id: "PRR_pending", commit: { oid: headSha } };
const reviewContext = (
  pending: { id: string; commit: { oid: string } } | null = null,
  headRefOid = headSha,
  threadPullRequestId?: string,
) => ({
  data: {
    repository: {
      pullRequest: { id: pullRequestId, headRefOid, reviews: { nodes: pending ? [pending] : [] } },
    },
    ...(threadPullRequestId && { node: { pullRequest: { id: threadPullRequestId } } }),
  },
});
const fileViews = (
  nodes: readonly { path: string; viewerViewedState: string }[],
  endCursor: string | null = null,
  headRefOid = headSha,
) => ({
  data: {
    repository: {
      pullRequest: {
        headRefOid,
        baseRefOid: "base",
        files: { nodes, pageInfo: { endCursor, hasNextPage: endCursor !== null } },
      },
    },
  },
});
const mutationAck = { data: { change: { clientMutationId: null } } };
const lineComment = {
  type: "add_review_comment",
  path: "README.md",
  line: 30,
  side: "right",
  startLine: 29,
  startSide: "right",
  body: "Can we explain this?",
  expectedHeadSha: headSha,
} as const;
const submitReview = {
  type: "submit_review",
  event: "approve",
  body: "",
  expectedHeadSha: headSha,
  pendingReviewId: null,
} as const;

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
        expect(detail.reactions).toEqual({
          subjectId: "PR_nodex_fixture",
          viewerCanReact: true,
          groups: [
            { content: "thumbs_up", count: 4, viewerReacted: false },
            { content: "heart", count: 2, viewerReacted: true },
          ],
        });
        expect(detail.viewer.canApprove).toBe(false);
        expect(detail.timeline[1]).toMatchObject({
          anchor: "pullrequestreview-5966695841",
          threadIds: ["PRRT_logout"],
          canEdit: false,
          reactions: { groups: [{ content: "hooray", count: 1, viewerReacted: false }] },
        });
        expect(detail.reviewThreadsTruncated).toBe(true);
        expect(detail.reviewThreads).toMatchObject([
          {
            id: "PRRT_logout",
            path: "pkg/cmd/auth/logout/logout.go",
            subject: "line",
            resolved: true,
            outdated: true,
            canReply: true,
            canResolve: false,
            canUnresolve: true,
            line: null,
            startLine: null,
            originalLine: 73,
            originalStartLine: 72,
            side: "right",
            startSide: "left",
            diffHunk: "@@ -71,2 +71,3 @@\n+\treturn err",
            commentsTruncated: true,
            comments: [
              {
                anchor: "discussion_r4622141622",
                pending: false,
                canEdit: false,
                canDelete: false,
                reactions: { groups: [{ content: "thumbs_up", count: 1, viewerReacted: false }] },
              },
            ],
          },
        ]);
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
          viewer: {
            login: account.account_login,
            canComment: false,
            canChangeState: false,
            canEdit: false,
          },
          reactions: { viewerCanReact: true, groups: [] },
        },
      });
      if (result.status !== "ready") throw new Error(JSON.stringify(result));
      expect(result.detail.timeline).toHaveLength(1);
      expect(result.detail.timeline[0]).toMatchObject({
        kind: "comment",
        anchor: expect.stringMatching(/^issuecomment-\d+$/),
        canEdit: true,
        canDelete: false,
        reactions: { groups: [{ content: "eyes", count: 1, viewerReacted: true }] },
      });
    }),
  );

  it.effect("keeps the viewer's pending replies on their original threads", () =>
    Effect.gen(function* () {
      const value = prFixture.data.repository.pullRequest;
      const [thread] = value.reviewThreads.nodes;
      const root = thread?.comments.nodes[0];
      const review = value.timelineItems.nodes.find(
        (item) => item.__typename === "PullRequestReview",
      );
      if (!thread || !root || !review) throw new Error("Missing submitted review fixture");
      const pending = { ...pendingReview, body: "Draft review", comments: { totalCount: 2 } };
      const reply = {
        ...root,
        id: "PRRC_pending",
        databaseId: null,
        author: { ...value.author, login: account.account_login },
        lastEditedAt: value.updatedAt,
        url: `${value.url}#discussion_r5000000000`,
        diffHunk: "not the thread's opening hunk",
        state: "PENDING",
        pullRequestReview: { id: pending.id },
        viewerCanUpdate: true,
        viewerCanDelete: true,
      };
      const publishedReplyReview = {
        ...review,
        id: "PRR_later",
        __typename: "PullRequestReview",
      };
      const pullRequest = {
        ...value,
        state: "OPEN",
        isInMergeQueue: true,
        viewerCanEnableAutoMerge: true,
        reviews: { nodes: [pending] },
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              ...thread,
              comments: {
                ...thread.comments,
                nodes: [
                  root,
                  reply,
                  {
                    ...root,
                    id: "PRRC_later",
                    pullRequestReview: { id: publishedReplyReview.id },
                  },
                ],
              },
            },
            {
              ...thread,
              id: "PRRT_file",
              subjectType: "FILE",
              isOutdated: false,
              line: null,
              startLine: null,
              originalLine: null,
              originalStartLine: null,
              startDiffSide: null,
              comments: {
                pageInfo: { hasNextPage: false },
                nodes: [{ ...reply, id: "PRRC_file", diffHunk: "" }],
              },
            },
          ],
        },
        timelineItems: {
          ...value.timelineItems,
          nodes: [
            review,
            publishedReplyReview,
            { ...review, __typename: "PullRequestReview", id: pending.id, state: "PENDING" },
          ],
        },
      };
      const f = yield* makeFixture({
        graph: (input) => {
          if (input.operation === "thread.identity") return defaultGraphql(input);
          expect(input.variables?.login).toBe(account.account_login);
          return Effect.succeed({
            data: { repository: { ...prFixture.data.repository, pullRequest } },
          });
        },
      });
      expect(yield* f.read(ref)).toMatchObject({
        status: "ready",
        detail: {
          mergeQueued: true,
          viewer: { canApprove: true, canEnableAutoMerge: true, canDisableAutoMerge: false },
          reviewThreadsTruncated: false,
          pendingReview: {
            id: pending.id,
            body: pending.body,
            commitSha: headSha,
            commentCount: 2,
          },
          timeline: [{ threadIds: ["PRRT_logout"] }, { id: "PRR_later", threadIds: [] }],
          reviewThreads: [
            {
              diffHunk: root.diffHunk,
              comments: [
                { pending: false },
                {
                  anchor: "discussion_r5000000000",
                  reviewId: pending.id,
                  pending: true,
                  edited: true,
                  canEdit: true,
                  canDelete: true,
                  reactions: null,
                },
                { reviewId: "PRR_later" },
              ],
            },
            { subject: "file", diffHunk: "", line: null, commentsTruncated: false },
          ],
        },
      });
      pullRequest.author = { ...value.author, login: account.account_login.toUpperCase() };
      expect(yield* f.read(ref)).toMatchObject({ detail: { viewer: { canApprove: false } } });
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
      // GitHub answers a missing thread with partial data and a field-scoped NOT_FOUND.
      const threads = yield* makeFixture({
        graph: (input) =>
          Effect.gen(function* () {
            expect(input).toMatchObject({
              operation: "thread.summaries",
              allowMissingFields: true,
            });
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return summariesFixture;
          }),
      });
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
      expect(threads.callsTo("thread.summaries")).toHaveLength(1);
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

  it.effect("fences line comments, review submission, and discard against stale context", () =>
    Effect.gen(function* () {
      const anotherHead = "1".repeat(40);
      let context = reviewContext(null, anotherHead);
      const f = yield* makeFixture({
        graph: (input) => {
          if (input.operation !== "thread.review_context") return Effect.die("Unexpected write");
          expect(input.variables?.login).toBe(account.account_login);
          return Effect.succeed(context);
        },
      });
      const publish = { ...lineComment, delivery: { kind: "publish" } } as const;
      expect(yield* f.command(ref, publish)).toEqual({ status: "head_changed" });
      expect(yield* f.command(ref, submitReview)).toEqual({ status: "head_changed" });

      context = reviewContext(pendingReview);
      for (const command of [
        publish,
        { ...lineComment, delivery: { kind: "start_review" } },
        { ...lineComment, delivery: { kind: "pending_review", reviewId: "different" } },
        submitReview,
        { ...submitReview, pendingReviewId: "different" },
        { type: "discard_review", pendingReviewId: "different" },
      ] satisfies GitHubThreadCommand[]) {
        expect(yield* f.command(ref, command)).toEqual({ status: "review_changed" });
      }
      context = reviewContext({ ...pendingReview, commit: { oid: anotherHead } });
      expect(
        yield* f.command(ref, {
          ...lineComment,
          delivery: { kind: "pending_review", reviewId: pendingReview.id },
        }),
      ).toEqual({ status: "review_changed" });
    }),
  );

  it.effect("publishes line ranges and whole-file comments against the selected commit", () =>
    Effect.gen(function* () {
      const url = `https://github.com/cli/cli/pull/${ref.number}#discussion_r200`;
      const f = yield* makeFixture({
        graph: () => Effect.succeed(reviewContext()),
        rest: () => Effect.succeed(json({ html_url: url })),
      });
      const { body, path } = lineComment;
      const publish = { ...lineComment, delivery: { kind: "publish" } } as const;
      expect(yield* f.command(ref, publish)).toEqual({ status: "applied", url });
      const { startSide: _side, startLine: _line, ...fileComment } = publish;
      expect(yield* f.command(ref, { ...fileComment, line: null })).toEqual({
        status: "applied",
        url,
      });
      const [range, file] = f.callsTo("thread.add_review_comment");
      expect(range).toMatchObject({
        method: "POST",
        path: "repos/CLI/CLI/pulls/15100/comments",
        body: {
          body,
          path,
          commit_id: headSha,
          line: 30,
          side: "RIGHT",
          start_line: 29,
          start_side: "RIGHT",
        },
      });
      expect(file).toHaveProperty("body", { body, path, commit_id: headSha, subject_type: "file" });
    }),
  );

  it.effect(
    "opens pending reviews with line comments and attaches file comments to a pending review",
    () =>
      Effect.gen(function* () {
        let context = reviewContext();
        const f = yield* makeFixture({
          graph: (input) => {
            if (input.operation === "thread.review_context") return Effect.succeed(context);
            if (input.query.includes("addPullRequestReview(")) {
              return Effect.succeed({
                data: { change: { pullRequestReview: { id: pendingReview.id } } },
              });
            }
            return Effect.succeed(mutationAck);
          },
        });
        const start = { ...lineComment, delivery: { kind: "start_review" } } as const;
        expect(yield* f.command(ref, start)).toEqual({ status: "applied", url: null });
        const { startLine: _line, startSide: _side, ...fileComment } = start;
        expect(yield* f.command(ref, { ...fileComment, line: null })).toEqual({
          status: "applied",
          url: null,
        });
        context = reviewContext(pendingReview);
        expect(
          yield* f.command(ref, {
            ...lineComment,
            delivery: { kind: "pending_review", reviewId: pendingReview.id },
          }),
        ).toEqual({ status: "applied", url: null });
        const [startLine, startFile, attachFile, attachLine] = f.callsTo(
          "thread.mutation.add_review_comment",
        );
        const { body, path } = lineComment;
        const position = { body, path, line: 30, side: "RIGHT", startLine: 29, startSide: "RIGHT" };
        expect(startLine).toHaveProperty("variables.input", {
          pullRequestId,
          commitOID: headSha,
          threads: [position],
        });
        expect(startFile).toHaveProperty("variables.input", { pullRequestId, commitOID: headSha });
        expect(attachFile).toHaveProperty("variables.input", {
          pullRequestReviewId: pendingReview.id,
          body,
          path,
          subjectType: "FILE",
        });
        expect(attachLine).toHaveProperty("variables.input", {
          pullRequestReviewId: pendingReview.id,
          ...position,
        });
      }),
  );

  it.effect("requires a pending reply to target the verified review and its pull request", () =>
    Effect.gen(function* () {
      let context = reviewContext(pendingReview, headSha, "another-PR");
      const f = yield* makeFixture({
        graph: ({ operation }) =>
          Effect.succeed(operation === "thread.review_context" ? context : mutationAck),
      });
      const reply = { type: "reply", threadId: "PRRT_thread", body: "Thanks!" } as const;
      const pending = {
        ...reply,
        delivery: { kind: "pending_review", reviewId: pendingReview.id },
      } as const;
      expect(yield* f.command(ref, pending)).toMatchObject({ status: "rejected" });
      context = reviewContext(null, headSha, pullRequestId);
      expect(yield* f.command(ref, pending)).toEqual({ status: "review_changed" });
      context = reviewContext(pendingReview, "0".repeat(40), pullRequestId);
      expect(yield* f.command(ref, pending)).toEqual({ status: "review_changed" });
      context = reviewContext(pendingReview, headSha, pullRequestId);
      expect(yield* f.command(ref, pending)).toEqual({ status: "applied", url: null });
      expect(yield* f.command(ref, { ...reply, delivery: { kind: "publish" } })).toEqual({
        status: "applied",
        url: null,
      });
      expect(f.callsTo("thread.mutation.reply")).toMatchObject([
        {
          variables: {
            input: {
              pullRequestReviewThreadId: reply.threadId,
              body: reply.body,
              pullRequestReviewId: pendingReview.id,
            },
          },
        },
        { variables: { input: { pullRequestReviewThreadId: reply.threadId, body: reply.body } } },
      ]);
      expect(f.callsTo("thread.mutation.reply").at(-1)).not.toHaveProperty(
        "variables.input.pullRequestReviewId",
      );
    }),
  );

  it.effect(
    "accepts older pending reviews for submit and discard, and reports standalone refusals",
    () =>
      Effect.gen(function* () {
        let context = reviewContext();
        const ownReview = "Can not approve your own pull request";
        const f = yield* makeFixture({
          graph: ({ operation, variables }) => {
            if (operation === "thread.review_context") return Effect.succeed(context);
            if (operation === "thread.mutation.discard_review") {
              expect(variables?.input).toEqual({ pullRequestReviewId: pendingReview.id });
              return Effect.succeed(mutationAck);
            }
            expect(variables?.input).toEqual({
              pullRequestReviewId: pendingReview.id,
              event: "REQUEST_CHANGES",
              body: "Please update the tests.",
            });
            return Effect.succeed(mutationAck);
          },
          rest: (input) => {
            expect(input).toMatchObject({
              method: "POST",
              path: "repos/CLI/CLI/pulls/15100/reviews",
              body: { commit_id: headSha, event: "APPROVE" },
            });
            expect(JSON.parse(JSON.stringify(input.body))).not.toHaveProperty("body");
            return Effect.fail(
              new GitHubApiResponseError({
                host,
                operation: input.operation,
                status: 422,
                githubErrors: [ownReview],
              }),
            );
          },
        });
        expect(yield* f.command(ref, submitReview)).toEqual({
          status: "rejected",
          message: ownReview,
        });
        context = reviewContext(pendingReview, "0".repeat(40));
        expect(
          yield* f.command(ref, {
            ...submitReview,
            pendingReviewId: pendingReview.id,
            event: "request_changes",
            body: "Please update the tests.",
          }),
        ).toEqual({ status: "applied", url: null });
        expect(
          yield* f.command(ref, { type: "discard_review", pendingReviewId: pendingReview.id }),
        ).toEqual({ status: "applied", url: null });
      }),
  );

  it.effect("rejects GraphQL errors even when GitHub returns a mutation payload", () =>
    Effect.gen(function* () {
      const message = "Could not resolve to a node with the global id";
      const f = yield* makeFixture({
        graph: (input) => {
          expect(input.query).toContain("removeReaction(");
          expect(input.variables?.input).toEqual({ subjectId: "comment", content: "THUMBS_UP" });
          return Effect.succeed({
            ...mutationAck,
            errors: [{ type: "NOT_FOUND", path: ["change"], message }],
          });
        },
      });
      expect(
        yield* f.command(ref, {
          type: "react",
          subjectId: "comment",
          content: "thumbs_up",
          reacted: false,
        }),
      ).toEqual({ status: "rejected", message });
    }),
  );

  it.effect("fences auto-merge by head including when GitHub detects a racing push", () =>
    Effect.gen(function* () {
      const anotherHead = "1".repeat(40);
      let context = reviewContext(null, anotherHead);
      const f = yield* makeFixture({
        graph: (input) => {
          if (input.operation === "thread.review_context") return Effect.succeed(context);
          expect(input.variables?.input).toEqual({
            pullRequestId,
            mergeMethod: "SQUASH",
            expectedHeadOid: headSha,
          });
          return Effect.fail(
            new GitHubApiResponseError({
              host,
              operation: input.operation,
              status: 200,
              githubErrors: ["Head sha does not match expected head sha"],
            }),
          );
        },
      });
      const enable = {
        type: "enable_auto_merge",
        expectedHeadSha: headSha,
        method: "squash",
      } as const;
      expect(yield* f.command(ref, enable)).toEqual({ status: "head_changed" });
      context = reviewContext();
      expect(yield* f.command(ref, enable)).toEqual({ status: "head_changed" });
    }),
  );

  it.effect("merges paged viewer marks by path within the file limit", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        graph: ({ variables }) => {
          switch (variables?.cursor) {
            case null:
              return Effect.succeed(
                fileViews([{ path: "page-3-file-99", viewerViewedState: "DISMISSED" }], "second"),
              );
            case "second":
              return Effect.succeed(
                fileViews([{ path: "page-1-file-0", viewerViewedState: "VIEWED" }], "third"),
              );
            case "third":
              return Effect.succeed(
                fileViews(
                  [{ path: "page-2-file-0", viewerViewedState: "UNVIEWED" }],
                  "beyond-limit",
                ),
              );
            default:
              return Effect.die("Requested file marks beyond the 300-file window");
          }
        },
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
      expect(response.files.files[0]).toMatchObject({
        path: "page-1-file-0",
        patch: null,
        viewed: "viewed",
      });
      expect(response.files.files[1]).toMatchObject({
        patch: expect.stringContaining("+new"),
        viewed: "unviewed",
      });
      expect(response.files.files[100]).toMatchObject({ viewed: "unviewed" });
      expect(response.files.files[299]).toMatchObject({
        path: "page-3-file-99",
        viewed: "dismissed",
      });
    }),
  );
  it.effect("refuses to publish file pages when the PR changes during the read", () =>
    Effect.gen(function* () {
      let observedHead = headSha;
      const f = yield* makeFixture({
        graph: () => Effect.succeed(fileViews([])),
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
