import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  GITHUB_THREAD_SUMMARY_BATCH_LIMIT,
  gitHubThreadKey,
  type GitHubIssueDetail,
  type GitHubThreadRef,
  type GitHubThreadSummariesResult,
  type GitHubThreadSummary,
  type GitHubUnavailable,
} from "../../shared/github-thread";
import {
  createGitHubThreadSummaryBatcher,
  gitHubThreadQueryKey,
  gitHubThreadQueryOptions,
  gitHubThreadSummaryQueryOptions,
  projectGitHubThreadSummary,
  runGitHubThreadCommand,
} from "./github-threads";

const ref = { host: "github.com", owner: "acme", repo: "tools", number: 1 };
const detail: GitHubIssueDetail = {
  ref,
  kind: "issue",
  url: "https://github.com/acme/tools/issues/1",
  title: "A closed issue",
  state: "closed",
  stateReason: "not_planned",
  body: "Full description",
  author: null,
  createdAt: "2026-10-10T09:30:00Z",
  updatedAt: "2026-10-10T09:30:00Z",
  closedAt: "2026-10-10T09:30:00Z",
  observedAt: "2026-10-10T09:30:00Z",
  labels: [],
  assignees: [],
  timeline: [],
  timelineTruncated: false,
  locked: false,
  closingPullRequests: [],
  viewer: { login: "me", canComment: true, canChangeState: true },
};
const summary = (thread: GitHubThreadRef): GitHubThreadSummary => ({
  ref: thread,
  kind: "issue",
  url: `https://${thread.host}/${thread.owner}/${thread.repo}/issues/${thread.number}`,
  title: `Issue ${thread.number}`,
  state: "open",
  draft: false,
});

afterEach(() => vi.unstubAllGlobals());

test("same-tick reads share bounded requests and settle by thread, Space and host", async () => {
  const unavailable: GitHubUnavailable = {
    status: "unavailable",
    reason: "not_connected",
    message: null,
    retryAt: null,
  };
  const transport = vi.fn(
    async (refs: readonly GitHubThreadRef[]): Promise<GitHubThreadSummariesResult> => {
      if (refs.some((ref) => ref.host !== "github.com")) return unavailable;
      return {
        status: "ready",
        summaries: Object.fromEntries(
          refs
            .toReversed()
            .map((ref) => [gitHubThreadKey(ref), ref.number === 2 ? null : summary(ref)]),
        ),
      };
    },
  );
  const read = createGitHubThreadSummaryBatcher(transport);
  const refs = Array.from({ length: GITHUB_THREAD_SUMMARY_BATCH_LIMIT + 2 }, (_, index) => ({
    ...ref,
    number: index + 1,
  }));
  const reads = refs.map((ref) => read("personal", ref));
  const duplicate = read("personal", { ...ref, owner: "ACME" });
  const [results, repeated, otherSpace, otherHost] = await Promise.all([
    Promise.all(reads),
    duplicate,
    read("another-space", ref),
    read("personal", { ...ref, host: "github.example.com" }),
  ]);

  expect(transport.mock.calls.map(([refs]) => refs.length)).toEqual([
    GITHUB_THREAD_SUMMARY_BATCH_LIMIT,
    2,
    1,
    1,
  ]);
  expect(results).toEqual(
    refs.map((ref) => (ref.number === 2 ? null : { status: "ready", summary: summary(ref) })),
  );
  expect(repeated).toEqual(results[0]);
  expect(otherSpace).toEqual(results[0]);
  expect(otherHost).toEqual(unavailable);
});

test("projects the issue state and reason without the full detail", () => {
  expect(projectGitHubThreadSummary(detail)).toEqual({
    ref,
    kind: "issue",
    url: detail.url,
    title: detail.title,
    state: "closed",
    stateReason: "not_planned",
    draft: false,
  });
});

test("summary reads reuse fresh detail, receive updates from tabs, and refresh after commands", async () => {
  const client = new QueryClient();
  const invoke = vi.fn(async (channel: string) => {
    if (channel === "github:thread")
      return { status: "ready", detail: { ...detail, title: "Renamed" } };
    if (channel === "github:thread-command") return { status: "applied", url: detail.url };
    if (channel === "github:thread-summaries") {
      return { status: "ready", summaries: { [gitHubThreadKey(ref)]: summary(ref) } };
    }
    throw Error(`Unexpected channel ${channel}`);
  });
  vi.stubGlobal("window", { api: { invoke } });

  try {
    client.setQueryData(gitHubThreadQueryKey(ref), { status: "ready", detail });
    const options = gitHubThreadSummaryQueryOptions(ref);
    expect(await client.fetchQuery(options)).toEqual({
      status: "ready",
      summary: projectGitHubThreadSummary(detail),
    });
    expect(invoke).not.toHaveBeenCalled();

    await client.fetchQuery(gitHubThreadQueryOptions(ref));
    expect(client.getQueryData(options.queryKey)).toMatchObject({
      status: "ready",
      summary: { title: "Renamed" },
    });

    await runGitHubThreadCommand(client, ref, { type: "set_state", state: "open" });
    expect(await client.fetchQuery(options)).toEqual({ status: "ready", summary: summary(ref) });
  } finally {
    client.clear();
  }
});
