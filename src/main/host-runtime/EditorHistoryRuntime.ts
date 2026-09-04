import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import type { WebContents, WebContentsDidStartNavigationEventParams } from "electron";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { ContentAccessContext } from "../../shared/content-access-context";
import type {
  EditorHistoryReleaseHandoff,
  LibraryModuleApplyRequest,
  LibraryModuleApplyResult,
} from "../../shared/library-module";
import { LibraryModule } from "../library-application/LibraryModule";
import { DatabaseModule } from "../database-application/DatabaseModule";
import { DesktopDocumentSessionRuntime } from "../core-client/desktop-document-sync-bridge";
import type {
  BlockTransferIntent,
  BlockTransferUndoIntent,
  BlockTransferCommandResult,
  BlockTransferUndoCommandResult,
} from "../../shared/block-transfer";
import { blockTransferFailure } from "../../shared/block-transfer-transport";
import { promotionRetentionResources } from "../../shared/block-transfer";
import type {
  DatabaseApplyV2,
  DatabaseApplyResultV2,
  LibraryDatabaseApplyV2,
  LibraryDatabaseApplyResultV2,
} from "../../shared/database-module-v2";

const MAX_PENDING_ACTIONS = 128;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
type Target = Pick<WebContents, "id" | "isDestroyed" | "on" | "removeListener">;

interface Attempt<Result = LibraryModuleApplyResult> {
  readonly fingerprint: string;
  readonly result: Deferred.Deferred<Result>;
}
interface Owner {
  readonly id: string;
  closeOperationId: string | undefined;
  readonly attempts: Map<string, Attempt>;
  readonly databaseAttempts: Map<string, Attempt<DatabaseApplyResultV2>>;
  readonly libraryDatabaseAttempts: Map<string, Attempt<LibraryDatabaseApplyResultV2>>;
  readonly transferAttempts: Map<string, Attempt<BlockTransferCommandResult>>;
  readonly reverseTransferAttempts: Map<string, Attempt<BlockTransferUndoCommandResult>>;
  readonly released: Deferred.Deferred<void>;
  closed: boolean;
}
interface Registration {
  owner: Owner | undefined;
  readonly detach: () => void;
}
type Admission<Result = LibraryModuleApplyResult> =
  | { readonly accepted: false; readonly message: string }
  | { readonly accepted: true; readonly result: Deferred.Deferred<Result> };

const failure = (message: string) => ({
  ok: false as const,
  error: { code: "invalid_request" as const, message, retryable: false },
});

/** Main owns in-flight requests and cleanup after a renderer stops awaiting IPC.
 * Each surface still decides Undo order; this owner only retains Core resources.
 */
export class EditorHistoryRuntime extends Context.Service<
  EditorHistoryRuntime,
  {
    readonly transferBlocks: (
      target: Target,
      request: BlockTransferIntent,
    ) => Effect.Effect<BlockTransferCommandResult>;
    readonly reverseBlockTransfer: (
      target: Target,
      request: BlockTransferUndoIntent,
    ) => Effect.Effect<BlockTransferUndoCommandResult>;
    readonly applyDatabase: (
      target: Target,
      request: DatabaseApplyV2,
    ) => Effect.Effect<DatabaseApplyResultV2>;
    readonly applyLibraryDatabase: (
      target: Target,
      request: LibraryDatabaseApplyV2,
    ) => Effect.Effect<LibraryDatabaseApplyResultV2>;
    readonly handoffAbandon: (
      target: Target,
      access: ContentAccessContext,
      request: LibraryModuleApplyRequest,
    ) => Effect.Effect<EditorHistoryReleaseHandoff>;
    readonly handoffAbandonTransfer: (
      target: Target,
      request: BlockTransferIntent,
    ) => Effect.Effect<EditorHistoryReleaseHandoff>;
    readonly handoffRelease: (
      target: Target,
      access: ContentAccessContext,
      request: LibraryModuleApplyRequest,
    ) => Effect.Effect<EditorHistoryReleaseHandoff>;
    readonly apply: (
      target: Target,
      access: ContentAccessContext,
      request: LibraryModuleApplyRequest,
    ) => Effect.Effect<LibraryModuleApplyResult>;
  }
>()("nodex/main/host-runtime/EditorHistoryRuntime") {}

export const live: Layer.Layer<
  EditorHistoryRuntime,
  never,
  LibraryModule | DatabaseModule | DesktopDocumentSessionRuntime
