import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { forkParked } from "../serverActivation.ts";

// Bound each reclaim pass to one minute of churn.
const RECLAIM_PAGES_PER_PASS = 1024;
const SLICE_NANOS = 25_000_000n;
const FOREGROUND_SHARE = 9;

/**
 * Keeps the execution store's size proportional to its current history. Both lanes wait for
 * startup recovery, write in short slices, and resume after the process stops when quiet.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;

    // Keeps maintenance at 10% duty on the writer, including pages that exceed the budget.
    const makeDutyCycle = Effect.gen(function* () {
      let sliceStarted = yield* Clock.monotonicTimeNanos;
      return Effect.gen(function* () {
        const elapsed = (yield* Clock.monotonicTimeNanos) - sliceStarted;
        if (elapsed < SLICE_NANOS) return;
        yield* Effect.sleep((Number(elapsed) / 1_000_000) * FOREGROUND_SHARE);
        sliceStarted = yield* Clock.monotonicTimeNanos;
      });
    });

    const prune = Effect.gen(function* () {
      const result = yield* maintenance.pruneEventStore(yield* makeDutyCycle);
      if (result.deletedEventCount > 0) yield* Effect.logInfo("Pruned execution events", result);
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Execution event pruning failed", { cause })),
    );

    const reclaim = Effect.gen(function* () {
      const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      const pages = Math.min(free[0]?.freelist_count ?? 0, RECLAIM_PAGES_PER_PASS);
      const rest = yield* makeDutyCycle;
      // The driver steps once per statement and incremental_vacuum frees one page per step.
      for (let page = 0; page < pages; page++) {
        yield* sql`PRAGMA incremental_vacuum(1)`;
        yield* Effect.yieldNow;
        yield* rest;
      }
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Database space reclamation failed", { cause })),
    );

    yield* forkParked(
      Effect.sleep("1 minute").pipe(
        Effect.andThen(prune.pipe(Effect.repeat(Schedule.spaced("1 hour")))),
      ),
    );
    // Only VACUUM changes this mode, and that happens before this layer is built.
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    if (mode[0]?.auto_vacuum === 2)
      yield* forkParked(
        Effect.sleep("1 minute").pipe(
          Effect.andThen(reclaim.pipe(Effect.repeat(Schedule.spaced("1 minute")))),
        ),
      );
  }),
);
