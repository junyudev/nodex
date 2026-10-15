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
