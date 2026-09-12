import { CoreHttpError, CoreResponseTooLargeError } from "../../core-client/uds-http";
import { createHash } from "node:crypto";
import { contentAccessIdentityKey } from "../../../shared/content-access-context";
import {
  makeDocumentRecoveryExportSink,
  RecoveryExportError,
  RECOVERY_EXPORT_CHUNK_BYTES,
} from "../../document-recovery-export";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { unwrapDocumentSessionFailure } from "../../core-client/document-session-error";
import { CoreModuleResponseError } from "../../core-client/core-client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import type { IpcMainInvokeEvent } from "electron";
import type {
  DocumentRecoveryFailure,
  DocumentRecoveryScope,
} from "../../../shared/block-documents/document-recovery";
import { parseContentAccessContext } from "../../../shared/content-access-context";
import { isBoundedOperationId } from "../../../shared/operation-identity";
import { MainConfig } from "../../app/MainConfig";
import { CoreAuthority } from "../../core-runtime/CoreAuthority";
import { CoreModules } from "../../core-runtime/CoreModules";
import { rendererLocalCommitApply } from "../../core-client/types";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

const failure = (
  input: unknown,
  code: DocumentRecoveryFailure["error"]["code"] = "core_unavailable",
): DocumentRecoveryFailure => {
  const error = unwrapDocumentSessionFailure(
    input instanceof RecoveryExportError ? input.cause : input,
  );
  if (error instanceof CoreModuleResponseError) return { ok: false, error: error.coreError };
  if (error instanceof CoreHttpError)
    return {
      ok: false,
      error: {
        code:
          error.status === 413
            ? "resource_exhausted"
            : error.status === 401 || error.status === 403
              ? "unauthorized"
              : error.status >= 500
                ? "core_unavailable"
                : "invalid_input",
        message: error.message,
        retryable: error.status >= 500,
        recovery: error.failure
          ? { kind: "recovery_package", failure: error.failure }
          : { kind: "none" },
      },
    };
  if (error instanceof CoreResponseTooLargeError)
    return {
      ok: false,
      error: {
        code: "resource_exhausted",
        message: error.message,
        retryable: true,
        recovery: {
          kind: "recovery_package",
          failure: {
            reason: "response_too_large",
            effect: "unknown",
            actual: error.observedAtLeastBytes,
            limit: error.maximumBytes,
          },
        },
      },
    };
  return {
    ok: false,
    error: {
      code,
      message:
        error instanceof Error
          ? error.message
          : "Recovery is temporarily unavailable. Your retained edits are unchanged.",
      retryable: code === "core_unavailable",
      recovery: { kind: "none" },
    },
  };
};

