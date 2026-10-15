import type { components } from "@nodex/core-protocol";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type {
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceReadSnapshot,
} from "../core-client/types";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexConversationContext } from "./CodexConversationContext";
import { make } from "./CodexTurnAuthority";

type Authority = components["schemas"]["ProjectWorkspaceTurnAuthority"];
type Admit = Extract<
  ProjectWorkspaceApplyInput["intent"],
  { readonly kind: "admit_turn_authority" }
>;

const harness = () => {
  const persisted = new Map<string, { authority: Authority }>();
  const writes: Array<{ intent: Admit; projectId: string | null | undefined }> = [];
  const identity = { profileId: "profile", libraryId: "library", storeEpoch: "epoch" };
  const workspace: CoreModules["Service"]["workspace"] = {
    read: (read, _options, projectId) =>
      Effect.sync(() => {
        if (read.kind !== "turn_authority")
          throw new Error("Projectless authority must not look up a Project");
        assert.strictEqual(projectId, null);
        const row = persisted.get(`${read.thread_id}:${read.turn_id}`);
        return {
          value: {
            kind: "turn_authority",
            resolution: {
              authority: row?.authority ?? null,
              persisted: row !== undefined,
              admitted_at_ms: row ? 1_788_825_600_000 : null,
            },
          },
        } as ProjectWorkspaceReadSnapshot;
      }),
    apply: (input, _options, projectId) =>
      Effect.sync(() => {
        if (input.intent.kind !== "admit_turn_authority")
          throw new Error("Unexpected authority mutation");
        const intent = input.intent;
        writes.push({ intent, projectId });
        persisted.set(`${intent.thread_id}:${intent.turn_id}`, {
          authority: {
            thread_id: intent.thread_id,
            turn_id: intent.turn_id,
            root_thread_id: intent.root_thread_id,
            actor_project_id: intent.actor_project_id,
            library_id: identity.libraryId,
            store_epoch: identity.storeEpoch,
          },
        });
        return {} as never;
      }),
  };
  const build = make.pipe(
    Effect.provideService(CoreModules, { workspace } as never),
    Effect.provideService(CoreAuthority, { identity } as never),
    Effect.provideService(CodexConversationContext, {
      read: (threadId) =>
        Effect.succeed({
          threadId,
          projectId: null,
          parentThreadId: null,
          rootThreadId: threadId,
          cwd: null,
          writableRoots: [],
        }),
    }),
  );
  return { build, writes };
};

it.effect(
  "binds and recaptures projectless execution identity without looking up or borrowing a Project",
  () =>
    Effect.gen(function* () {
      const fixture = harness();
      const authority = yield* fixture.build;
      assert.isNull(yield* authority.capture("thread:root", "unrecorded"));
      assert.deepEqual(fixture.writes, []);

      const launch = yield* authority.begin("thread:root");
      assert.isNotNull(launch);
      const frozen = yield* authority.capture("thread:root", "turn:root");
      assert.strictEqual(frozen?.actorProjectId, null);
      assert.strictEqual(fixture.writes.length, 1);
      assert.strictEqual(fixture.writes[0]?.projectId, null);
      assert.strictEqual(fixture.writes[0]?.intent.actor_project_id, null);
      assert.strictEqual(launch?.boundTurnId, "turn:root");

      const nextLaunch = yield* authority.begin("thread:root");
      assert.deepEqual(yield* authority.capture("thread:root", "turn:root"), frozen);
      assert.strictEqual(nextLaunch?.boundTurnId, null);
      assert.strictEqual(fixture.writes.length, 1);
      yield* authority.observeStarted("thread:root", "turn:next");
      assert.strictEqual(nextLaunch?.boundTurnId, "turn:next");
      assert.strictEqual(
        (yield* authority.capture("thread:root", "turn:root"))?.turnId,
        "turn:root",
      );
      assert.strictEqual(fixture.writes.length, 2);

      const recreated = yield* fixture.build;
      assert.deepEqual(yield* recreated.capture("thread:root", "turn:root"), frozen);
      assert.strictEqual(fixture.writes.length, 2);
    }),
);
