import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import { DatabaseSync } from "node:sqlite";
import type { AgentRuntimeNotification, AgentTurnItem, AgentWire } from "./Interface.ts";
import type { PersistChatAttachmentsResult } from "@t3tools/contracts";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentShellSnapshot } from "./Interface.ts";

it.live("reopens the same execution identity and persisted project after shutdown", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-agent-runtime-" });
    const cwd = path.join(home, "workspace");
    yield* fs.makeDirectory(cwd);
    const configuration = { home, cwd, providers: {} };

    const firstIdentity = yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        yield* runtime.handle({
          id: "project-registration",
          method: "project.upsert",
          input: { id: "project:test", title: "Workspace", workspaceRoot: cwd },
        });
        return runtime.identity;
      }).pipe(Effect.provide(Application.layer(configuration, () => Effect.void))),
    );

    const second = yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const shell = yield* runtime.handle({ id: "read", method: "shell.read", input: {} });
        const project = yield* runtime.handle({
          id: "project-read",
          method: "project.read",
          input: { projectId: "project:test" },
        });
        expect(
          yield* runtime.handle({ id: "catalog", method: "providers.read", input: {} }),
        ).toEqual([]);
        expect(
          yield* runtime.handle({
            id: "missing-thread",
            method: "thread.read",
            input: { threadId: "thread:absent" },
          }),
        ).toBeNull();
        const watched = yield* runtime.handle({ id: "watch", method: "events.observe", input: {} });
        expect(watched).toMatchObject({ subscribed: true, subscriptionId: "watch" });
        yield* runtime.handle({
          id: "unwatch",
          method: "events.unobserve",
          input: { subscriptionId: "watch" },
        });
        return { identity: runtime.identity, shell: shell as AgentShellSnapshot, project };
      }).pipe(Effect.provide(Application.layer(configuration, () => Effect.void))),
    );

    expect(second.identity.runtimeId).toBe(firstIdentity.runtimeId);
    expect(second.identity.runtimeGeneration).not.toBe(firstIdentity.runtimeGeneration);
    expect(second.identity.databasePath).toBe(firstIdentity.databasePath);
    expect(second.project).toEqual({ id: "project:test", title: "Workspace", workspaceRoot: cwd });
    expect(second.shell.threads).toHaveLength(0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "keeps observation metadata bounded and retains full assets and explicitly requested output",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-agent-runtime-content-" });
      const lifecycle =
        yield* Deferred.make<Extract<AgentRuntimeNotification, { type: "execution.lifecycle" }>>();
      const filtered = yield* Deferred.make<Extract<AgentRuntimeNotification, { type: "event" }>>();
      const notifications: AgentRuntimeNotification[] = [];
      const notify = (notification: AgentRuntimeNotification) =>
        Effect.gen(function* () {
          notifications.push(notification);
          if (notification.type === "execution.lifecycle")
            yield* Deferred.succeed(lifecycle, notification);
          if (notification.type === "event") yield* Deferred.succeed(filtered, notification);
        });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          yield* runtime.handle({
            id: "project",
            method: "project.upsert",
            input: { id: "project:content", title: "Workspace", workspaceRoot: home },
          });
          yield* runtime.handle({ id: "lifecycle", method: "execution.observe", input: {} });
          yield* runtime.handle({
            id: "filtered",
            method: "events.observe",
            input: { eventTypes: ["thread.deleted"] },
          });
          yield* runtime.handle({
            id: "create",
            method: "command.dispatch",
            input: {
              type: "thread.create",
              commandId: "command:content",
              threadId: "thread:content",
              projectId: "project:content",
              title: "Content",
              modelSelection: { instanceId: "codex", model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            },
          });
          const upload = {
            threadId: "thread:content",
            messageId: "message:content",
            attachments: [
              {
                type: "image",
                name: "capture.png",
                mimeType: "image/png",
                sizeBytes: 3,
                dataUrl: "data:image/png;base64,AQID",
                source: {
                  kind: "snap-shot",
                  capturedAt: "2026-10-14T00:00:00.000Z",
                  appName: "Workspace",
                  windowTitle: "Content",
                },
              },
            ],
          };
          const first = (yield* runtime.handle({
            id: "upload",
            method: "attachments.persist",
            input: upload,
          })) as AgentWire<PersistChatAttachmentsResult>;
          const retry = yield* runtime.handle({
            id: "upload-retry",
            method: "attachments.persist",
            input: upload,
          });
          expect(retry).toEqual(first);
          expect(first.attachments[0]).toMatchObject({ source: upload.attachments[0]!.source });
          const changed = (yield* runtime.handle({
            id: "upload-changed",
            method: "attachments.persist",
            input: {
              ...upload,
              attachments: [{ ...upload.attachments[0]!, dataUrl: "data:image/png;base64,BAUG" }],
            },
          })) as AgentWire<PersistChatAttachmentsResult>;
          expect(changed.attachments[0]?.id).not.toBe(first.attachments[0]?.id);
          const originalBytes = yield* fs.readFile(
            path.join(home, "userdata", "attachments", `${first.attachments[0]!.id}.png`),
          );
          expect(Array.from(originalBytes)).toEqual([1, 2, 3]);
          const invalid = yield* runtime
            .handle({
              id: "upload-invalid",
              method: "attachments.persist",
              input: { ...upload, attachments: [{ ...upload.attachments[0]!, sizeBytes: 4 }] },
            })
            .pipe(Effect.result);
          expect(invalid._tag).toBe("Failure");

          // Pressure fixture: the public Thread exists; only output scale is inserted directly.
          const output = "x".repeat(2 * 1024 * 1024);
          yield* Effect.sync(() => {
            const sql = new DatabaseSync(runtime.identity.databasePath);
            try {
              const now = "2026-10-14T00:00:00.000Z";
              const payload = {
                id: "item:large-output",
                threadId: "thread:content",
                runId: null,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "completed",
                title: "Output",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "command_execution",
                input: "inspect",
                output,
              };
              sql
                .prepare(`INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
             type, status, ordinal, updated_at, payload_json) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`)
                .run(
                  payload.id,
                  payload.threadId,
                  payload.type,
                  payload.status,
                  payload.ordinal,
                  now,
                  JSON.stringify(payload),
                );
            } finally {
              sql.close();
            }
          });
          const target = { threadId: "thread:content", itemId: "item:large-output" };
          const detail = (yield* runtime.handle({
            id: "detail",
            method: "thread.item",
            input: target,
          })) as AgentTurnItem;
          const full = (yield* runtime.handle({
            id: "full",
            method: "thread.item.full",
            input: target,
          })) as AgentTurnItem;
          expect(detail.type).toBe("command_execution");
          expect(full.type).toBe("command_execution");
          if (detail.type === "command_execution" && full.type === "command_execution") {
            expect(detail.output!.length).toBeLessThan(output.length);
            expect(full.output).toBe(output);
          }
          yield* runtime.handle({
            id: "delete",
            method: "command.dispatch",
            input: {
              type: "thread.delete",
              commandId: "command:delete-content",
              threadId: "thread:content",
            },
          });
          const end = yield* Deferred.await(lifecycle);
          expect(end).toEqual({
            type: "execution.lifecycle",
            subscriptionId: "lifecycle",
            runtimeGeneration: runtime.identity.runtimeGeneration,
            sequence: end.sequence,
            threadId: "thread:content",
            eventType: "thread.deleted",
          });
          expect((yield* Deferred.await(filtered)).event.event.type).toBe("thread.deleted");
          expect(
            notifications.filter((notification) => notification.type === "event"),
          ).toHaveLength(1);
        }).pipe(Effect.provide(Application.layer({ home, cwd: home, providers: {} }, notify))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
