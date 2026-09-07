import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  WorkbenchRendererObservation,
  WorkbenchSceneReference,
} from "../../shared/nodex-app-tools/workbench";
import { makeWorkbenchSceneKey } from "../../shared/workbench-scene";
import { WorkbenchAgentBridge, WorkbenchAgentBridgeError } from "./WorkbenchAgentBridge";

/** Internal caller identity. None of these fields are accepted from a tool argument. */
export interface WorkbenchObservationPrincipal {
  readonly profileId: string;
  readonly authorityFingerprint: string;
  readonly hostId: string;
  readonly backendGeneration: number;
}

export interface WorkbenchObservationRecord {
  readonly observationId: string;
  readonly capturedAt: string;
  readonly expiresAt: string;
  readonly reference: WorkbenchSceneReference;
  readonly observation: WorkbenchRendererObservation;
}

export class WorkbenchObservationError extends Schema.TaggedError<WorkbenchObservationError>()(
  "WorkbenchObservationError",
  {
    reason: Schema.Literals([
      "observation_unavailable",
      "scene_unavailable",
      "stale_presentation",
      "result_too_large",
      "closed",
    ]),
  },
) {}

export class WorkbenchObservation extends Context.Service<
  WorkbenchObservation,
  {
    readonly capture: (
      principal: WorkbenchObservationPrincipal,
      reference: WorkbenchSceneReference,
    ) => Effect.Effect<
      WorkbenchObservationRecord,
      WorkbenchObservationError | WorkbenchAgentBridgeError
    >;
    /** Revalidates the exact renderer and revision; never follows the currently selected tab. */
    readonly resolve: (
      principal: WorkbenchObservationPrincipal,
      observationId: string,
    ) => Effect.Effect<
      WorkbenchObservationRecord,
      WorkbenchObservationError | WorkbenchAgentBridgeError
    >;
    /** Commands carry this snapshot's revision to the atomic renderer executor, including exact retries. */
    readonly forCommand: (
      principal: WorkbenchObservationPrincipal,
      observationId: string,
    ) => Effect.Effect<WorkbenchObservationRecord, WorkbenchObservationError>;
  }
>()("nodex/main/app-tools/WorkbenchObservation") {}

interface RetainedObservation {
  readonly principalKey: string;
  readonly expiresAtMs: number;
  readonly bytes: number;
  readonly record: WorkbenchObservationRecord;
}

const principalKey = (principal: WorkbenchObservationPrincipal) =>
  JSON.stringify([
    principal.profileId,
    principal.authorityFingerprint,
    principal.hostId,
    principal.backendGeneration,
  ]);

/** Bounded immutable evidence, not a writable mirror of the renderer's Scene aggregate. */
export const make = (
  options: {
    readonly lifetimeMs?: number;
    readonly maxPerCaller?: number;
    readonly maxRecords?: number;
    readonly maxBytes?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const bridge = yield* WorkbenchAgentBridge;
    const records = new Map<string, RetainedObservation>();
    const lifetimeMs = options.lifetimeMs ?? 60_000;
    const maxPerCaller = options.maxPerCaller ?? 16;
    const maxRecords = options.maxRecords ?? 256;
    const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    let retainedBytes = 0;
    let open = true;
    const remove = (id: string) => {
      const entry = records.get(id);
      if (!entry) return;
      records.delete(id);
      retainedBytes -= entry.bytes;
    };
    const prune = (now: number) => {
      for (const [id, entry] of records) {
        if (entry.expiresAtMs <= now) remove(id);
      }
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        open = false;
        records.clear();
        retainedBytes = 0;
      }),
    );
    return WorkbenchObservation.of({
      forCommand: Effect.fn("WorkbenchObservation.forCommand")(
        function* (principal, observationId) {
          if (!open) return yield* new WorkbenchObservationError({ reason: "closed" });
          const now = yield* DateTime.now;
          prune(DateTime.toEpochMillis(now));
          const entry = records.get(observationId);
          if (!entry || entry.principalKey !== principalKey(principal))
            return yield* new WorkbenchObservationError({ reason: "observation_unavailable" });
          return structuredClone(entry.record);
        },
      ),
      capture: Effect.fn("WorkbenchObservation.capture")(function* (principal, reference) {
        if (!open) return yield* new WorkbenchObservationError({ reason: "closed" });
        const response = yield* bridge.request(reference, {
          kind: "observe",
          sceneOwner: reference.sceneOwner,
        });
        if (!response.observation)
          return yield* new WorkbenchObservationError({ reason: "scene_unavailable" });
        const now = yield* DateTime.now;
        const nowMs = DateTime.toEpochMillis(now);
        prune(nowMs);
        const record: WorkbenchObservationRecord = structuredClone({
          observationId: randomUUID(),
          capturedAt: DateTime.formatIso(now),
          expiresAt: new Date(nowMs + lifetimeMs).toISOString(),
          reference,
          observation: response.observation,
        });
        const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
        if (bytes > maxBytes)
          return yield* new WorkbenchObservationError({ reason: "result_too_large" });
        const key = principalKey(principal);
        const callerRecords = [...records].filter(([, entry]) => entry.principalKey === key);
        for (const [id] of callerRecords.slice(
          0,
          Math.max(0, callerRecords.length - maxPerCaller + 1),
        ))
          remove(id);
        for (const id of records.keys()) {
          if (records.size < maxRecords && retainedBytes + bytes <= maxBytes) break;
          remove(id);
        }
        records.set(record.observationId, {
          principalKey: key,
          expiresAtMs: nowMs + lifetimeMs,
          bytes,
          record,
        });
        retainedBytes += bytes;
        return structuredClone(record);
      }),
      resolve: Effect.fn("WorkbenchObservation.resolve")(function* (principal, observationId) {
        if (!open) return yield* new WorkbenchObservationError({ reason: "closed" });
        const now = yield* DateTime.now;
        prune(DateTime.toEpochMillis(now));
        const entry = records.get(observationId);
        if (!entry || entry.principalKey !== principalKey(principal))
          return yield* new WorkbenchObservationError({ reason: "observation_unavailable" });
        const response = yield* bridge.request(entry.record.reference, {
          kind: "observe",
          sceneOwner: entry.record.reference.sceneOwner,
        });
        const observed = response.observation;
        if (
          !observed ||
          observed.presentationRevision !== entry.record.observation.presentationRevision ||
          makeWorkbenchSceneKey(observed.sceneOwner) !==
            makeWorkbenchSceneKey(entry.record.reference.sceneOwner)
        ) {
          remove(observationId);
          return yield* new WorkbenchObservationError({ reason: "stale_presentation" });
        }
        // A slow renderer response cannot extend an observation's lifetime.
        const checkedAt = yield* DateTime.now;
        if (entry.expiresAtMs <= DateTime.toEpochMillis(checkedAt)) {
          remove(observationId);
          return yield* new WorkbenchObservationError({ reason: "observation_unavailable" });
        }
        return structuredClone(entry.record);
      }),
    });
  });

export const live = Layer.effect(WorkbenchObservation, make());
