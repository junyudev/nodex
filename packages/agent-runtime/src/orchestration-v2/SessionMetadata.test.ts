import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { readSessionMetadata } from "./SessionMetadata.ts";

it.effect(
  "projects provenance, explicit settlement, snooze wake rules and canonical title-generation metadata",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const payload = {
        createdBy: "agent",
        creationSource: "mcp",
        modelSelection: { model: "model" },
        lineage: { rootThreadId: "thread", parentThreadId: "parent", relationshipToParent: "fork" },
        worktreePath: "/isolated/worktree",
        titleRegeneration: { requestId: "title:request", startedAt: "2026-10-01T00:00:00Z" },
        settledOverride: "settled",
        settledAt: "2026-10-01T00:00:00Z",
        snoozedAt: "2026-10-01T00:00:00Z",
        snoozedUntil: "2099-01-01T00:00:00Z",
        pullRequests: [
          {
            host: "github.com",
            repository: "org/repo",
            number: 3,
            url: "https://github.com/org/repo/pull/3",
            source: "linked",
            snapshot: { state: "open" },
          },
        ],
      };
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({ thread_id: "thread", project_id: "project", title: "Title", default_provider: "codex", provider_instance_id: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-01", updated_at: "2026-10-02", payload_json: JSON.stringify(payload) })}`;
      const read = () =>
        readSessionMetadata(["thread"], {
          providerDriver: () => Effect.succeed("claudeAgent"),
        }).pipe(Effect.map((rows) => rows[0]!));
      const first = yield* read();
      assert.equal(first.createdBy, "agent");
      assert.equal(first.creationSource, "mcp");
      assert.equal(first.providerDriver, "claudeAgent");
      assert.equal(first.itemCount, 0);
      assert.equal(first.itemCountCoverage, "local");
      assert.equal(first.settled, true);
      assert.equal(first.snoozed, true);
      assert.equal(first.worktreePath, "/isolated/worktree");
      assert.equal(first.titleRegeneration?.requestId, "title:request");
      assert.equal(first.pullRequests[0]?.number, 3);
      assert.equal(first.parentThreadId, "parent");
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json)
 VALUES('run','thread',1,'codex','running','2026-10-02',NULL,'{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
 VALUES('held','thread',2,'codex','queued','2026-10-03','{"queueHeld":true}')`;
      const held = yield* read();
      assert.equal(held.activeRunId, "run");
      assert.equal(held.latestRunId, "run");
      assert.equal(held.runStatus, "running");
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed',completed_at='2026-10-02' WHERE run_id='run'`;
      const completed = yield* read();
      assert.equal(completed.snoozed, false);
      assert.equal(completed.activeRunId, null);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
