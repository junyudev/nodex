import {
  GitHubApi,
  GitHubApiNotFoundError,
  GitHubApiResponseError,
  type GitHubApiError,
  type GitHubRestResponse,
} from "@nodex/agent-runtime/github-source";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { z } from "zod";
import {
  gitHubThreadKey,
  type GitHubFileViewedState,
  type GitHubPullRequestFiles,
  type GitHubPullRequestFilesResult,
  type GitHubThreadCommand,
  type GitHubThreadCommandResult,
  type GitHubThreadDetail,
  type GitHubThreadReadResult,
  type GitHubThreadRef,
  type GitHubThreadSummariesResult,
  type GitHubUnavailable,
  type GitHubUnavailableReason,
} from "../../shared/github-thread";
import { parseGitHubAttachment } from "../../shared/github-media";
import type { GitHubMediaByteRange } from "../../main/platform/node/GitHubMediaCdn";
import { makeGitHubThreadMedia } from "./GitHubThreadMedia";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { readSources, type SourceCatalogError } from "../sources/SourceCatalog";
import { GitHubAccount, type GitHubAccountVerificationError } from "./GitHubAccount";
import {
  gitHubThreadMutations,
  readGitHubFileViews,
  readGitHubIssue,
  readGitHubPullRequest,
  readGitHubReviewContext,
  readGitHubThreadSummaries,
  resolveGitHubThread,
  setGitHubPullRequestDraft,
} from "./GitHubThreadDocuments";
import {
  canonicalRef,
  fileViewsResponse,
  identityResponse,
  issueResponse,
  projectIssue,
  projectPullRequest,
  projectThreadSummaries,
  pullRequestResponse,
  reviewContextResponse,
} from "./GitHubThreadProjection";

const admission = { allowReserve: true, allowPaused: false };
const pageSize = 100;
const maxFilePages = 3;
const maxFilePageBytes = 8 * 1024 * 1024;
const smallResponseBytes = 512 * 1024;
const count = z.number().int().nonnegative();
const pullHead = z.object({
  head: z.object({ sha: z.string() }),
  base: z.object({ sha: z.string() }),
  changed_files: count,
});
const filesResponse = z
  .array(
    z.object({
      filename: z.string(),
      previous_filename: z.string().optional(),
      status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
      additions: count,
      deletions: count,
      patch: z.string().optional(),
    }),
  )
  .max(pageSize);
