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
  type GitHubPullRequestFiles,
  type GitHubPullRequestFilesResult,
  type GitHubThreadCommand,
  type GitHubThreadCommandResult,
  type GitHubThreadDetail,
  type GitHubThreadReadResult,
  type GitHubThreadRef,
  type GitHubUnavailable,
  type GitHubUnavailableReason,
} from "../../shared/github-thread";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { readSources, type SourceCatalogError } from "../sources/SourceCatalog";
import { GitHubAccount, type GitHubAccountVerificationError } from "./GitHubAccount";
import {
  readGitHubIssue,
  readGitHubPullRequest,
  resolveGitHubThread,
  setGitHubPullRequestDraft,
} from "./GitHubThreadDocuments";
import {
  canonicalRef,
  identityResponse,
  issueResponse,
  projectIssue,
  projectPullRequest,
  pullRequestResponse,
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
const draftResult = z.object({
  data: z.object({
    change: z.object({ pullRequest: z.object({ url: z.string() }).nullable() }).nullable(),
  }),
});

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
    if (operation === "merge" && error.status === 409) return { status: "head_changed" };
    if (
      [403, 405, 422].includes(error.status) ||
      (operation === "set_draft" && error.status === 200)
    ) {
      return { status: "rejected", message: error.githubErrors?.join("\n") || error.message };
    }
  }
  return projectError(error);
}

function decode<T>(schema: z.ZodType<T>, body: string) {
  return Effect.try({
    try: () => schema.parse(JSON.parse(body)),
    catch: () => unavailable("failed", "GitHub returned an incomplete or unexpected response."),
  });
}

function decodeRest<T>(schema: z.ZodType<T>, response: GitHubRestResponse) {
  if (response.truncated || response.invalidUtf8)
    return Effect.fail(
      unavailable("failed", "GitHub returned an incomplete or unexpected response."),
    );
  return decode(schema, response.body);
}

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
    const body = yield* api
      .graphql({ ...input, operation, query: readGitHubPullRequest(true) })
      .pipe(
        Effect.catchIf(
          (error): error is GitHubApiResponseError =>
            error._tag === "GitHubApiResponseError" &&
            (error.githubErrors?.some((message) =>
              /(?:isRequired|pullRequestNumber).*(?:doesn't exist|doesn't accept|does not exist|unknown)|(?:unknown (?:argument|field)|cannot query field).*(?:isRequired|pullRequestNumber)/iu.test(
                message,
              ),
            ) ??
              false),
          () => api.graphql({ ...input, operation, query: readGitHubPullRequest(false) }),
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
    const files: GitHubPullRequestFiles["files"][number][] = [];
    let hasMore = false;
    for (let page = 1; page <= maxFilePages; page++) {
      const response = yield* api.rest({
        ...request,
        operation: "thread.files",
        path: `${path}/files?per_page=${pageSize}&page=${page}`,
        maxResponseBytes: maxFilePageBytes,
      });
      const values = yield* decodeRest(filesResponse, response);
      files.push(
        ...values.map((file) => ({
          path: file.filename,
          previousPath: file.previous_filename ?? null,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch ?? null,
        })),
      );
      hasMore =
        /;\s*rel="next"/u.test(response.headers.link ?? "") || files.length < before.changed_files;
      if (!hasMore || values.length === 0) break;
    }
    const after = yield* snapshot;
    if (
      before.head.sha !== after.head.sha ||
      before.base.sha !== after.base.sha ||
      before.changed_files !== after.changed_files
    )
      return yield* Effect.fail(
        unavailable(
          "failed",
          "The pull request changed while loading files. Refresh to see the latest changes.",
        ),
      );
    return { headSha: after.head.sha, files, truncated: hasMore };
  });

  // Zero lifetime shares pending lookups only. The renderer owns foreground freshness.
  const detailReads = yield* Cache.make({
    capacity: Infinity,
    timeToLive: 0,
    lookup: ([login, key]: readonly [string, ThreadLookupKey]) => readDetail(threadRef(key), login),
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
  const files = Effect.fn("GitHubThreads.files")(
    function* (ref: GitHubThreadRef): Effect.fn.Return<GitHubPullRequestFilesResult, ThreadError> {
      const account = yield* verify(ref.host);
      const files = yield* account.use(Cache.get(fileReads, lookupKey(ref, account.fingerprint)));
      return { status: "ready", files };
    },
    Effect.catch((error) => Effect.succeed(projectError(error))),
  );

  const mutate = Effect.fn("GitHubThreads.mutate")(function* (
    ref: GitHubThreadRef,
    command: GitHubThreadCommand,
  ): Effect.fn.Return<GitHubThreadCommandResult, ThreadError> {
    const write = { host: ref.host, maxResponseBytes: smallResponseBytes, ...admission };
    switch (command.type) {
      case "comment": {
        const result = yield* api.rest({
          ...write,
          operation: "thread.comment",
          method: "POST",
          path: `${restPath(ref, "issues")}/comments`,
          body: { body: command.body },
        });
        const url = yield* decode(updatedThreadResult, result.body).pipe(
          Effect.map((result) => result.html_url),
          Effect.orElseSucceed(() => null),
        );
        return { status: "applied", url };
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
        const url = yield* decode(updatedThreadResult, response.body).pipe(
          Effect.map((result) => result.html_url),
          Effect.orElseSucceed(() => null),
        );
        return { status: "applied", url };
      }
      case "set_draft": {
        const thread = yield* resolve(ref);
        if (thread.kind !== "PullRequest")
          return { status: "rejected", message: "Only pull requests can be drafts." };
        const response = yield* api.graphql({
          ...write,
          operation: "thread.draft",
          variables: { id: thread.id },
          query: setGitHubPullRequestDraft(command.draft),
        });
        const { data } = yield* decode(draftResult, response);
        if (!data.change?.pullRequest)
          return yield* Effect.fail(
            unavailable("failed", "GitHub did not confirm the draft change."),
          );
        return { status: "applied", url: data.change.pullRequest.url };
      }
    }
  });

  const command = Effect.fn("GitHubThreads.command")(
    function* (
      ref: GitHubThreadRef,
      command: GitHubThreadCommand,
    ): Effect.fn.Return<GitHubThreadCommandResult, ThreadError> {
      const account = yield* verify(ref.host);
      return yield* account
        .use(mutate(ref, command))
        .pipe(Effect.catch((error) => Effect.succeed(rejection(error, command.type))));
    },
    Effect.catch((error) => Effect.succeed(projectError(error))),
  );

  return { read, files, command };
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
