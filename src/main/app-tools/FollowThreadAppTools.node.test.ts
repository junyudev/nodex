import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeWithCapture } from "./FollowThreadAppTools";
import { createAppToolAdmissionFixture } from "./app-tool-operation.test-fixtures";
import { createHostedAppToolCaller } from "./AppToolCaller";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import {
  GitHubSourceAdapter,
  SourceReadError,
  type Source,
  type ExternalThread,
} from "../../host/sources/GitHubSourceAdapter";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type { ProjectWorkspaceApplyInput, ProjectWorkspaceRead } from "../core-client/types";
const authority: NodexAgentTurnContext = {
  threadId: "thread",
  rootThreadId: "thread",
  turnId: "run",
  actorProjectId: null,
  libraryId: "library",
  storeEpoch: "epoch",
  admittedAtMs: 1,
  runtime: { sessionId: "chat", runtimeId: "runtime", turnKind: "run" },
};
const source: Source = {
  id: "source",
  kind: "github",
  library_id: "library",
  revision: 1,
  enabled: true,
  enabled_at_ms: 1,
  config: {
    host: "github.com",
    account_id: "1",
    account_login: "alice",
    credential_ref: "gh:github.com:alice",
    repositories: [{ id: "10", name: "alice/repo", enabled: true }],
    discovery: { assigned: true, review_requests: true, mentions: true },
  },
};
const thread: ExternalThread = {
  id: "github:github.com:10:7",
  host: "github.com",
  repository_id: "10",
  repository: "alice/repo",
  number: 7,
  kind: "pull_request",
  url: "https://github.com/alice/repo/pull/7",
  title: "Work",
  state: "open",
  observation_revision: 0,
  observations: {},
};
const issue: ExternalThread = {
  ...thread,
  id: "github:github.com:10:8",
  number: 8,
  kind: "issue",
  url: "https://github.com/alice/repo/issues/8",
};
it.effect(
  "follows verified threads with managed authority and rejects declaring an issue as the Page's PR",
  () =>
    Effect.gen(function* () {
      let verified = false;
      let fail = false;
      let live = true;
      const writes: ProjectWorkspaceApplyInput[] = [];
      const caller = createHostedAppToolCaller({
        backend: "codex",
        authority,
        callId: "call",
        generation: 1,
        isActive: () => true,
        capture: Effect.succeed(authority),
      });
      const execute = yield* makeWithCapture(() => Effect.succeed(live ? authority : null)).pipe(
        Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
        Effect.provideService(CoreModules, {
          workspace: {
            admitToolOperation: createAppToolAdmissionFixture().admitToolOperation,
            read: (read: ProjectWorkspaceRead) =>
              Effect.sync(() => {
                if (read.kind !== "sources") throw new Error("Unexpected read");
                return {
                  value: {
                    kind: "sources",
                    value:
                      read.read.kind === "sources"
                        ? { kind: "sources", sources: [source] }
                        : {
                            kind: "threads",
                            threads: [
                              {
                                ...thread,
                                observation_revision: 7,
                                observations: { seen: { fingerprint: "same", revision: 3 } },
                              },
                            ],
                          },
                  },
                };
              }),
            apply: (write: ProjectWorkspaceApplyInput) =>
              Effect.sync(() => {
                assert.isTrue(verified);
                writes.push(write);
                return {};
              }),
          },
        } as never),
        Effect.provideService(GitHubSourceAdapter, {
          verifyThread: (_source: Source, url: string) =>
            Effect.gen(function* () {
              if (fail) return yield* new SourceReadError({ reason: "not_found" });
              verified = true;
              if (url === issue.url) return issue;
              assert.equal(url, thread.url);
              return thread;
            }),
        } as never),
      );
      const input = { caller, name: "follow_thread", arguments: { url: thread.url } };
      live = false;
      assert.isTrue((yield* execute(input)).isError);
      assert.isEmpty(writes);
      live = true;
      fail = true;
      assert.isTrue((yield* execute(input)).isError);
      assert.isEmpty(writes);
      fail = false;
      assert.isUndefined((yield* execute(input)).isError);
      assert.isUndefined(
        (yield* execute({ ...input, arguments: { url: thread.url, role: "own_pr" } })).isError,
      );
      const rejected = yield* execute({ ...input, arguments: { url: issue.url, role: "own_pr" } });
      assert.isTrue(rejected.isError);
      assert.deepEqual(rejected.content, [
        { type: "text", text: "The own_pr role requires a pull request URL." },
      ]);
      const roles = writes.map(({ intent }) => {
        if (
          intent.kind !== "agent_command" ||
          intent.intent.kind !== "source" ||
          intent.intent.command.kind !== "follow_thread"
        )
          throw new Error("Missing follow");
        assert.equal(intent.provenance.authority.runtime?.session_id, "chat");
        assert.equal(intent.intent.command.thread.observation_revision, 7);
        assert.deepEqual(intent.intent.command.thread.observations, {
          seen: { fingerprint: "same", revision: 3 },
        });
        return intent.intent.command.role;
      });
      assert.deepEqual(roles, [undefined, "own_pr"]);
    }),
);
