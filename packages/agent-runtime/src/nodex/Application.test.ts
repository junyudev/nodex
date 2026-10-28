import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentRuntimeNotification,
  AgentSnapshot,
  AgentTurnItem,
  AgentWire,
  AgentItemContentSlice,
  AgentTimelinePage,
  AgentThreadProgress,
} from "./Interface.ts";
import type { PersistChatAttachmentsResult } from "@t3tools/contracts";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentShellSnapshot } from "./Interface.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";

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
          yield* runtime.handle({
            id: "project-activity",
            method: "project.activity",
            input: { projectId: "project:test" },
          }),
        ).toMatchObject({ run: null, runtimeRequest: null, nativeBackground: null });
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
              command: {
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
          const control = (yield* runtime.handle({
            id: "controls",
            method: "thread.control",
            input: { threadId: "thread:content", runId: "run:absent" },
          })) as AgentSnapshot;
          expect(control.projection.thread.id).toBe("thread:content");
          expect(control.projection.turnItems).toHaveLength(0);
          expect(control.projection.visibleTurnItems).toHaveLength(0);
          expect(control.projection.messages).toHaveLength(0);
          expect(control.hasMoreHistory).toBe(false);
          expect(JSON.stringify(control).length).toBeLessThan(4096);
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
          const timeline = (yield* runtime.handle({
            id: "timeline",
            method: "thread.timeline",
            input: {
              threadId: "thread:content",
              view: "activity",
              order: "newest_first",
              limit: 1,
            },
          })) as AgentTimelinePage;
          expect(timeline.items[0]?.item).toEqual({
            id: target.itemId,
            runId: null,
            type: "command_execution",
            status: "completed",
            updatedAt: full.updatedAt,
          });
          expect(JSON.stringify(timeline).length).toBeLessThan(4096);
          const content = (yield* runtime.handle({
            id: "item-content",
            method: "thread.item.content",
            input: { ...target, format: "text", maxChars: 64 },
          })) as AgentItemContentSlice;
          expect(content).toMatchObject({
            itemId: target.itemId,
            sourceThreadId: target.threadId,
            format: "text",
            text: `$ inspect\n${output.slice(0, 54)}`,
            textOffset: 0,
            totalChars: output.length + "$ inspect\n".length,
            nextTextOffset: 64,
          });
          const tail = (yield* runtime.handle({
            id: "item-content-tail",
            method: "thread.item.content",
            input: { ...target, format: "text", textOffset: content.totalChars - 8, maxChars: 64 },
          })) as AgentItemContentSlice;
          expect(tail.text).toBe("xxxxxxxx");
          expect(tail.nextTextOffset).toBeNull();
          const json = (yield* runtime.handle({
            id: "item-content-json",
            method: "thread.item.content",
            input: { ...target, format: "json", maxChars: 64 },
          })) as AgentItemContentSlice;
          expect(json.totalChars).toBe(JSON.stringify(full).length);
          expect(json.text).toBe(JSON.stringify(full).slice(0, 64));
          const progress = (yield* runtime.handle({
            id: "progress",
            method: "thread.progress",
            input: { threadId: target.threadId },
          })) as AgentThreadProgress;
          expect(progress).toMatchObject({
            latestReply: null,
            latestActivity: {
              itemId: target.itemId,
              type: "command_execution",
              status: "completed",
            },
          });
          expect(JSON.stringify(progress).length).toBeLessThan(1024);
          const unicode = "A😀B\n".repeat(4);
          const oversizedOutput = "x".repeat(16 * 1024 * 1024);
          yield* Effect.sync(() => {
            const database = new DatabaseSync(runtime.identity.databasePath);
            try {
              const insert = database.prepare(`INSERT INTO orchestration_v2_projection_turn_items
                (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
                 type, status, ordinal, updated_at, payload_json) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`);
              for (const item of [
                {
                  ...full,
                  id: "item:unicode",
                  ordinal: 2,
                  type: "assistant_message",
                  messageId: "message:unicode",
                  text: unicode,
                  streaming: false,
                },
                { ...full, id: "item:oversized", ordinal: 3, output: oversizedOutput },
              ])
                insert.run(
                  item.id,
                  item.threadId,
                  item.type,
                  item.status,
                  item.ordinal,
                  item.updatedAt,
                  JSON.stringify(item),
                );
            } finally {
              database.close();
            }
          });
          const chunks: string[] = [];
          const versions = new Set<string>();
          let offset = 0;
          for (;;) {
            const part = (yield* runtime.handle({
              id: `unicode:${offset}`,
              method: "thread.item.content",
              input: {
                threadId: target.threadId,
                itemId: "item:unicode",
                format: "text",
                textOffset: offset,
                maxChars: 2,
              },
            })) as AgentItemContentSlice;
            // Exercise the same JSON framing used by the socket, including split surrogate pairs.
            chunks.push(JSON.parse(JSON.stringify(part)).text);
            versions.add(part.contentVersion);
            if (part.nextTextOffset === null) break;
            offset = part.nextTextOffset;
          }
          expect(chunks.join("")).toBe(unicode);
          expect(versions.size).toBe(1);
          yield* Effect.sync(() => {
            const database = new DatabaseSync(runtime.identity.databasePath);
            try {
              database
                .prepare(
                  "UPDATE orchestration_v2_projection_turn_items SET payload_json = json_set(payload_json, '$.text', ?) WHERE turn_item_id = 'item:unicode'",
                )
                .run(`${unicode}changed`);
            } finally {
              database.close();
            }
          });
          const changedContent = (yield* runtime.handle({
            id: "unicode-changed",
            method: "thread.item.content",
            input: {
              threadId: target.threadId,
              itemId: "item:unicode",
              format: "text",
              maxChars: 0,
            },
          })) as AgentItemContentSlice;
          expect(versions.has(changedContent.contentVersion)).toBe(false);
          const oversizedTarget = { threadId: target.threadId, itemId: "item:oversized" };
          expect(
            (yield* runtime
              .handle({ id: "oversized-full", method: "thread.item.full", input: oversizedTarget })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          const oversizedTail = (yield* runtime.handle({
            id: "oversized-tail",
            method: "thread.item.content",
            input: {
              ...oversizedTarget,
              format: "text",
              textOffset: "$ inspect\n".length + oversizedOutput.length - 8,
              maxChars: 64,
            },
          })) as AgentItemContentSlice;
          expect(oversizedTail.text).toBe("xxxxxxxx");
          expect(oversizedTail.nextTextOffset).toBeNull();
          expect(oversizedTail.totalChars).toBe("$ inspect\n".length + oversizedOutput.length);
          const latest = (yield* runtime.handle({
            id: "latest-progress",
            method: "thread.progress",
            input: { threadId: target.threadId },
          })) as AgentThreadProgress;
          expect(latest.latestReply?.text).toBe(`${unicode}changed`);
          expect(latest.latestActivity?.itemId).toBe("item:oversized");
          expect(JSON.stringify(latest).length).toBeLessThan(2048);
          yield* Effect.sync(() => {
            const database = new DatabaseSync(runtime.identity.databasePath);
            const now = new Date().toISOString();
            try {
              const session = {
                id: "native:idle-content",
                driver: "codex",
                providerInstanceId: "codex",
                status: "ready",
                cwd: home,
                model: "gpt-5.4",
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              };
              database
                .prepare(`INSERT INTO orchestration_v2_projection_provider_sessions
                (provider_session_id,thread_id,provider,driver,provider_instance_id,status,model,updated_at,payload_json)
                VALUES (?,?,'codex','codex','codex','ready',?,?,?)`)
                .run(session.id, "thread:content", session.model, now, JSON.stringify(session));
              database
                .prepare(`INSERT INTO orchestration_v2_projection_provider_session_bindings
                (provider_session_id,thread_id) VALUES (?,?)`)
                .run(session.id, "thread:content");
            } finally {
              database.close();
            }
          });
          expect(
            yield* runtime.handle({
              id: "close-idle-project",
              method: "project.close",
              input: { projectId: "project:content" },
            }),
          ).toEqual({ closedBindings: 1 });
          yield* Effect.sync(() => {
            const database = new DatabaseSync(runtime.identity.databasePath);
            try {
              expect(
                database
                  .prepare(
                    "SELECT status FROM orchestration_v2_effect_outbox WHERE effect_type='provider-session.detach'",
                  )
                  .all(),
              ).toEqual([{ status: "succeeded" }]);
              expect(
                database
                  .prepare(
                    "SELECT COUNT(*) AS count FROM orchestration_v2_projection_provider_session_bindings",
                  )
                  .get(),
              ).toEqual({ count: 0 });
            } finally {
              database.close();
            }
          });
          expect(
            (yield* runtime.handle({
              id: "full-after-close",
              method: "thread.item.full",
              input: target,
            })) as AgentTurnItem,
          ).toMatchObject({ id: target.itemId, type: "command_execution", output });
          expect(
            yield* runtime.handle({
              id: "close-idle-project-again",
              method: "project.close",
              input: { projectId: "project:content" },
            }),
          ).toEqual({ closedBindings: 0 });
          yield* runtime.handle({
            id: "delete",
            method: "command.dispatch",
            input: {
              command: {
                type: "thread.delete",
                commandId: "command:delete-content",
                threadId: "thread:content",
              },
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

it.live(
  "semantic message admission preserves the original caller's provenance across retries",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-send-provenance-" });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const call = (method: string, input: unknown) =>
            runtime.handle({ id: method, method, input });
          yield* call("project.upsert", {
            id: "project:provenance",
            title: "Provenance",
            workspaceRoot: home,
          });
          for (const createdBy of ["user", "agent"] as const) {
            const threadId = `thread:provenance:${createdBy}`;
            yield* call("command.dispatch", {
              command: {
                type: "thread.create",
                commandId: `create:${threadId}`,
                threadId,
                projectId: "project:provenance",
                title: "Side chat",
                modelSelection: { instanceId: "codex", model: "gpt-5.4" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdBy: "user",
                creationSource: "web",
              },
            });
            const send = {
              threadId,
              commandId: `send:${threadId}`,
              messageId: `message:${threadId}`,
              text: `Original ${createdBy} request`,
              attachments: [],
              mode: "auto",
              createdBy,
            };
            yield* call("thread.send", send);
            yield* call("thread.send", { ...send, createdBy: "user", text: "Changed retry text" });
            expect(yield* call("thread.opening-request", { threadId })).toMatchObject({
              id: send.messageId,
              text: send.text,
              createdBy,
              creationSource: createdBy === "agent" ? "mcp" : "web",
            });
          }
        }).pipe(
          Effect.provide(
            Application.layer(
              {
                home,
                cwd: home,
                providers: {
                  codex: {
                    driver: "codex",
                    config: { binaryPath: "/missing-codex", homePath: home },
                  },
                },
              },
              () => Effect.void,
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("enforces Host mode limits on the shared dispatch and send boundaries", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-mode-limit-" });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const call = (method: string, input: unknown) =>
          runtime.handle({ id: method, method, input });
        const limit = { runtimeMode: "full-access", interactionMode: "plan" };
        yield* call("project.upsert", { id: "project:limit", title: "Plan", workspaceRoot: home });
        const create = {
          type: "thread.create",
          commandId: "create:limit",
          threadId: "thread:limit",
          projectId: "project:limit",
          title: "Plan",
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: home,
          createdBy: "agent",
          creationSource: "mcp",
        };
        const refused = yield* call("command.dispatch", { command: create, modeLimit: limit }).pipe(
          Effect.result,
        );
        expect(refused).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "OrchestratorThreadAboveModeLimitError",
            reason: "interaction_mode_escalation_denied",
          },
        });
        yield* call("command.dispatch", {
          command: { ...create, interactionMode: "plan" },
          modeLimit: limit,
        });
        // A plain legacy command is no longer a valid transport request.
        expect((yield* call("command.dispatch", create).pipe(Effect.result))._tag).toBe("Failure");
        yield* call("command.dispatch", {
          command: {
            type: "thread.interaction-mode.set",
            commandId: "mode:limit",
            threadId: "thread:limit",
            interactionMode: "default",
          },
        });
        const send = {
          threadId: "thread:limit",
          commandId: "send:limit",
          messageId: "message:limit",
          text: "Continue",
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          modeLimit: limit,
        };
        expect(yield* call("thread.send", send).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "OrchestratorThreadAboveModeLimitError",
            reason: "interaction_mode_escalation_denied",
          },
        });
        expect(
          yield* call("thread.send", {
            ...send,
            modeLimit: { runtimeMode: "approval-required", interactionMode: "default" },
          }).pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "OrchestratorThreadAboveModeLimitError",
            reason: "runtime_mode_escalation_denied",
          },
        });
        const snapshot = (yield* call("thread.snapshot", {
          threadId: "thread:limit",
        })) as AgentSnapshot;
        expect(snapshot.projection.runs).toHaveLength(0);
        expect(snapshot.projection.messages).toHaveLength(0);
      }).pipe(
        Effect.provide(
          Application.layer(
            {
              home,
              cwd: home,
              providers: {
                codex: {
                  driver: "codex",
                  config: { binaryPath: "/missing-codex", homePath: home },
                },
              },
            },
            () => Effect.void,
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
