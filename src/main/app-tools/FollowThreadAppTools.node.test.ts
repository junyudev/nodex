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
it.effect(
  "commits only remotely verified context with captured managed authority and the current observation fence",
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
              assert.equal(url, thread.url);
              if (fail) return yield* new SourceReadError({ reason: "not_found" });
              verified = true;
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
      const intent = writes[0]!.intent;
      assert.equal(intent.kind, "agent_command");
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
    }),
);
