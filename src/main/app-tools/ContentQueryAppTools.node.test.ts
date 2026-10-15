import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type { QueryRead } from "../core-client/types";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { makeWithCapture } from "./ContentQueryAppTools";

const authority: NodexAgentTurnContext = {
  threadId: "thread",
  turnId: "turn",
  rootThreadId: "thread",
  actorProjectId: null,
  libraryId: "library",
  storeEpoch: "epoch",
  admittedAtMs: 1,
};
const invocation = (
  name: AppToolInvocation["name"],
  args: Record<string, unknown>,
  isActive = () => true,
): AppToolInvocation => ({
  name,
  arguments: args,
  caller: {
    threadId: "thread",
    turnId: "turn",
    callId: name,
    hostId: "local",
    generation: 1,
    isActive,
  },
});

it.effect("SQL and schema use the current Profile with explicit content bindings", () =>
  Effect.gen(function* () {
    const scope = { bindings: [{ table: "tasks", data_source_id: "source-in-project-b" }] };
    for (const actorProjectId of [null, "project-a"]) {
      const reads: Array<{ read: QueryRead; projectId: string | null }> = [];
      const captured = { ...authority, actorProjectId };
      const execute = yield* makeWithCapture(() => Effect.succeed(captured)).pipe(
        Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
        Effect.provideService(CoreModules, {
          query: {
            read: (read: QueryRead, projectId: string | null) => {
              reads.push({ read, projectId });
              return Effect.succeed({
                value: {
                  value:
                    read.kind === "agent_schema"
                      ? { tables: [{ table: "tasks", data_source_id: "source-in-project-b" }] }
                      : { rows: [{ page_id: "page-in-project-b" }] },
                },
              });
            },
          },
        } as never),
      );
      const query = { scope, sql: "SELECT page_id FROM tasks LIMIT 1" };
      for (const input of [
        invocation("query_content", query),
        invocation("describe_content_schema", { scope, relation: "tasks" }),
      ]) {
        const result = yield* execute(input);
        assert.isFalse(result.isError ?? false);
        assert.deepEqual(result.structuredContent, {
          profileId: "profile",
          ...(input.name === "describe_content_schema"
            ? { tables: [{ table: "tasks", data_source_id: "source-in-project-b" }] }
            : { rows: [{ page_id: "page-in-project-b" }] }),
        });
      }
      const provenance = {
        profile_id: "profile",
        authority: {
          thread_id: "thread",
          turn_id: "turn",
          root_thread_id: "thread",
          actor_project_id: actorProjectId,
          library_id: "library",
          store_epoch: "epoch",
        },
      };
      assert.deepEqual(reads, [
        { projectId: null, read: { kind: "agent_query", provenance, query } },
        { projectId: null, read: { kind: "agent_schema", provenance, scope, relation: "tasks" } },
      ]);
    }
  }),
);

it.effect("withdrawn query calls cannot enter Core or return a stale result", () =>
  Effect.gen(function* () {
    let active = true;
    let reads = 0;
    const execute = yield* makeWithCapture(() => Effect.succeed(authority)).pipe(
      Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
      Effect.provideService(CoreModules, {
        query: {
          read: () =>
            Effect.sync(() => {
              reads += 1;
              active = false;
              return { value: { value: { rows: [{ page_id: "stale" }] } } };
            }),
        },
      } as never),
    );
    assert.deepEqual(
      (yield* execute(invocation("query_content", { scope: {} }))).structuredContent,
      { error: { code: "invalid_arguments" } },
    );
    assert.equal(reads, 0);
    const input = invocation(
      "query_content",
      { scope: {}, sql: "SELECT page_id FROM pages LIMIT 1" },
      () => active,
    );
    assert.deepEqual((yield* execute(input)).structuredContent, {
      error: { code: "call_withdrawn" },
    });
    assert.deepEqual((yield* execute(input)).structuredContent, {
      error: { code: "call_withdrawn" },
    });
    assert.equal(reads, 1);
  }),
);
