import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { DatabaseSync } from "node:sqlite";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";

const day = 24 * 60 * 60 * 1000;
const effectRow = (input: {
  readonly id: string;
  readonly status: "succeeded" | "cancelled" | "failed";
  readonly completedAt: string;
}) => [
  input.id,
  `command:${input.id}`,
  "thread:retained",
  "terminal.cleanup",
  JSON.stringify({ type: "terminal.cleanup" }),
  input.status,
  input.completedAt,
  input.completedAt,
  input.completedAt,
  input.completedAt,
];

it.live("prunes settled outbox receipts after recovery in the production composition", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-runtime-prune-" });
    const cwd = path.join(home, "workspace");
    yield* fs.makeDirectory(cwd);
    const configuration = { home, cwd, providers: {} };
    const databasePath = yield* Effect.scoped(
      AgentRuntime.useSync((runtime) => runtime.identity.databasePath).pipe(
        Effect.provide(Application.layer(configuration, () => Effect.void)),
      ),
    );

    const now = Date.now();
    const database = new DatabaseSync(databasePath);
    try {
      const insert = database.prepare(`INSERT INTO orchestration_v2_effect_outbox(
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        available_at, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const old = new Date(now - 8 * day).toISOString();
      insert.run(...effectRow({ id: "old-succeeded", status: "succeeded", completedAt: old }));
      insert.run(...effectRow({ id: "old-cancelled", status: "cancelled", completedAt: old }));
      insert.run(...effectRow({ id: "old-failed", status: "failed", completedAt: old }));
      insert.run(
        ...effectRow({
          id: "recent-succeeded",
          status: "succeeded",
          completedAt: new Date(now - day).toISOString(),
        }),
      );
    } finally {
      database.close();
    }

    const remaining = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* AgentRuntime;
        return yield* Effect.sync(() => {
          const reader = new DatabaseSync(databasePath, { readOnly: true });
          try {
            return reader
              .prepare("SELECT effect_id FROM orchestration_v2_effect_outbox ORDER BY effect_id")
              .all()
              .map((row) => row.effect_id);
          } finally {
            reader.close();
          }
        }).pipe(
          Effect.repeat({
            until: (ids) => !ids.includes("old-succeeded"),
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
      }).pipe(Effect.provide(Application.layer(configuration, () => Effect.void))),
    );

    // Failed receipts protect retry decisions; recent receipts still deduplicate replays.
    expect(remaining).toEqual(["old-failed", "recent-succeeded"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("deletes a shared attachment only after its last live Session is deleted", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-runtime-cleanup-" });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const request = (method: string, input: unknown) =>
          runtime.handle({
            id: `${method}:${JSON.stringify(input).length}:${Math.random()}`,
            method,
            input,
          });
        yield* request("project.upsert", {
          id: "project:cleanup",
          title: "Cleanup",
          workspaceRoot: home,
        });
        yield* request("command.dispatch", {
          type: "thread.create",
          commandId: "create:source",
          threadId: "thread:source",
          projectId: "project:cleanup",
          title: "Source",
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const persisted = (yield* request("attachments.persist", {
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
        })) as { readonly attachments: ReadonlyArray<{ readonly id: string }> };
        expect(yield* request("thread.fork-source", { threadId: "thread:source" })).toBeNull();
        const image = persisted.attachments[0]!;
        const file = path.join(home, "userdata", "attachments", `${image.id}.png`);
        yield* request("command.dispatch", {
          type: "message.dispatch",
          commandId: "send:source",
          threadId: "thread:source",
          messageId: "message:source",
          text: "Look at this",
          attachments: persisted.attachments,
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        const outcome = (yield* request("run.outcome", {
          threadId: "thread:source",
          messageId: "message:source",
        }).pipe(
          Effect.repeat({
            until: (value) =>
              value !== null &&
              !["preparing", "queued", "starting", "running"].includes(
                (value as { readonly status: string }).status,
              ),
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        )) as { readonly runId: string };
        expect(yield* request("thread.fork-source", { threadId: "thread:source" })).toBe(
          outcome.runId,
        );
        yield* request("command.dispatch", {
          type: "thread.fork",
          commandId: "fork:source",
          sourceThreadId: "thread:source",
          targetThreadId: "thread:fork",
          sourcePoint: { type: "run", runId: outcome.runId },
          rootPolicy: "independent_root",
          createdBy: "user",
          creationSource: "web",
        });
        expect(
          yield* request("thread.fork-source", {
            threadId: "thread:fork",
            runId: outcome.runId,
          }),
        ).toBeNull();
        const cleanupSettled = (commandId: string) =>
          Effect.sync(() => {
            const reader = new DatabaseSync(runtime.identity.databasePath, { readOnly: true });
            try {
              return reader
                .prepare("SELECT status FROM orchestration_v2_effect_outbox WHERE effect_id = ?")
                .get(`effect:${commandId}:attachment.cleanup`)?.status;
            } finally {
              reader.close();
            }
          }).pipe(
            Effect.repeat({
              until: (status) => status === "succeeded",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("10 seconds"),
          );

        expect(yield* fs.exists(file)).toBe(true);
        yield* request("command.dispatch", {
          type: "thread.delete",
          commandId: "delete:source",
          threadId: "thread:source",
        });
        yield* cleanupSettled("delete:source");
        // The fork still shows the captured message, so the shared file survives.
        expect(yield* fs.exists(file)).toBe(true);

        yield* request("command.dispatch", {
          type: "thread.delete",
          commandId: "delete:fork",
          threadId: "thread:fork",
        });
        yield* cleanupSettled("delete:fork");
        expect(yield* fs.exists(file)).toBe(false);
      }).pipe(
        Effect.provide(
          Application.layer(
            {
              home,
              cwd: home,
              // An unavailable native binary fails the Run after its user message is recorded.
              providers: {
                codex: {
                  driver: "codex",
                  config: {
                    binaryPath: path.join(home, "missing-codex"),
                    homePath: path.join(home, "codex"),
                  },
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

it.live("reads durable accepted and rejected command receipts after runtime restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-runtime-admission-" });
    const configuration = { home, cwd: home, providers: {} };
    const use = (verify: boolean) =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const request = (method: string, input: unknown) =>
            runtime.handle({ id: `${method}:${JSON.stringify(input)}`, method, input });
          if (!verify) {
            yield* request("project.upsert", {
              id: "project:one",
              title: "Test",
              workspaceRoot: home,
            });
            yield* request("command.dispatch", {
              type: "thread.create",
              commandId: "create:one",
              threadId: "thread:one",
              projectId: "project:one",
              title: "Test",
              modelSelection: { instanceId: "codex", model: "test" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            });
            const rejected = yield* request("command.dispatch", {
              type: "thread.archive",
              commandId: "reject:one",
              threadId: "thread:missing",
            }).pipe(Effect.result);
            expect(rejected._tag).toBe("Failure");
            return;
          }
          const accepted = yield* request("command.receipt", {
            commandId: "create:one",
            threadId: "thread:one",
          });
          expect(accepted).toMatchObject({ status: "accepted", error: null });
          const rejected = yield* request("command.receipt", {
            commandId: "reject:one",
            threadId: "thread:missing",
          });
          expect(rejected).toMatchObject({ status: "rejected" });
          expect(
            yield* request("command.receipt", { commandId: "never-sent", threadId: "thread:one" }),
          ).toBeNull();
          const mismatch = yield* request("command.receipt", {
            commandId: "create:one",
            threadId: "thread:other",
          }).pipe(Effect.result);
          expect(mismatch._tag).toBe("Failure");
        }).pipe(Effect.provide(Application.layer(configuration, () => Effect.void))),
      );
    yield* use(false);
    yield* use(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);
