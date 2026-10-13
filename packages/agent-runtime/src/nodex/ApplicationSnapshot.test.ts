// @effect-diagnostics nodeBuiltinImport:off
import { DatabaseSync } from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Application from "./Application.ts";
import type { AgentStorageSnapshot } from "./Interface.ts";
import { AgentRuntime } from "./Service.ts";

it.live(
  "snapshots accepted execution data and fails closed on active, queued, and unknown work",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-public-snapshot-" });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const request = (method: string, input: unknown = {}) =>
            runtime.handle({ id: method, method, input });
          yield* request("project.upsert", {
            id: "project:snapshot",
            title: "Snapshot",
            workspaceRoot: home,
          });
          yield* request("command.dispatch", {
            type: "thread.create",
            commandId: "command:snapshot",
            threadId: "thread:snapshot",
            projectId: "project:snapshot",
            title: "Snapshot",
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: home,
            createdBy: "user",
            creationSource: "web",
          });
          yield* runtime.handle({
            id: "project-update",
            method: "project.upsert",
            input: {
              id: "project:snapshot",
              title: "Updated",
              workspaceRoot: home,
            },
          });
          const snapshot = (yield* request("storage.snapshot.acquire")) as AgentStorageSnapshot;
          expect(snapshot.runtimeId).toBe(runtime.identity.runtimeId);
          expect(snapshot.runtimeGeneration).toBe(runtime.identity.runtimeGeneration);
          expect(snapshot.sequence).toBeGreaterThan(0);
          expect(yield* fs.exists(snapshot.attachmentsPath)).toBe(true);
          expect((yield* fs.readFileString(snapshot.environmentIdPath)).trim()).toBe(
            snapshot.runtimeId,
          );
          yield* Effect.sync(() => {
            const copied = new DatabaseSync(snapshot.databasePath, { readOnly: true });
            try {
              expect(copied.prepare("PRAGMA integrity_check").get()).toEqual({
                integrity_check: "ok",
              });
              expect(
                copied.prepare("SELECT COUNT(*) AS count FROM projection_projects").get(),
              ).toEqual({ count: 1 });
              expect(
                copied
                  .prepare(
                    "SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE application_event_version=2",
                  )
                  .get(),
              ).toEqual({ sequence: snapshot.sequence });
            } finally {
              copied.close();
            }
          });
          expect(
            (yield* request("project.upsert", {
              id: "project:denied",
              title: "Denied",
              workspaceRoot: home,
            }).pipe(Effect.flip)).message,
          ).toContain("holding execution writes");
          expect(
            (yield* request("providers.read", { refresh: true }).pipe(Effect.flip)).message,
          ).toContain("holding execution writes");
          yield* request("storage.snapshot.release", { leaseId: snapshot.leaseId });
          expect(yield* fs.exists(snapshot.databasePath)).toBe(false);
          const database = yield* Effect.acquireRelease(
            Effect.sync(() => new DatabaseSync(runtime.identity.databasePath)),
            (value) => Effect.sync(() => value.close()),
          );
          // Storage-state fixtures deliberately exercise fail-closed handling without decoding bodies.
          for (const status of [
            "preparing",
            "starting",
            "running",
            "waiting",
            "queued",
            "unknown_state",
          ]) {
            yield* Effect.sync(() =>
              database
                .prepare(`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES ('run:snapshot', 'thread:snapshot', 1, 'codex', ?, '2026-10-14T00:00:00Z', '{}')`)
                .run(status),
            );
            expect(
              (yield* request("storage.snapshot.acquire").pipe(Effect.flip)).message,
            ).toContain("active or queued work");
            yield* Effect.sync(() =>
              database.exec(
                "DELETE FROM orchestration_v2_projection_runs WHERE run_id='run:snapshot'",
              ),
            );
          }
          yield* Effect.sync(() =>
            database.exec(`INSERT INTO orchestration_v2_effect_outbox
        (effect_id,command_id,thread_id,effect_type,payload_json,status,available_at,created_at,updated_at)
        VALUES ('effect:snapshot','command:snapshot','thread:snapshot','prepare', '{}', 'pending',
          '2100-01-01T00:00:00Z','2026-10-14T00:00:00Z','2026-10-14T00:00:00Z')`),
          );
          expect((yield* request("storage.snapshot.acquire").pipe(Effect.flip)).message).toContain(
            "active or queued work",
          );
          yield* Effect.sync(() =>
            database.exec(
              "DELETE FROM orchestration_v2_effect_outbox WHERE effect_id='effect:snapshot'",
            ),
          );
          const retried = (yield* request("storage.snapshot.acquire")) as AgentStorageSnapshot;
          yield* request("storage.snapshot.release", { leaseId: retried.leaseId });
        }).pipe(
          Effect.provide(Application.layer({ home, cwd: home, providers: {} }, () => Effect.void)),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
