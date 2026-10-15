import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { DatabaseSync } from "node:sqlite";
import type { PersistChatAttachmentsResult } from "@t3tools/contracts";
import type { AgentWire } from "./Interface.ts";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";

it.live("resolves only a visible image's exact item and captured fork prefix across Projects", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-image-query-" });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        for (const name of ["source", "fork", "foreign"]) {
          const workspaceRoot = path.join(home, name);
          yield* fs.makeDirectory(workspaceRoot);
          yield* runtime.handle({
            id: `project:${name}`,
            method: "project.upsert",
            input: { id: `project:${name}`, title: name, workspaceRoot },
          });
          yield* runtime.handle({
            id: `thread:${name}`,
            method: "command.dispatch",
            input: {
              type: "thread.create",
              commandId: `create:${name}`,
              threadId: `thread:${name}`,
              projectId: `project:${name}`,
              title: name,
              modelSelection: { instanceId: "codex", model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            },
          });
        }
        const persisted = yield* runtime.handle({
          id: "image",
          method: "attachments.persist",
          input: {
            threadId: "thread:source",
            messageId: "message:source",
            attachments: [
              {
                type: "image",
                name: "capture.png",
                mimeType: "image/png",
                sizeBytes: 3,
                dataUrl: "data:image/png;base64,AQID",
              },
            ],
          },
        });
        const image = (persisted as AgentWire<PersistChatAttachmentsResult>).attachments[0]!;
        // Storage boundary: controlled fork-cutoff and post-fork records exercise the real indexed read.
        yield* Effect.sync(() => {
          const db = new DatabaseSync(runtime.identity.databasePath);
          try {
            const now = "2026-10-14T00:00:00.000Z";
            for (const ordinal of [1, 2])
              db.prepare(
                `INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES (?, 'thread:source', ?, 'codex', 'completed', ?, '{}')`,
              ).run(`run:${ordinal}`, ordinal, now);
            db.prepare(
              `UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.forkedFrom', json(?)) WHERE thread_id = 'thread:fork'`,
            ).run(JSON.stringify({ type: "run", threadId: "thread:source", runId: "run:1" }));
            for (const [id, runId, type] of [
              ["item:captured", "run:1", "user_message"],
              ["item:late", "run:2", "assistant_message"],
              ["item:text", "run:1", "assistant_message"],
            ] as const) {
              const payload = {
                id,
                threadId: "thread:source",
                runId,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                nativeExecutionToken: null,
                parentItemId: null,
                ordinal: 1,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type,
                messageId: id,
                text: "Message",
                ...(type === "user_message"
                  ? { inputIntent: "turn_start", createdBy: "user", creationSource: "web" }
                  : { streaming: false }),
                attachments: id === "item:text" ? [] : [image],
              };
              db.prepare(
                `INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES (?, 'thread:source', ?, 1, ?, 'completed', ?, ?)`,
              ).run(id, runId, type, now, JSON.stringify(payload));
            }
          } finally {
            db.close();
          }
        });
        const query = (
          threadId: string,
          itemId: string,
          attachmentId = image.id,
          sourceThreadId = "thread:source",
        ) =>
          runtime.handle({
            id: `image:${threadId}:${itemId}`,
            method: "thread.attachment",
            input: { threadId, sourceThreadId, itemId, attachmentId },
          });
        const expected = { path: path.join(home, "userdata", "attachments", `${image.id}.png`) };
        expect(yield* query("thread:source", "item:captured")).toEqual(expected);
        expect(yield* query("thread:source", "item:late")).toEqual(expected);
        expect(yield* query("thread:fork", "item:captured")).toEqual(expected);
        expect(yield* query("thread:fork", "item:late")).toBeNull();
        expect(yield* query("thread:foreign", "item:captured")).toBeNull();
        expect(yield* query("thread:source", "item:text")).toBeNull();
        expect(yield* query("thread:fork", "item:captured", "other-image")).toBeNull();
        expect(
          (yield* query("thread:fork", "item:captured", "../../private").pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* fs.remove(expected.path);
        expect(yield* query("thread:source", "item:captured")).toBeNull();
      }).pipe(
        Effect.provide(Application.layer({ home, cwd: home, providers: {} }, () => Effect.void)),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