const updatedThreadResult = z.object({ html_url: z.string() });
const mergeResult = z.object({ merged: z.boolean(), message: z.string() });
const mutationEnvelope = z.object({
  data: z.unknown(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});
const mutationAck = z.object({ clientMutationId: z.string().nullable() });
const startedReview = z.object({ pullRequestReview: z.object({ id: z.string() }) });
const draftResult = z.object({ pullRequest: z.object({ url: z.string() }) });
const unexpectedResponse = "GitHub returned an incomplete or unexpected response.";
const changedFilesMessage =
  "The pull request changed while loading files. Refresh to see the latest changes.";
const applied = { status: "applied", url: null } as const;
const headChanged = { status: "head_changed" } as const;
const reviewChanged = { status: "review_changed" } as const;

type ThreadError =
  | GitHubApiError
  | GitHubAccountVerificationError
  | SourceCatalogError
  | GitHubUnavailable;
type ThreadLookupKey = readonly [
  fingerprint: string,
  host: string,
  owner: string,
  repo: string,
  number: number,
];
type SourceAccountLookup = (host: string) => Effect.Effect<
  | {
      readonly account_login: string;
      readonly account_id: string;
    }
  | undefined,
  SourceCatalogError
>;

function unavailable(
  reason: GitHubUnavailableReason,
  message: string | null = null,
  retryAt?: number,
): GitHubUnavailable {
  return {
    status: "unavailable",
    reason,
    message,
    retryAt:
      retryAt !== undefined && Math.abs(retryAt) <= 8.64e15
        ? new Date(retryAt).toISOString()
        : null,
  };
}

function projectError(error: ThreadError): GitHubUnavailable {
  if (!("_tag" in error)) return error;
  switch (error._tag) {
    case "GitHubCliMissingError":
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "GitHubCliFailedError":
    case "GitHubAccountVerificationError":
    case "GitHubApiAuthenticationError":
      return unavailable("reconnect", error.message);
    case "GitHubApiNotFoundError":
      return unavailable("not_found");
    case "GitHubApiRateLimitError":
    case "SourceControlRateLimitPausedError":
      return unavailable("rate_limited", error.message, error.retryAt);
    default:
      return unavailable("failed", error.message);
  }
}

function rejection(
  error: ThreadError,
  operation: GitHubThreadCommand["type"],
): GitHubThreadCommandResult {
  if ("_tag" in error && error._tag === "GitHubApiResponseError") {
    const message = error.githubErrors?.join("\n") || error.message;
    if (operation === "merge" && error.status === 409) return headChanged;
    if (
      operation === "enable_auto_merge" &&
      (error.status === 409 ||
        /\bhead(?: ref)?(?: sha| oid| commit)?\b[^\n]*(?:does not match|did not match|doesn't match|mismatch|changed|modified|stale|out of date)/iu.test(
          message,
        ))
    )
      return headChanged;
    if (
      [403, 405, 409, 422].includes(error.status) ||
      (error.operation.startsWith("thread.mutation.") && error.githubErrors?.length)
    ) {
      return { status: "rejected", message };
    }
  }
  return projectError(error);
}

function decodeBody<T>(parse: (value: unknown) => T, body: string) {
  return Effect.try({
    try: () => parse(JSON.parse(body)),
    catch: () => unavailable("failed", unexpectedResponse),
  });
}

function decode<T>(schema: z.ZodType<T>, body: string) {
  return decodeBody((value) => schema.parse(value), body);
}

function decodeRest<T>(schema: z.ZodType<T>, response: GitHubRestResponse) {
  if (response.truncated || response.invalidUtf8)
    return Effect.fail(unavailable("failed", unexpectedResponse));
  return decode(schema, response.body);
}

const responseUrl = (response: GitHubRestResponse) =>
  decodeRest(updatedThreadResult, response).pipe(
    Effect.map((result) => result.html_url),
    Effect.orElseSucceed(() => null),
  );

function lookupKey(ref: GitHubThreadRef, fingerprint: string): ThreadLookupKey {
  return [fingerprint, ref.host, ref.owner.toLowerCase(), ref.repo.toLowerCase(), ref.number];
}

function threadRef([, host, owner, repo, number]: ThreadLookupKey): GitHubThreadRef {
  return { host, owner, repo, number };
}

function variables(ref: GitHubThreadRef) {
  return { owner: ref.owner, repo: ref.repo, number: ref.number };
}

function restPath(ref: GitHubThreadRef, kind: "pulls" | "issues") {
  return `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${kind}/${ref.number}`;
}

export const makeGitHubThreads = Effect.fn("GitHubThreads.make")(function* (
  api: GitHubApi["Service"],
  accounts: GitHubAccount["Service"],
  findAccount: SourceAccountLookup,
) {
  const verify = Effect.fn("GitHubThreads.verify")(function* (host: string) {
    const account = yield* findAccount(host);
    if (!account) return yield* Effect.fail(unavailable("not_connected"));
    return yield* accounts.verify(host, account.account_login, account.account_id, true);
  });

  const media = yield* makeGitHubThreadMedia(api);
  const attachment = Effect.fn("GitHubThreads.attachment")(
    function* (ref: GitHubThreadRef, url: string) {
      const target = parseGitHubAttachment(url);
      if (ref.host !== "github.com" || !target) return unavailable("not_found");
      const account = yield* verify(ref.host);
      const resolve = (verified: typeof account) =>
        verified.use(media.resolve(ref, target, verified.fingerprint));
      const { kind, mimeType, size } = yield* resolve(account);
      const fingerprint = account.fingerprint;
      const read = Effect.fn("GitHubThreads.readAttachment")(
        function* (range: GitHubMediaByteRange | null, signal: AbortSignal) {
          const current = yield* verify(ref.host);
          if (current.fingerprint !== fingerprint) return null;
          const resolved = yield* resolve(current);
          if (resolved.size !== size || resolved.mimeType !== mimeType) return null;
          return yield* media.read(resolved, range, signal);
        },
        Effect.orElseSucceed(() => null),
      );
      return { status: "ready" as const, kind, mimeType, size, read };
    },
    Effect.catch((error) => {
      // The REST response could mention a CDN URL. Keep error details inside the Host.
      const result = projectError(error);
      return Effect.succeed({ ...result, message: null });
    }),
  );

  const resolve = Effect.fn("GitHubThreads.resolve")(function* (ref: GitHubThreadRef) {
    const operation = "thread.identity";
    const body = yield* api.graphql({
      host: ref.host,
      operation,
      query: resolveGitHubThread,
      variables: variables(ref),
      maxResponseBytes: smallResponseBytes,
      ...admission,
    });
    const {
      data: { repository },
    } = yield* decode(identityResponse, body);
    const node = repository?.issueOrPullRequest;
    if (!repository || !node)
      return yield* new GitHubApiNotFoundError({ host: ref.host, operation });
    return { ref: canonicalRef(ref, repository), kind: node.__typename, id: node.id };
  });

  const readDetail = Effect.fn("GitHubThreads.readDetail")(function* (
    requested: GitHubThreadRef,
    login: string,
  ): Effect.fn.Return<GitHubThreadDetail, ThreadError> {
    const { ref, kind } = yield* resolve(requested);
    const input = { host: ref.host, variables: variables(ref), ...admission };
    if (kind === "Issue") {
      const operation = "thread.issue";
      const body = yield* api.graphql({ ...input, operation, query: readGitHubIssue });
      const {
        data: { repository },
      } = yield* decode(issueResponse, body);
      if (!repository?.issue)
        return yield* new GitHubApiNotFoundError({ host: ref.host, operation });
      const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return projectIssue(repository, repository.issue, ref, login, observedAt);
    }
    const operation = "thread.pull_request";
    const pullInput = { ...input, operation, variables: { ...input.variables, login } };
    const body = yield* api.graphql({ ...pullInput, query: readGitHubPullRequest(true) }).pipe(
      Effect.catchIf(
        (error): error is GitHubApiResponseError =>
          error._tag === "GitHubApiResponseError" &&
          (error.githubErrors?.some((message) =>
            /(?:isRequired|pullRequestNumber).*(?:doesn't exist|doesn't accept|does not exist|unknown)|(?:unknown (?:argument|field)|cannot query field).*(?:isRequired|pullRequestNumber)/iu.test(
              message,
            ),
          ) ??
            false),
        () => api.graphql({ ...pullInput, query: readGitHubPullRequest(false) }),
      ),
    );
    const {
      data: { repository },
    } = yield* decode(pullRequestResponse, body);
    if (!repository?.pullRequest)
      return yield* new GitHubApiNotFoundError({ host: ref.host, operation });
    const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    return projectPullRequest(repository, repository.pullRequest, ref, login, observedAt);
  });

  const readFileList = Effect.fn("GitHubThreads.readFileList")(function* (
    ref: GitHubThreadRef,
  ): Effect.fn.Return<GitHubPullRequestFiles, ThreadError> {
    const path = restPath(ref, "pulls");
    const request = { host: ref.host, ...admission };
    const snapshot = api
      .rest({
        ...request,
        operation: "thread.files.head",
        path,
        maxResponseBytes: smallResponseBytes,
      })
      .pipe(Effect.flatMap((response) => decodeRest(pullHead, response)));
    const before = yield* snapshot;
    const files: z.infer<typeof filesResponse> = [];
    let hasMore = false;
    for (let page = 1; page <= maxFilePages; page++) {
      const response = yield* api.rest({
        ...request,
        operation: "thread.files",
        path: `${path}/files?per_page=${pageSize}&page=${page}`,
        maxResponseBytes: maxFilePageBytes,
      });
      const values = yield* decodeRest(filesResponse, response);
      files.push(...values);
      hasMore =
        /;\s*rel="next"/u.test(response.headers.link ?? "") || files.length < before.changed_files;
      if (!hasMore || values.length === 0) break;
    }
    const viewed = new Map<string, GitHubFileViewedState>();
    let cursor: string | null = null;
    for (let page = 0; page < maxFilePages; page++) {
      const operation = "thread.files.viewed";
      const body: string = yield* api.graphql({
        ...request,
        operation,
        query: readGitHubFileViews,
        variables: { ...variables(ref), cursor },
        maxResponseBytes: smallResponseBytes,
      });
      const { data } = yield* decode(fileViewsResponse, body);
      const pull = data.repository?.pullRequest;
      if (!pull) return yield* new GitHubApiNotFoundError({ host: ref.host, operation });
      if (pull.headRefOid !== before.head.sha || pull.baseRefOid !== before.base.sha)
        return yield* Effect.fail(unavailable("failed", changedFilesMessage));
      if (!pull.files) break;
      for (const file of pull.files.nodes ?? []) {
        if (file) viewed.set(file.path, file.viewerViewedState);
      }
      if (!pull.files.pageInfo.hasNextPage) break;
      cursor = pull.files.pageInfo.endCursor;
      if (cursor === null) return yield* Effect.fail(unavailable("failed", unexpectedResponse));
    }
    const after = yield* snapshot;
    if (
      before.head.sha !== after.head.sha ||
      before.base.sha !== after.base.sha ||
      before.changed_files !== after.changed_files
    )
      return yield* Effect.fail(unavailable("failed", changedFilesMessage));
    return {
      headSha: after.head.sha,
      files: files.map((file) => ({
        path: file.filename,
        previousPath: file.previous_filename ?? null,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch ?? null,
        viewed: viewed.get(file.filename) ?? "unviewed",
      })),
      truncated: hasMore,
    };
  });

  // Zero lifetime shares pending lookups only. The renderer owns foreground freshness.
  const detailReads = yield* Cache.make({
    capacity: Infinity,
    timeToLive: 0,
    lookup: ([login, key]: readonly [string, ThreadLookupKey]) => readDetail(threadRef(key), login),
  });
  const summaryReads = yield* Cache.make({
    capacity: Infinity,
    timeToLive: 0,
    lookup: Effect.fn("GitHubThreads.readSummaries")(function* ([host, , refs]: readonly [
      string,
      string,
      readonly ThreadLookupKey[],
    ]) {
      const { query, variables, repositories } = readGitHubThreadSummaries(refs.map(threadRef));
      const body = yield* api.graphql({
        host,
        operation: "thread.summaries",
        query,
        variables,
        allowMissingFields: true,
        maxResponseBytes: smallResponseBytes,
        ...admission,
      });
      return yield* decodeBody((value) => projectThreadSummaries(value, repositories), body);
    }),
  });
  const fileReads = yield* Cache.make({
    capacity: Infinity,
    timeToLive: 0,
    lookup: (key: ThreadLookupKey) => readFileList(threadRef(key)),
  });

  const read = Effect.fn("GitHubThreads.read")(
    function* (ref: GitHubThreadRef): Effect.fn.Return<GitHubThreadReadResult, ThreadError> {
      const account = yield* verify(ref.host);
      const detail = yield* account.use(
        Cache.get(detailReads, [account.login, lookupKey(ref, account.fingerprint)]),
      );
      return { status: "ready", detail };
    },
    Effect.catch((error) => Effect.succeed(projectError(error))),
  );
  const summaries = Effect.fn("GitHubThreads.summaries")(
    function* (
      refs: readonly GitHubThreadRef[],
    ): Effect.fn.Return<GitHubThreadSummariesResult, ThreadError> {
      const first = refs[0];
      if (!first) return { status: "ready", summaries: {} };
      const { host } = first;
      if (refs.some((ref) => ref.host !== host)) return unavailable("not_connected");
      const account = yield* verify(host);
      const byKey = new Map(refs.map((ref) => [gitHubThreadKey(ref), ref]));
      const normalized = [...byKey]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, ref]) => lookupKey(ref, account.fingerprint));
      const summaries = yield* account.use(
        Cache.get(summaryReads, [host, account.fingerprint, normalized]),
      );
      return { status: "ready", summaries };
    },
    Effect.catch((error) => Effect.succeed(projectError(error))),
  );
  const files = Effect.fn("GitHubThreads.files")(
    function* (ref: GitHubThreadRef): Effect.fn.Return<GitHubPullRequestFilesResult, ThreadError> {
      const account = yield* verify(ref.host);
      const files = yield* account.use(Cache.get(fileReads, lookupKey(ref, account.fingerprint)));
      return { status: "ready", files };
    },
    Effect.catch((error) => Effect.succeed(projectError(error))),
  );

  const reviewContext = Effect.fn("GitHubThreads.reviewContext")(function* (
    ref: GitHubThreadRef,
    login: string,
    threadId?: string,
  ) {
    const operation = "thread.review_context";
    const body = yield* api.graphql({
      host: ref.host,
      operation,
      query: readGitHubReviewContext(threadId !== undefined),
      variables: { ...variables(ref), login, threadId },
      allowMissingFields: threadId !== undefined,
      maxResponseBytes: smallResponseBytes,
      ...admission,
    });
    const { data } = yield* decode(reviewContextResponse, body);
    const pull = data.repository?.pullRequest;
    if (!pull) return yield* new GitHubApiNotFoundError({ host: ref.host, operation });
    const pending = pull.reviews?.nodes?.[0] ?? null;
    return {
      id: pull.id,
      headSha: pull.headRefOid,
      pending,
      pendingOnHead: pending?.commit?.oid === pull.headRefOid,
      threadPullRequestId: data.node?.pullRequest?.id ?? null,
    };
  });

  const resolvePullRequestId = Effect.fn("GitHubThreads.resolvePullRequestId")(function* (
    ref: GitHubThreadRef,
  ) {
    const thread = yield* resolve(ref);
    if (thread.kind !== "PullRequest")
      return yield* new GitHubApiNotFoundError({ host: ref.host, operation: "thread.identity" });
    return thread.id;
  });

  const writeGraphql = Effect.fn("GitHubThreads.writeGraphql")(function* <T>(
    host: string,
    type: GitHubThreadCommand["type"],
    query: string,
    variables: Readonly<Record<string, unknown>>,
    change: z.ZodType<T>,
  ) {
    const operation = `thread.mutation.${type}`;
    const body = yield* api.graphql({
      host,
      operation,
      query,
      variables,
      maxResponseBytes: smallResponseBytes,
      // Keep field-scoped NOT_FOUND errors so the command can surface GitHub's explanation.
      allowMissingFields: true,
      ...admission,
    });
    const { data, errors } = yield* decode(mutationEnvelope, body);
    if (errors?.length) {
      return yield* new GitHubApiResponseError({
        host,
        operation,
        status: 200,
        githubErrors: errors.map((error) => error.message),
      });
    }
    return yield* Effect.try({
      try: () => z.object({ change }).parse(data).change,
      catch: () => unavailable("failed", unexpectedResponse),
    });
  });

  const addReviewComment = Effect.fn("GitHubThreads.addReviewComment")(function* (
    ref: GitHubThreadRef,
    login: string,
    command: Extract<GitHubThreadCommand, { type: "add_review_comment" }>,
  ): Effect.fn.Return<GitHubThreadCommandResult, ThreadError> {
    const { id, headSha, pending, pendingOnHead } = yield* reviewContext(ref, login);
    if (headSha !== command.expectedHeadSha) return headChanged;

    const { delivery, body, path, line, startLine } = command;
    if (
      delivery.kind === "pending_review"
        ? pending?.id !== delivery.reviewId || !pendingOnHead
        : pending !== null
    )
      return reviewChanged;

    const side = command.side.toUpperCase();
    const startSide = startLine === undefined ? undefined : command.startSide?.toUpperCase();
    if (delivery.kind === "publish") {
      const response = yield* api.rest({
        host: ref.host,
        operation: "thread.add_review_comment",
        method: "POST",
        path: `${restPath(ref, "pulls")}/comments`,
        body: {
          body,
          path,
          commit_id: headSha,
          ...(line === null
            ? { subject_type: "file" }
            : {
                line,
                side,
                start_line: startLine,
                start_side: startSide,
              }),
        },
        maxResponseBytes: smallResponseBytes,
        ...admission,
      });
      return { status: "applied", url: yield* responseUrl(response) };
    }

    const position = line === null ? { subjectType: "FILE" } : { line, side, startLine, startSide };
    const thread = { body, path, ...position };
    let pullRequestReviewId: string;
    if (delivery.kind === "start_review") {
      // DraftPullRequestReviewThread only supports line comments. Open a pending review first
      // for a file-level comment, then attach it with AddPullRequestReviewThreadInput.
      const { pullRequestReview } = yield* writeGraphql(
        ref.host,
        command.type,
        gitHubThreadMutations.startReview,
        {
          input: {
            pullRequestId: id,
            commitOID: headSha,
            ...(line === null ? {} : { threads: [thread] }),
          },
        },
        startedReview,
      );
      if (line !== null) return applied;
      pullRequestReviewId = pullRequestReview.id;
    } else {
      pullRequestReviewId = delivery.reviewId;
    }

    yield* writeGraphql(
      ref.host,
      command.type,
      gitHubThreadMutations.addThread,
      { input: { pullRequestReviewId, ...thread } },
      mutationAck,
    );
    return applied;
  });

  const mutate = Effect.fn("GitHubThreads.mutate")(function* (
    ref: GitHubThreadRef,
    login: string,
    command: GitHubThreadCommand,
  ): Effect.fn.Return<GitHubThreadCommandResult, ThreadError> {
    const write = { host: ref.host, maxResponseBytes: smallResponseBytes, ...admission };
    const graphql = (query: string, input: Readonly<Record<string, unknown>>) =>
      writeGraphql(ref.host, command.type, query, { input }, mutationAck).pipe(Effect.as(applied));
    switch (command.type) {
      case "comment": {
        const result = yield* api.rest({
          ...write,
          operation: "thread.comment",
          method: "POST",
          path: `${restPath(ref, "issues")}/comments`,
          body: { body: command.body },
        });
        return { status: "applied", url: yield* responseUrl(result) };
      }
      case "merge": {
        const response = yield* api.rest({
          ...write,
          operation: "thread.merge",
          method: "PUT",
          path: `${restPath(ref, "pulls")}/merge`,
          body: { merge_method: command.method, sha: command.expectedHeadSha },
        });
        const result = yield* decodeRest(mergeResult, response);
        return result.merged
          ? { status: "applied", url: null }
          : { status: "rejected", message: result.message };
      }
      case "set_state": {
        const thread = yield* resolve(ref);
        const isIssue = thread.kind === "Issue";
        const response = yield* api.rest({
          ...write,
          operation: "thread.state",
          method: "PATCH",
          path: restPath(thread.ref, isIssue ? "issues" : "pulls"),
          body: isIssue
            ? {
                state: command.state,
                state_reason:
                  command.state === "open" ? "reopened" : (command.reason ?? "completed"),
              }
            : { state: command.state },
        });
        return { status: "applied", url: yield* responseUrl(response) };
      }
      case "set_draft": {
        const thread = yield* resolve(ref);
        if (thread.kind !== "PullRequest")
          return { status: "rejected", message: "Only pull requests can be drafts." };
        const { pullRequest } = yield* writeGraphql(
          ref.host,
          command.type,
          setGitHubPullRequestDraft(command.draft),
          { id: thread.id },
          draftResult,
        );
        return { status: "applied", url: pullRequest.url };
      }
      case "edit": {
        const { title, body } = command;
        const response = yield* api.rest({
          ...write,
          operation: "thread.edit",
          method: "PATCH",
          path: restPath(ref, "issues"),
          body: { title, body },
        });
        return { status: "applied", url: yield* responseUrl(response) };
      }
      case "edit_comment": {
        const { id, kind } = command.target;
        const field = {
          issue_comment: "id",
          review: "pullRequestReviewId",
          review_comment: "pullRequestReviewCommentId",
        }[kind];
        return yield* graphql(gitHubThreadMutations.editComment[kind], {
          [field]: id,
          body: command.body,
        });
      }
      case "delete_comment":
        return yield* graphql(gitHubThreadMutations.deleteComment[command.target.kind], {
          id: command.target.id,
        });
      case "react":
        return yield* graphql(
          command.reacted
            ? gitHubThreadMutations.addReaction
            : gitHubThreadMutations.removeReaction,
          { subjectId: command.subjectId, content: command.content.toUpperCase() },
        );
      case "add_review_comment":
        return yield* addReviewComment(ref, login, command);
      case "reply": {
        const { delivery, threadId, body } = command;
        if (delivery.kind === "pending_review") {
          const context = yield* reviewContext(ref, login, threadId);
          if (context.pending?.id !== delivery.reviewId || !context.pendingOnHead)
            return reviewChanged;
          if (context.threadPullRequestId !== context.id)
            return {
              status: "rejected",
              message: "This review thread does not belong to the pull request.",
            };
        }
        return yield* graphql(gitHubThreadMutations.reply, {
          pullRequestReviewThreadId: threadId,
          body,
          ...(delivery.kind === "pending_review" && { pullRequestReviewId: delivery.reviewId }),
        });
      }
      case "resolve_thread":
        return yield* graphql(
          command.resolved ? gitHubThreadMutations.resolve : gitHubThreadMutations.unresolve,
          { threadId: command.threadId },
        );
      case "submit_review": {
        const { pending, headSha } = yield* reviewContext(ref, login);
        if ((pending?.id ?? null) !== command.pendingReviewId) return reviewChanged;
        const event = command.event.toUpperCase();
        if (pending) {
          return yield* graphql(gitHubThreadMutations.submitReview, {
            pullRequestReviewId: pending.id,
            event,
            body: command.body,
          });
        }
        if (headSha !== command.expectedHeadSha) return headChanged;
        const response = yield* api.rest({
          ...write,
          operation: "thread.submit_review",
          method: "POST",
          path: `${restPath(ref, "pulls")}/reviews`,
          body: { commit_id: headSha, event, body: command.body.trim() ? command.body : undefined },
        });
        return { status: "applied", url: yield* responseUrl(response) };
      }
      case "discard_review": {
        const { pending } = yield* reviewContext(ref, login);
        if (pending?.id !== command.pendingReviewId) return reviewChanged;
        return yield* graphql(gitHubThreadMutations.discardReview, {
          pullRequestReviewId: pending.id,
        });
      }
      case "enable_auto_merge": {
        const { id, headSha } = yield* reviewContext(ref, login);
        if (headSha !== command.expectedHeadSha) return headChanged;
        return yield* graphql(gitHubThreadMutations.enableAutoMerge, {
          pullRequestId: id,
          mergeMethod: command.method.toUpperCase(),
          expectedHeadOid: headSha,
        });
      }
      case "disable_auto_merge":
        return yield* graphql(gitHubThreadMutations.disableAutoMerge, {
          pullRequestId: yield* resolvePullRequestId(ref),
        });
      case "set_file_viewed":
        return yield* graphql(
          command.viewed ? gitHubThreadMutations.markViewed : gitHubThreadMutations.unmarkViewed,
          { pullRequestId: yield* resolvePullRequestId(ref), path: command.path },
        );
    }
  });

  const command = Effect.fn("GitHubThreads.command")(
    function* (
      ref: GitHubThreadRef,
      command: GitHubThreadCommand,
    ): Effect.fn.Return<GitHubThreadCommandResult, ThreadError> {
      const account = yield* verify(ref.host);
      return yield* account
        .use(mutate(ref, account.login, command))
        .pipe(Effect.catch((error) => Effect.succeed(rejection(error, command.type))));
    },
    Effect.catch((error) => Effect.succeed(projectError(error))),
  );

  return { read, summaries, files, command, attachment };
});

export class GitHubThreads extends Context.Service<
  GitHubThreads,
  Effect.Success<ReturnType<typeof makeGitHubThreads>>
>()("nodex/host/GitHubThreads") {}

export const live = Layer.effect(
  GitHubThreads,
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    const accounts = yield* GitHubAccount;
    const sources = readSources(yield* CoreModules);
    return yield* makeGitHubThreads(api, accounts, (host) =>
      sources.pipe(
        Effect.map((sources) => sources.find((source) => source.config.host === host)?.config),
      ),
    );
  }),
);