> = Layer.effect(
  EditorHistoryRuntime,
  Effect.gen(function* () {
    const library = yield* LibraryModule;
    const database = yield* DatabaseModule;
    const documents = yield* DesktopDocumentSessionRuntime;
    const callbacks = yield* FiberSet.makeRuntime<never, void, never>();
    const registrations = new Map<number, Registration>();
    const closing = new Set<Owner>();
    let closed = false;
    let pendingCount = 0;
    let pendingBytes = 0;
    let abandonedCount = 0;

    const releaseOwner = (owner: Owner): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!owner.closeOperationId)
          return yield* Effect.die(
            new Error("History cleanup requires an admitted close operation."),
          );
        let delay = 100;
        while (true) {
          const released = yield* library
            .closeEditorHistoryOwner(owner.id, owner.closeOperationId)
            .pipe(
              Effect.map((result) => result ?? "closed"),
              Effect.catch(() => Effect.succeed("retry" as const)),
            );
          if (released === "closed") {
            closing.delete(owner);
            yield* Deferred.succeed(owner.released, undefined);
            return;
          }
          // Closing a fixed lifetime is monotonic and naturally idempotent.
          // Only this cleanup command may renew an authoritatively expired ID;
          // user mutations and uncertain inverses keep their original request.
          if (released === "identity_expired") owner.closeOperationId = createUuidV7();
          yield* Effect.sleep(delay);
          delay = Math.min(delay * 2, 5_000);
        }
      });

    const endOwner = (registration: Registration): void => {
      const owner = registration.owner;
      if (!owner) return;
      registration.owner = undefined;
      owner.closed = true;
      owner.closeOperationId = createUuidV7();
      closing.add(owner);
      callbacks(releaseOwner(owner));
    };

    const ownerFor = (target: Target): Owner | undefined => {
      if (closed || target.isDestroyed() || closing.size >= 128) return undefined;
      let registration = registrations.get(target.id);
      if (!registration) {
        if (registrations.size >= 128) return undefined;
        const ended = () => endOwner(registration!);
        const navigated = (details: WebContentsDidStartNavigationEventParams) => {
          if (details.isMainFrame && !details.isSameDocument) ended();
        };
        const destroyed = () => {
          ended();
          registration!.detach();
          registrations.delete(target.id);
        };
        registration = {
          owner: undefined,
          detach: () => {
            target.removeListener("destroyed", destroyed);
            target.removeListener("render-process-gone", ended);
            target.removeListener("did-start-navigation", navigated);
          },
        };
        registrations.set(target.id, registration);
        target.on("destroyed", destroyed);
        target.on("render-process-gone", ended);
        target.on("did-start-navigation", navigated);
      }
      return (registration.owner ??= {
        id: createUuidV7(),
        closeOperationId: undefined,
        attempts: new Map(),
        databaseAttempts: new Map(),
        libraryDatabaseAttempts: new Map(),
        transferAttempts: new Map(),
        reverseTransferAttempts: new Map(),
        released: Deferred.makeUnsafe<void>(),
        closed: false,
      });
    };

    const execute = (
      owner: Owner,
      access: ContentAccessContext,
      request: LibraryModuleApplyRequest,
    ): Effect.Effect<LibraryModuleApplyResult> =>
      Effect.gen(function* () {
        let delay = 100;
        while (!owner.closed) {
          const result = yield* library.apply(access, request, owner.id).pipe(
            Effect.catch(() =>
              Effect.succeed<LibraryModuleApplyResult>({
                ok: false,
                error: {
                  code: "unknown",
                  message: "The durable history writer is unavailable.",
                  retryable: true,
                },
              }),
            ),
          );
          if (result.ok || result.error.code !== "unknown") return result;
          yield* Effect.sleep(delay);
          delay = Math.min(delay * 2, 5_000);
        }
        return failure("The editor lifetime has ended.");
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true;
        for (const registration of registrations.values()) {
          endOwner(registration);
          registration.detach();
        }
        registrations.clear();
        // The Core's process-liveness reaper is the fallback when Main cannot
        // finish a bounded shutdown. No renderer cancellation signal is reused.
        yield* Effect.forEach([...closing], (owner) => Deferred.await(owner.released), {
          concurrency: 4,
          discard: true,
        }).pipe(
          Effect.interruptible,
          Effect.timeout("5 seconds"),
          Effect.catch(() => Effect.void),
        );
      }),
    );

    const admit = (
      owner: Owner | undefined,
      access: ContentAccessContext,
      request: LibraryModuleApplyRequest,
    ): Effect.Effect<Admission> =>
      Effect.gen(function* () {
        if (!owner || owner.closed)
          return { accepted: false, message: "The editor history owner is unavailable." };
        const fingerprint = JSON.stringify([access, request]);
        const previous = owner.attempts.get(request.operationId);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            return {
              accepted: false,
              message: "A history operation identity cannot change its request.",
            };
          return { accepted: true, result: previous.result };
        }
        const bytes = new TextEncoder().encode(fingerprint).byteLength;
        if (pendingCount >= MAX_PENDING_ACTIONS || pendingBytes + bytes > MAX_PENDING_BYTES) {
          return {
            accepted: false,
            message:
              "Too many editor history actions are pending. Wait for the current actions to finish.",
          };
        }
        const result = yield* Deferred.make<LibraryModuleApplyResult>();
        owner.attempts.set(request.operationId, { fingerprint, result });
        pendingCount++;
        pendingBytes += bytes;
        callbacks(
          execute(owner, access, request).pipe(
            Effect.flatMap((value) => Deferred.succeed(result, value)),
            Effect.asVoid,
            Effect.ensuring(
              Effect.sync(() => {
                owner.attempts.delete(request.operationId);
                pendingCount--;
                pendingBytes -= bytes;
              }),
            ),
          ),
        );
        return { accepted: true, result };
      });
    // Once sent, exact attempts remain process-owned after renderer loss.
    // Transfer retries also carry the closed Core lifetime: receipt replay can
    // resolve a committed attempt, but a late first write cannot revive it.
    const admitRetained = <
      Result extends
        | { readonly ok: true }
        | { readonly ok: false; readonly error: { readonly code: string } },
      Error,
    >(
      owner: Owner | undefined,
      attempts: Map<string, Attempt<Result>> | undefined,
      operationId: string,
      fingerprint: string,
      send: Effect.Effect<Result, Error>,
    ): Effect.Effect<Admission<Result>> =>
      Effect.gen(function* () {
        if (!owner || owner.closed || !attempts)
          return { accepted: false, message: "The surface command owner is unavailable." };
        const previous = attempts.get(operationId);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            return {
              accepted: false,
              message: "A history operation identity cannot change its request.",
            };
          return { accepted: true, result: previous.result };
        }
        const bytes = new TextEncoder().encode(fingerprint).byteLength;
        if (pendingCount >= MAX_PENDING_ACTIONS || pendingBytes + bytes > MAX_PENDING_BYTES)
          return {
            accepted: false,
            message: "Too many surface commands are pending. Wait for confirmation.",
          };
        const result = yield* Deferred.make<Result>();
        attempts.set(operationId, { fingerprint, result });
        pendingCount++;
        pendingBytes += bytes;
        callbacks(
          Effect.gen(function* () {
            let delay = 100;
            while (true) {
              const outcome = yield* send.pipe(Effect.catch(() => Effect.succeed(null)));
              if (outcome && (outcome.ok || outcome.error.code !== "unknown")) {
                yield* Deferred.succeed(result, outcome);
                return;
              }
              yield* Effect.sleep(delay);
              delay = Math.min(delay * 2, 5_000);
            }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                attempts.delete(operationId);
                pendingCount--;
                pendingBytes -= bytes;
              }),
            ),
          ),
        );
        return { accepted: true, result };
      });
    const awaitAdmission = <Result, Failure>(
      admission: Effect.Effect<Admission<Result>>,
      reject: (message: string) => Failure,
    ): Effect.Effect<Result | Failure> =>
      admission.pipe(
        Effect.flatMap((entry): Effect.Effect<Result | Failure> =>
          entry.accepted ? Deferred.await(entry.result) : Effect.succeed(reject(entry.message)),
        ),
      );
    const transferFailure = (message: string) => ({
      ok: false as const,
      error: blockTransferFailure("invalid_transfer_request", message),
    });
    return EditorHistoryRuntime.of({
      transferBlocks: (target, request) => {
        const owner = ownerFor(target);
        const frozen = structuredClone(request);
        return awaitAdmission(
          admitRetained(
            owner,
            owner?.transferAttempts,
            frozen.operationId,
            JSON.stringify(frozen),
            Effect.suspend(() => documents.transferBlocks(frozen, owner?.id)),
          ),
          transferFailure,
        );
      },
      reverseBlockTransfer: (target, request) => {
        const owner = ownerFor(target);
        const frozen = structuredClone(request);
        return awaitAdmission(
          admitRetained(
            owner,
            owner?.reverseTransferAttempts,
            frozen.operationId,
            JSON.stringify(frozen),
            Effect.suspend(() => documents.undoBlockTransfer(frozen, owner?.id)),
          ),
          transferFailure,
        );
      },
      applyDatabase: (target, request) => {
        const owner = ownerFor(target);
        const frozen = structuredClone(request);
        return awaitAdmission(
          admitRetained(
            owner,
            owner?.databaseAttempts,
            frozen.operationId,
            JSON.stringify(frozen),
            Effect.suspend(() => database.apply(frozen)),
          ),
          failure,
        );
      },
      applyLibraryDatabase: (target, request) => {
        const owner = ownerFor(target);
        const frozen = structuredClone(request);
        return awaitAdmission(
          admitRetained(
            owner,
            owner?.libraryDatabaseAttempts,
            frozen.operationId,
            JSON.stringify(frozen),
            Effect.suspend(() => database.applyLibrary(frozen)),
          ),
          failure,
        );
      },
      handoffAbandonTransfer: (target, request) => {
        const owner = ownerFor(target);
        const frozen = structuredClone(request);
        return Effect.gen(function* () {
          if (!owner || abandonedCount >= MAX_PENDING_ACTIONS)
            return { accepted: false, message: "History cleanup capacity is exhausted." };
          const admission = yield* admitRetained(
            owner,
            owner.transferAttempts,
            frozen.operationId,
            JSON.stringify(frozen),
            Effect.suspend(() => documents.transferBlocks(frozen, owner.id)),
          );
          if (!admission.accepted) return admission;
          abandonedCount++;
          callbacks(
            Effect.gen(function* () {
              const result = yield* Deferred.await(admission.result);
              if (owner.closed || !result.ok) return;
              const tokens = promotionRetentionResources(result.value);
              if (tokens.length === 0) return;
              const released = yield* execute(
                owner,
                { kind: "project", projectId: frozen.projectId },
                {
                  operationId: createUuidV7(),
                  storeEpoch: frozen.storeEpoch,
                  operation: {
                    kind: "apply_structural_edit",
                    command: { kind: "release_history", tokens },
                  },
                },
              );
              if (!released.ok)
                yield* Effect.logWarning(
                  "Abandoned Promotion cleanup remains owned by its window lifetime.",
                );
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  abandonedCount--;
                }),
              ),
            ),
          );
          return { accepted: true };
        });
      },
      handoffAbandon: (target, access, request) => {
        const owner = ownerFor(target);
        return Effect.gen(function* () {
          const operation = request.operation;
          if (
            operation.kind !== "reverse_structural_edit" &&
            operation.kind !== "apply_structural_edit" &&
            operation.kind !== "create_page_mention"
          )
            return { accepted: false, message: "Only an editor content command can be abandoned." };
          if (!owner || abandonedCount >= MAX_PENDING_ACTIONS)
            return { accepted: false, message: "History cleanup capacity is exhausted." };
          const admission = yield* admit(owner, access, request);
          if (!admission.accepted) return admission;
          abandonedCount++;
          callbacks(
            Effect.gen(function* () {
              // Never release the input capability while its outcome is unknown:
              // doing so could race the originally admitted inverse transaction.
              const result = yield* Deferred.await(admission.result);
              if (owner.closed) return;
              const original =
                operation.kind === "reverse_structural_edit" ? [operation.token] : [];
              const inverse = result.ok ? result.value.structuralEdit?.history : undefined;
              const tokens = inverse ? [...original, inverse] : original;
              if (tokens.length === 0) return;
              const released = yield* execute(owner, access, {
                operationId: createUuidV7(),
                storeEpoch: request.storeEpoch,
                operation: {
                  kind: "apply_structural_edit",
                  command: { kind: "release_history", tokens },
                },
              });
              if (!released.ok)
                yield* Effect.logWarning(
                  "Abandoned history cleanup remains owned by its window lifetime.",
                );
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  abandonedCount--;
                }),
              ),
            ),
          );
          return { accepted: true };
        });
      },
      apply: (target, access, request) => {
        // Bind the renderer generation at synchronous IPC ingress, not when
        // a suspended Effect happens to start after navigation or a crash.
        const owner = ownerFor(target);
        return Effect.gen(function* () {
          const admission = yield* admit(owner, access, request);
          if (!admission.accepted) return failure(admission.message);
          return yield* Deferred.await(admission.result);
        });
      },
      handoffRelease: (target, access, request) => {
        const owner = ownerFor(target);
        return Effect.gen(function* () {
          if (
            request.operation.kind !== "apply_structural_edit" ||
            !(
              request.operation.command.kind === "release_history" ||
              (request.operation.command.kind === "set_local_history_retention" &&
                request.operation.command.retention.closed &&
                !request.operation.command.retention.retainDocument &&
                request.operation.command.retention.blockIds.length === 0)
            )
          ) {
            return {
              accepted: false,
              message:
                "History cleanup only accepts token release or closing a local history surface.",
            };
          }
          const admission = yield* admit(owner, access, request);
          if (!admission.accepted) return admission;
          callbacks(
            Deferred.await(admission.result).pipe(
              Effect.flatMap((result) =>
                result.ok
                  ? Effect.void
                  : Effect.logWarning(
                      "Editor history release was rejected; its lifetime remains the retention owner.",
                    ),
              ),
            ),
          );
          return { accepted: true };
        });
      },
    });
  }),
);
