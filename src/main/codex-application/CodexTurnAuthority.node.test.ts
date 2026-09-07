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
type Freeze = Extract<
  ProjectWorkspaceApplyInput["intent"],
  { readonly kind: "freeze_turn_authority" }
>;

const harness = () => {
  const persisted = new Map<string, { authority: Authority; readOnly: boolean }>();
  const writes: Array<{ intent: Freeze; projectId: string | null | undefined }> = [];
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
              read_only: row?.readOnly ?? true,
              frozen_at_ms: row ? 1_788_825_600_000 : null,
            },
          },
        } as ProjectWorkspaceReadSnapshot;
      }),
    apply: (input, _options, projectId) =>
      Effect.sync(() => {
        if (input.intent.kind !== "freeze_turn_authority")
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
            scope: "library",
            source: intent.source,
          },
          readOnly: intent.read_only,
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
  "freezes and recaptures projectless authority without looking up or borrowing a Project",
  () =>
    Effect.gen(function* () {
      const fixture = harness();
      const authority = yield* fixture.build;
      assert.isNull(yield* authority.begin("thread:root", false, false));
      assert.isNull(yield* authority.capture("thread:root", "unrecorded"));
      assert.deepEqual(fixture.writes, []);

      const launch = yield* authority.begin("thread:root", true, false);
      assert.isNotNull(launch);
      const frozen = yield* authority.capture("thread:root", "turn:root");
      assert.strictEqual(frozen?.actorProjectId, null);
      assert.strictEqual(frozen?.scope, "library");
      assert.isFalse(frozen?.readOnly);
      assert.strictEqual(fixture.writes.length, 1);
      assert.strictEqual(fixture.writes[0]?.projectId, null);
      assert.strictEqual(fixture.writes[0]?.intent.actor_project_id, null);
      assert.strictEqual(fixture.writes[0]?.intent.source, "builtin_full_access");
      assert.strictEqual(launch?.boundTurnId, "turn:root");

      const recreated = yield* fixture.build;
      assert.deepEqual(yield* recreated.capture("thread:root", "turn:root"), frozen);
      assert.strictEqual(fixture.writes.length, 1);
      if (!frozen) throw new Error("Expected frozen authority");
      yield* recreated.inherit("thread:child", "turn:child", { ...frozen, readOnly: true });
      assert.deepEqual(fixture.writes[1]?.intent.inherited_from, {
        thread_id: "thread:root",
        turn_id: "turn:root",
      });
      assert.strictEqual(fixture.writes[1]?.intent.actor_project_id, null);
      assert.strictEqual(fixture.writes[1]?.intent.root_thread_id, "thread:root");
      assert.strictEqual(fixture.writes[1]?.intent.source, "inherited_builtin_full_access");
      assert.isTrue(fixture.writes[1]?.intent.read_only);
    }),
);
