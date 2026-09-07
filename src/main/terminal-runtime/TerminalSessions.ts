import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  TerminalAttachRequest,
  TerminalAttachedEvent,
  TerminalCreateRequest,
  TerminalDataEvent,
  TerminalErrorEvent,
  TerminalExitEvent,
  TerminalInitLogEvent,
  TerminalRunActionRequest,
  TerminalSessionSnapshot,
  TerminalSize,
  TerminalTakeOverViewRequest,
  TerminalViewLeaseResult,
  TerminalViewLeaseRevokedEvent,
} from "../../shared/types";
import { TerminalEnvironment } from "../platform/node/TerminalEnvironment";
import { TerminalProcessMetricsReader } from "../platform/node/TerminalProcessMetrics";
import {
  TerminalRuntimeMap,
  type TerminalRuntime,
  type TerminalRuntimeConfig,
} from "./TerminalRuntimeMap";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";

export interface TerminalOwner {
  readonly webContentsId: number;
  readonly windowSessionId: string;
}

interface TerminalLease extends TerminalOwner {
  readonly generation: number;
  readonly size: TerminalSize;
}

interface TerminalSessionRecord {
  readonly access: Semaphore.Semaphore;
  readonly generation: number;
  readonly config: TerminalRuntimeConfig;
  readonly runtime: TerminalRuntime["Service"] | null;
  readonly terminalSnapshot: TerminalSessionSnapshot | null;
  readonly lease: TerminalLease | null;
  readonly leaseGeneration: number;
}

export type TerminalSessionEvent =
  | {
      readonly channel: "terminal-data";
      readonly target: { readonly kind: "web-contents"; readonly webContentsId: number };
      readonly payload: TerminalDataEvent;
    }
  | {
      readonly channel: "terminal-init-log";
      readonly target: { readonly kind: "web-contents"; readonly webContentsId: number };
      readonly payload: TerminalInitLogEvent;
    }
  | {
      readonly channel: "terminal-attached";
      readonly target: { readonly kind: "web-contents"; readonly webContentsId: number };
      readonly payload: TerminalAttachedEvent;
    }
  | {
      readonly channel: "terminal-view-lease-revoked";
      readonly target: { readonly kind: "web-contents"; readonly webContentsId: number };
      readonly payload: TerminalViewLeaseRevokedEvent;
    }
  | {
      readonly channel: "terminal-error";
      readonly target: { readonly kind: "web-contents"; readonly webContentsId: number };
      readonly payload: TerminalErrorEvent;
    }
  | {
      readonly channel: "terminal-exit";
      readonly target: { readonly kind: "broadcast" };
      readonly payload: TerminalExitEvent;
    };