/** Trusted desktop Adapter; Core remains the sole owner of draft bytes, authorization and resolution. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const desktop = yield* ElectronDesktop;
    const exports = yield* makeDocumentRecoveryExportSink;
    const callbacks = yield* ScopedCallbackRuntime;
    const watchedSenders = new Map<import("electron").WebContents, () => void>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [sender, listener] of watchedSenders)
          sender.removeListener("destroyed", listener);
        watchedSenders.clear();
      }),
    );
    const authority = yield* CoreAuthority;
    const modules = yield* CoreModules;
    const windows = yield* WindowRuntime;
    const ipc = yield* ElectronIpc;
    const bind = (
      event: IpcMainInvokeEvent,
      request: DocumentRecoveryScope,
    ): string | undefined => {
      requireTrustedAppRendererSender(event, "Document recovery", config.rendererUrl);
      if (!windows.has(event.sender.id) || request.libraryId !== authority.identity.libraryId)
        throw new Error("Recovery requires access to this Library");
      const context = parseContentAccessContext(request.accessContext);
      return context.kind === "project" ? context.projectId : undefined;
    };
    yield* ipc.handlePlainCommand("document-recovery:export", (event, request) => {
      const run = <T>(task: () => Promise<T>) =>
        Effect.tryPromise({ try: task, catch: (cause) => new RecoveryExportError({ cause }) });
      return Effect.gen(function* () {
        const projectId = yield* Effect.try({
          try: () => bind(event, request),
          catch: (cause) => new RecoveryExportError({ cause }),
        });
        const scope = contentAccessIdentityKey(request);
        const owner = event.sender.id;
        if (request.kind === "append") {
          yield* exports.append(owner, scope, request.handle, request.offset, request.bytes);
          return { ok: true as const, status: "written" as const };
        }
        if (request.kind === "complete") {
          yield* exports.complete(owner, scope, request.handle);
          return { ok: true as const, status: "saved" as const };
        }
        if (request.kind === "cancel") {
          yield* exports.cancel(owner, scope, request.handle);
          return { ok: true as const, status: "cancelled" as const };
        }
        if (request.kind !== "begin" && request.kind !== "received")
          return failure("Invalid recovery export command", "invalid_input");
        const window = windows.get(owner);
        const options = {
          title: "Export retained edits",
          defaultPath: "retained-edits.nodex-recovery",
          filters: [{ name: "Nodex recovery package", extensions: ["nodex-recovery"] }],
        };
        const save = yield* run(() =>
          window
            ? desktop.dialog.showSaveDialog(window, options)
            : desktop.dialog.showSaveDialog(options),
        );
        if (save.canceled || !save.filePath)
          return { ok: true as const, status: "cancelled" as const };
        if (event.sender.isDestroyed() || !windows.has(owner))
          return failure("The recovery window closed", "invalid_input");
        const destination = save.filePath;
        if (!watchedSenders.has(event.sender)) {
          const listener = () => {
            watchedSenders.delete(event.sender);
            callbacks.fork(exports.closeOwner(owner));
          };
          watchedSenders.set(event.sender, listener);
          event.sender.once("destroyed", listener);
        }
        if (request.kind === "begin") {
          const handle = yield* exports.begin(
            owner,
            scope,
            destination,
            request.byteLength,
            request.payloadHash,
          );
          return { ok: true as const, status: "ready" as const, handle };
        }
        const bytes = yield* modules.document.exportRecovery(request.draftId, projectId);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const handle = yield* exports.begin(owner, scope, destination, bytes.length, hash);
        yield* Effect.gen(function* () {
          for (let offset = 0; offset < bytes.length; offset += RECOVERY_EXPORT_CHUNK_BYTES)
            yield* exports.append(
              owner,
              scope,
              handle,
              offset,
              bytes.subarray(offset, offset + RECOVERY_EXPORT_CHUNK_BYTES),
            );
          yield* exports.complete(owner, scope, handle);
        }).pipe(Effect.onError(() => exports.cancel(owner, scope, handle).pipe(Effect.orDie)));
        return { ok: true as const, status: "saved" as const };
      }).pipe(Effect.catch((error) => Effect.succeed(failure(error))));
    });
    yield* ipc.handleQuery("document-recovery:read", (event, request) => {
      let projectId: string | undefined;
      try {
        projectId = bind(event, request);
        if (
          request.read.kind !== "list" &&
          request.read.kind !== "inspect" &&
          request.read.kind !== "preview"
        )
          throw new Error("Invalid recovery read");
      } catch (error) {
        return Effect.succeed(failure(error, "invalid_input"));
      }
      return modules.document
        .read("document-recovery", { kind: "recovery", read: request.read }, undefined, projectId)
        .pipe(
          Effect.map((result) => {
            if (result.value.kind !== "recovery")
              return failure(new Error("Unexpected recovery response"));
            return { ok: true as const, value: result.value.value, storeEpoch: result.store_epoch };
          }),
          Effect.catch((error) => Effect.succeed(failure(error))),
        );
    });
    yield* ipc.handleLocalCommitCommand("document-recovery:apply", (event, request) => {
      let projectId: string | undefined;
      try {
        projectId = bind(event, request);
        if (request.storeEpoch !== authority.identity.storeEpoch)
          return Effect.succeed(
            failure(
              new Error("The Library changed. Refresh recovery before continuing."),
              "stale_store_epoch",
            ),
          );
        if (!isBoundedOperationId(request.operationId))
          throw new Error("Recovery requires a bounded operation identity");
        if (request.kind !== "capture" && request.kind !== "resolve")
          throw new Error("Invalid recovery command");
      } catch (error) {
        return Effect.succeed(failure(error, "invalid_input"));
      }
      const operation =
        request.kind === "capture"
          ? modules.document.captureRecovery(
              {
                operationId: request.operationId,
                clientSessionId: "document-recovery",
                bundle: request.bundle,
              },
              projectId,
            )
          : modules.document.apply(
              {
                operationId: request.operationId,
                clientSessionId: "document-recovery",
                intent: { kind: "resolve_recovery", resolve: request.resolve },
              },
              undefined,
              projectId,
            );
      return operation.pipe(
        Effect.map((result) => {
          if (
            !result.outcome.recovery ||
            (request.kind === "capture" && !result.outcome.recovery_capture)
          )
            return failure(new Error("Recovery acknowledgement is incomplete"));
          return {
            ok: true as const,
            value: {
              ...result.outcome.recovery,
              capture_receipt: result.outcome.recovery_capture ?? undefined,
            },
            localCommit: rendererLocalCommitApply(result),
          };
        }),
        Effect.catch((error) => Effect.succeed(failure(error))),
      );
    });
  }),
);