export class TerminalSessionError extends Schema.TaggedError<TerminalSessionError>()(
  "TerminalSessionError",
  {
    operation: Schema.String,
    sessionId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class TerminalSessions extends Context.Service<
  TerminalSessions,
  {
    readonly events: Stream.Stream<TerminalSessionEvent>;
    readonly create: (
      owner: TerminalOwner,
      request: TerminalCreateRequest,
    ) => Effect.Effect<TerminalViewLeaseResult, TerminalSessionError>;
    readonly acquireViewLease: (
      owner: TerminalOwner,
      request: TerminalAttachRequest,
    ) => Effect.Effect<TerminalViewLeaseResult, TerminalSessionError>;
    readonly takeOverViewLease: (
      owner: TerminalOwner,
      request: TerminalTakeOverViewRequest,
    ) => Effect.Effect<TerminalViewLeaseResult, TerminalSessionError>;
    readonly releaseViewLease: (owner: TerminalOwner, sessionId: string) => Effect.Effect<void>;
    readonly releaseLeasesForWebContents: (webContentsId: number) => Effect.Effect<void>;
    readonly write: (
      owner: TerminalOwner,
      sessionId: string,
      data: string,
    ) => Effect.Effect<void, TerminalSessionError>;
    readonly resize: (
      owner: TerminalOwner,
      sessionId: string,
      size: TerminalSize,
    ) => Effect.Effect<void, TerminalSessionError>;
    readonly runAction: (
      owner: TerminalOwner,
      request: TerminalRunActionRequest,
    ) => Effect.Effect<void, TerminalSessionError>;
    readonly getSessionSnapshot: (
      sessionId: string,
    ) => Effect.Effect<TerminalSessionSnapshot | null>;
    readonly getThreadSnapshot: (threadId: string) => Effect.Effect<TerminalSessionSnapshot | null>;
    readonly listSnapshotsForOwners: (input: {
      readonly conversationIds: ReadonlySet<string>;
      readonly projectSessionIds: ReadonlySet<string>;
    }) => Effect.Effect<readonly TerminalSessionSnapshot[]>;
    readonly listLiveSessionsForOwners: (input: {
      readonly conversationIds: ReadonlySet<string>;
      readonly projectSessionIds: ReadonlySet<string>;
    }) => Effect.Effect<readonly TerminalSessionSnapshot[]>;
    readonly discardExitedSessionsForOwners: (input: {
      readonly conversationIds: ReadonlySet<string>;
      readonly projectSessionIds: ReadonlySet<string>;
    }) => Effect.Effect<readonly string[]>;
    readonly refreshSessionProcessMetrics: (sessionIds: readonly string[]) => Effect.Effect<void>;
    readonly killSession: (sessionId: string) => Effect.Effect<void>;
  }
>()("nodex/main/terminal-runtime/TerminalSessions") {}

const sessionError = (operation: string, sessionId: string, cause: unknown) =>
  new TerminalSessionError({ operation, sessionId, cause });

const normalizeSize = (size: TerminalSize | null | undefined): TerminalSize => ({
  cols: Math.max(2, Math.floor(size?.cols ?? 80)),
  rows: Math.max(1, Math.floor(size?.rows ?? 24)),
});

const withNewline = (command: string): string =>
  command.endsWith("\n") || command.endsWith("\r") ? command : `${command}\r`;

const isOwner = (lease: TerminalLease | null, owner: TerminalOwner): boolean =>
  lease?.webContentsId === owner.webContentsId && lease.windowSessionId === owner.windowSessionId;

const overlayLease = (
  snapshot: TerminalSessionSnapshot,
  lease: TerminalLease | null,
): TerminalSessionSnapshot => ({
  ...snapshot,
  viewLease:
    lease === null
      ? null
      : {
          windowSessionId: lease.windowSessionId,
          generation: lease.generation,
          size: lease.size,
        },
});

export const live: Layer.Layer<
  TerminalSessions,
  never,
  TerminalEnvironment | TerminalProcessMetricsReader | TerminalRuntimeMap
> = Layer.effect(
  TerminalSessions,
  Effect.gen(function* () {
    const environment = yield* TerminalEnvironment;
    const metrics = yield* TerminalProcessMetricsReader;
    const runtimes = yield* TerminalRuntimeMap;
    const records = yield* Ref.make<ReadonlyMap<string, TerminalSessionRecord>>(new Map());
    const events = yield* PubSub.sliding<TerminalSessionEvent>(MAIN_OBSERVATION_EVENT_CAPACITY);
    const watchers = yield* FiberSet.make<void, never>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));

    const publish = (event: TerminalSessionEvent) =>
      PubSub.publish(events, event).pipe(Effect.asVoid);

    const readSnapshot = Effect.fn("TerminalSessions.readSnapshot")(function* (
      record: TerminalSessionRecord,
    ) {
      const snapshot =
        record.runtime === null
          ? record.terminalSnapshot
          : yield* SubscriptionRef.get(record.runtime.snapshot);
      return snapshot === null ? null : overlayLease(snapshot, record.lease);
    });

    const getRecord = (sessionId: string) =>
      Ref.get(records).pipe(Effect.map((current) => current.get(sessionId) ?? null));

    const replaceRecord = (
      sessionId: string,
      expected: TerminalSessionRecord,
      update: (record: TerminalSessionRecord) => TerminalSessionRecord,
    ) =>
      Ref.update(records, (current) => {
        if (current.get(sessionId) !== expected) return current;
        const next = new Map(current);
        next.set(sessionId, update(expected));
        return next;
      });

    const handleRuntimeEvent = Effect.fn("TerminalSessions.handleRuntimeEvent")(function* (
      sessionId: string,
      generation: number,
      event: import("./TerminalRuntimeMap").TerminalRuntimeEvent,
    ) {
      const current = yield* getRecord(sessionId);
      if (current === null || current.generation !== generation) return;
      if (event.kind === "data") {
        if (current.lease === null) return;
        yield* publish({
          channel: "terminal-data",
          target: { kind: "web-contents", webContentsId: current.lease.webContentsId },
          payload: { sessionId, data: event.data },
        });
        return;
      }

      const runtimeSnapshot =
        current.runtime === null ? null : yield* SubscriptionRef.get(current.runtime.snapshot);
      if (runtimeSnapshot === null) return;
      const exitedRecord: TerminalSessionRecord = {
        ...current,
        runtime: null,
        terminalSnapshot: { ...runtimeSnapshot, viewLease: null },
        lease: null,
      };
      yield* replaceRecord(sessionId, current, () => exitedRecord);
      yield* publish({
        channel: "terminal-exit",
        target: { kind: "broadcast" },
        payload: { sessionId, exitCode: event.exit.exitCode, reason: "exited" },
      });
      yield* runtimes.close(sessionId);
    });

    const watchRuntime = (
      sessionId: string,
      generation: number,
      runtime: TerminalRuntime["Service"],
    ) =>
      FiberSet.run(
        watchers,
        runtime.events.pipe(
          Stream.runForEach((event) => handleRuntimeEvent(sessionId, generation, event)),
        ),
      ).pipe(Effect.asVoid);

    const makeRecord = Effect.fn("TerminalSessions.makeRecord")(function* (
      config: TerminalRuntimeConfig,
      generation: number,
      runtime: TerminalRuntime["Service"],
    ) {
      const access = yield* Semaphore.make(1);
      return {
        access,
        generation,
        config,
        runtime,
        terminalSnapshot: null,
        lease: null,
        leaseGeneration: 0,
      } satisfies TerminalSessionRecord;
    });

    const ensureRecord = Effect.fn("TerminalSessions.ensureRecord")(function* (
      request: TerminalCreateRequest | TerminalAttachRequest,
    ) {
      const existing = yield* getRecord(request.sessionId);
      if (existing !== null) return existing;
      const config = yield* environment.resolve({
        ...request,
        size: request.size,
        title: "title" in request ? request.title : null,
      });
      const runtime = yield* runtimes
        .open(config)
        .pipe(Effect.mapError((cause) => sessionError("spawn", request.sessionId, cause)));
      const candidate = yield* makeRecord(config, 1, runtime);
      const selected = yield* Ref.modify(records, (current) => {
        const raced = current.get(request.sessionId);
        if (raced !== undefined) return [raced, current] as const;
        const next = new Map(current);
        next.set(request.sessionId, candidate);
        return [candidate, next] as const;
      });
      if (selected !== candidate) return selected;
      yield* watchRuntime(request.sessionId, candidate.generation, runtime);
      return candidate;
    });

    const publishAttached = Effect.fn("TerminalSessions.publishAttached")(function* (
      owner: TerminalOwner,
      record: TerminalSessionRecord,
      forceInit: boolean,
    ) {
      const snapshot = yield* readSnapshot(record);
      if (snapshot === null) return;
      if (forceInit || snapshot.buffer.length > 0) {
        yield* publish({
          channel: "terminal-init-log",
          target: { kind: "web-contents", webContentsId: owner.webContentsId },
          payload: { sessionId: snapshot.sessionId, data: snapshot.buffer, snapshot },
        });
      }
      yield* publish({
        channel: "terminal-attached",
        target: { kind: "web-contents", webContentsId: owner.webContentsId },
        payload: { sessionId: snapshot.sessionId, snapshot },
      });
    });

    const acquireLocked = Effect.fn("TerminalSessions.acquireLocked")(function* (
      owner: TerminalOwner,
      request: TerminalAttachRequest,
      forceInit: boolean,
    ) {
      const current = yield* getRecord(request.sessionId);
      if (current === null) return { status: "not_found" } as const;
      const snapshotBefore = yield* readSnapshot(current);
      if (snapshotBefore === null) return { status: "not_found" } as const;
      if (current.lease !== null && !isOwner(current.lease, owner)) {
        return {
          status: "conflict",
          generation: current.lease.generation,
          ownerWindowSessionId: current.lease.windowSessionId,
          snapshot: snapshotBefore,
        } as const;
      }
      const size = normalizeSize(request.size);
      const nextGeneration = current.lease?.generation ?? current.leaseGeneration + 1;
      const nextLease: TerminalLease = { ...owner, generation: nextGeneration, size };
      if (current.runtime !== null) {
        yield* current.runtime.updateSnapshot((snapshot) => ({
          ...snapshot,
          conversationId: request.conversationId ?? snapshot.conversationId,
          projectSessionId: request.projectSessionId ?? snapshot.projectSessionId,
        }));
        yield* current.runtime
          .resize(size)
          .pipe(Effect.mapError((cause) => sessionError("resize", request.sessionId, cause)));
      }
      const nextRecord: TerminalSessionRecord = {
        ...current,
        config: {
          ...current.config,
          conversationId: request.conversationId ?? current.config.conversationId,
          projectSessionId: request.projectSessionId ?? current.config.projectSessionId,
        },
        lease: nextLease,
        leaseGeneration: Math.max(current.leaseGeneration, nextGeneration),
      };
      yield* replaceRecord(request.sessionId, current, () => nextRecord);
      yield* publishAttached(owner, nextRecord, forceInit);
      const snapshot = yield* readSnapshot(nextRecord);
      if (snapshot === null) return { status: "not_found" } as const;
      return {
        status: current.lease === null ? "acquired" : "already_owned",
        generation: nextGeneration,
        snapshot,
      } as const;
    });

    const acquireExisting = Effect.fn("TerminalSessions.acquireExisting")(function* (
      owner: TerminalOwner,
      request: TerminalAttachRequest,
      record: TerminalSessionRecord,
      forceInit: boolean,
    ) {
      return yield* record.access.withPermits(1)(acquireLocked(owner, request, forceInit));
    });

    const acquireViewLease = Effect.fn("TerminalSessions.acquireViewLease")(function* (
      owner: TerminalOwner,
      request: TerminalAttachRequest,
    ) {
      const record = yield* ensureRecord(request);
      return yield* acquireExisting(owner, request, record, record.lease === null);
    });

    const requireOwnedRecord = Effect.fn("TerminalSessions.requireOwnedRecord")(function* (
      owner: TerminalOwner,
      sessionId: string,
    ) {
      const record = yield* getRecord(sessionId);
      if (record === null) return yield* sessionError("lookup", sessionId, new Error("not found"));
      if (!isOwner(record.lease, owner)) {
        return yield* sessionError(
          "lease",
          sessionId,
          new Error("Terminal is active in another window"),
        );
      }
      if (record.runtime === null) {
        return yield* sessionError("closed", sessionId, new Error("Terminal is not running"));
      }
      return record;
    });

    const killSession = Effect.fn("TerminalSessions.killSession")(function* (sessionId: string) {
      const record = yield* getRecord(sessionId);
      if (record === null) return;
      yield* record.access.withPermits(1)(
        Ref.update(records, (current) => {
          if (current.get(sessionId) !== record) return current;
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        }).pipe(
          Effect.andThen(runtimes.close(sessionId)),
          Effect.andThen(
            publish({
              channel: "terminal-exit",
              target: { kind: "broadcast" },
              payload: { sessionId, exitCode: null, reason: "killed" },
            }),
          ),
        ),
      );
    });

    const listSnapshotsForOwners = (
      input: {
        readonly conversationIds: ReadonlySet<string>;
        readonly projectSessionIds: ReadonlySet<string>;
      },
      liveOnly = false,
    ) =>
      Ref.get(records).pipe(
        Effect.andThen((current) =>
          Effect.all(
            [...current.values()]
              .filter(
                (record) =>
                  (!liveOnly || record.runtime !== null) &&
                  ((record.config.conversationId !== null &&
                    input.conversationIds.has(record.config.conversationId)) ||
                    (record.config.projectSessionId !== null &&
                      input.projectSessionIds.has(record.config.projectSessionId))),
              )
              .map(readSnapshot),
          ),
        ),
        Effect.map((snapshots) => snapshots.filter((snapshot) => snapshot !== null)),
      );
    return TerminalSessions.of({
      listSnapshotsForOwners,
      events: Stream.fromPubSub(events),
      create: (owner, request) => {
        if (request.backendKind === "remote") {
          return Effect.succeed({ status: "not_found" } as const);
        }
        return acquireViewLease(owner, request);
      },
      acquireViewLease,
      takeOverViewLease: (owner, request) =>
        Effect.gen(function* () {
          const record = yield* getRecord(request.sessionId);
          if (record === null) return { status: "not_found" } as const;
          if (record.lease === null || isOwner(record.lease, owner)) {
            return yield* acquireExisting(owner, request, record, false);
          }
          return yield* record.access.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* getRecord(request.sessionId);
              if (current === null) return { status: "not_found" } as const;
              if (current.lease === null || isOwner(current.lease, owner)) {
                return yield* acquireLocked(owner, request, false);
              }
              const snapshot = yield* readSnapshot(current);
              if (snapshot === null) return { status: "not_found" } as const;
              if (current.lease.generation !== request.expectedGeneration) {
                return {
                  status: "stale",
                  generation: current.lease.generation,
                  ownerWindowSessionId: current.lease.windowSessionId,
                  snapshot,
                } as const;
              }
              const nextGeneration = current.leaseGeneration + 1;
              const nextLease: TerminalLease = {
                ...owner,
                generation: nextGeneration,
                size: normalizeSize(request.size),
              };
              if (current.runtime !== null) {
                yield* current.runtime
                  .resize(nextLease.size)
                  .pipe(
                    Effect.mapError((cause) => sessionError("resize", request.sessionId, cause)),
                  );
              }
              const nextRecord = {
                ...current,
                lease: nextLease,
                leaseGeneration: nextGeneration,
              } satisfies TerminalSessionRecord;
              yield* replaceRecord(request.sessionId, current, () => nextRecord);
              yield* publish({
                channel: "terminal-view-lease-revoked",
                target: {
                  kind: "web-contents",
                  webContentsId: current.lease.webContentsId,
                },
                payload: {
                  sessionId: request.sessionId,
                  generation: nextGeneration,
                  ownerWindowSessionId: owner.windowSessionId,
                },
              });
              yield* publishAttached(owner, nextRecord, false);
              const nextSnapshot = yield* readSnapshot(nextRecord);
              if (nextSnapshot === null) return { status: "not_found" } as const;
              return {
                status: "acquired",
                generation: nextGeneration,
                snapshot: nextSnapshot,
              } as const;
            }),
          );
        }),
      releaseViewLease: (owner, sessionId) =>
        Effect.gen(function* () {
          const record = yield* getRecord(sessionId);
          if (record === null) return;
          yield* record.access.withPermits(1)(
            replaceRecord(sessionId, record, (current) =>
              isOwner(current.lease, owner) ? { ...current, lease: null } : current,
            ),
          );
        }),
      releaseLeasesForWebContents: (webContentsId) =>
        Ref.update(records, (current) => {
          let changed = false;
          const next = new Map(current);
          for (const [sessionId, record] of current) {
            if (record.lease?.webContentsId !== webContentsId) continue;
            changed = true;
            next.set(sessionId, { ...record, lease: null });
          }
          return changed ? next : current;
        }),
      write: (owner, sessionId, data) =>
        Effect.gen(function* () {
          const record = yield* getRecord(sessionId);
          if (record === null)
            return yield* sessionError("lookup", sessionId, new Error("not found"));
          yield* record.access.withPermits(1)(
            requireOwnedRecord(owner, sessionId).pipe(
              Effect.andThen((owned) => owned.runtime!.write(data)),
              Effect.mapError((cause) =>
                cause instanceof TerminalSessionError
                  ? cause
                  : sessionError("write", sessionId, cause),
              ),
            ),
          );
        }),
      resize: (owner, sessionId, size) =>
        Effect.gen(function* () {
          const record = yield* getRecord(sessionId);
          if (record === null) return;
          yield* record.access.withPermits(1)(
            Effect.gen(function* () {
              const owned = yield* requireOwnedRecord(owner, sessionId);
              const normalized = normalizeSize(size);
              if (
                owned.lease?.size.cols === normalized.cols &&
                owned.lease.size.rows === normalized.rows
              ) {
                return;
              }
              yield* owned
                .runtime!.resize(normalized)
                .pipe(Effect.mapError((cause) => sessionError("resize", sessionId, cause)));
              yield* replaceRecord(sessionId, owned, (current) => ({
                ...current,
                lease: current.lease === null ? null : { ...current.lease, size: normalized },
              }));
            }),
          );
        }),
      runAction: (owner, request) =>
        Effect.gen(function* () {
          let record = yield* getRecord(request.sessionId);
          if (record === null) {
            yield* acquireViewLease(owner, {
              ...request,
              size: normalizeSize(request.size),
            });
            record = yield* getRecord(request.sessionId);
          }
          if (record === null) {
            return yield* sessionError("lookup", request.sessionId, new Error("not found"));
          }
          yield* record.access.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* requireOwnedRecord(owner, request.sessionId);
              const size = normalizeSize(request.size ?? current.lease?.size);
              const config = yield* environment.resolve({ ...request, size });
              const previousSnapshot = yield* readSnapshot(current);
              yield* runtimes.close(request.sessionId);
              const runtime = yield* runtimes.open(config).pipe(
                Effect.mapError((cause) => sessionError("spawn", request.sessionId, cause)),
                Effect.onError(() =>
                  previousSnapshot === null
                    ? Effect.void
                    : replaceRecord(request.sessionId, current, (record) => ({
                        ...record,
                        runtime: null,
                        terminalSnapshot: {
                          ...previousSnapshot,
                          osPid: null,
                          exited: true,
                          exitCode: null,
                          viewLease: null,
                        },
                        lease: null,
                      })),
                ),
              );
              const nextRecord = {
                ...current,
                generation: current.generation + 1,
                config,
                runtime,
                terminalSnapshot: null,
                lease:
                  current.lease === null
                    ? null
                    : { ...current.lease, size, generation: current.lease.generation },
              } satisfies TerminalSessionRecord;
              yield* replaceRecord(request.sessionId, current, () => nextRecord);
              yield* watchRuntime(request.sessionId, nextRecord.generation, runtime);
              yield* publishAttached(owner, nextRecord, true);
              yield* runtime
                .write(withNewline(request.command))
                .pipe(Effect.mapError((cause) => sessionError("write", request.sessionId, cause)));
            }),
          );
        }),
      getSessionSnapshot: (sessionId) =>
        getRecord(sessionId).pipe(
          Effect.andThen((record) =>
            record === null ? Effect.succeed(null) : readSnapshot(record),
          ),
        ),
      getThreadSnapshot: (threadId) =>
        Ref.get(records).pipe(
          Effect.andThen((current) => {
            const record = [...current.values()].find(
              (entry) =>
                entry.config.conversationId === threadId ||
                entry.config.projectSessionId === threadId,
            );
            return record === undefined ? Effect.succeed(null) : readSnapshot(record);
          }),
        ),
      listLiveSessionsForOwners: (input) => listSnapshotsForOwners(input, true),
      discardExitedSessionsForOwners: (input) =>
        Ref.modify(records, (current) => {
          const next = new Map(current);
          const discarded: string[] = [];
          for (const [sessionId, record] of current) {
            if (record.runtime !== null) continue;
            const owned =
              (record.config.conversationId !== null &&
                input.conversationIds.has(record.config.conversationId)) ||
              (record.config.projectSessionId !== null &&
                input.projectSessionIds.has(record.config.projectSessionId));
            if (!owned) continue;
            next.delete(sessionId);
            discarded.push(sessionId);
          }
          return [discarded, next] as const;
        }),
      refreshSessionProcessMetrics: (sessionIds) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(records);
          const selected = [...new Set(sessionIds)]
            .map((sessionId) => current.get(sessionId))
            .filter(
              (record): record is TerminalSessionRecord =>
                record?.runtime !== null && record?.runtime !== undefined,
            );
          const snapshots = yield* Effect.all(
            selected.map((record) =>
              SubscriptionRef.get(record.runtime!.snapshot).pipe(
                Effect.map((snapshot) => [record, snapshot] as const),
              ),
            ),
          );
          const byPid = new Map(
            snapshots.flatMap(([record, snapshot]) =>
              snapshot.osPid === null ? [] : ([[snapshot.osPid, record]] as const),
            ),
          );
          if (byPid.size === 0) return;
          const result = yield* Effect.result(metrics.read([...byPid.keys()]));
          if (result._tag === "Failure") {
            for (const record of byPid.values()) {
              yield* record.runtime!.updateSnapshot((snapshot) => ({
                ...snapshot,
                cpuPercent: null,
                rssKb: null,
                childProcessCount: null,
                processMetricsSampledAtMs: null,
              }));
            }
            return;
          }
          for (const [pid, record] of byPid) {
            const sample = result.success.get(pid);
            yield* record.runtime!.updateSnapshot((snapshot) => ({
              ...snapshot,
              cpuPercent: sample?.cpuPercent ?? null,
              rssKb: sample?.rssKb ?? null,
              childProcessCount: sample?.childProcessCount ?? null,
              processMetricsSampledAtMs: sample?.sampledAtMs ?? null,
            }));
          }
        }),
      killSession,
    });
  }),
);
