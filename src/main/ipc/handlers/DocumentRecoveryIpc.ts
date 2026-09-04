import { unwrapDocumentSessionFailure } from "../../core-client/document-session-error";
import { CoreModuleResponseError } from "../../core-client/core-client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IpcMainInvokeEvent } from "electron";
import type {
  DocumentRecoveryCommand,
  DocumentRecoveryFailure,
  DocumentRecoveryReadRequest,
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
  const error = unwrapDocumentSessionFailure(input);
  if (error instanceof CoreModuleResponseError) return { ok: false, error: error.coreError };
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
    const authority = yield* CoreAuthority;
    const modules = yield* CoreModules;
    const windows = yield* WindowRuntime;
    const ipc = yield* ElectronIpc;
    const bind = (
      event: IpcMainInvokeEvent,
      request: DocumentRecoveryReadRequest | DocumentRecoveryCommand,
    ): string | undefined => {
      requireTrustedAppRendererSender(event, "Document recovery", config.rendererUrl);
      if (!windows.has(event.sender.id) || request.libraryId !== authority.identity.libraryId)
        throw new Error("Recovery requires access to this Library");
      const context = parseContentAccessContext(request.accessContext);
      return context.kind === "project" ? context.projectId : undefined;
    };
    yield* ipc.handleQuery("document-recovery:read", (event, request) => {
      let projectId: string | undefined;
      try {
        projectId = bind(event, request);
        if (request.read.kind !== "list" && request.read.kind !== "inspect")
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
      return modules.document
        .apply(
          {
            operationId: request.operationId,
            clientSessionId: "document-recovery",
            intent:
              request.kind === "capture"
                ? { kind: "capture_recovery", capture: request.capture }
                : { kind: "resolve_recovery", resolve: request.resolve },
          },
          undefined,
          projectId,
        )
        .pipe(
          Effect.map((result) => {
            if (!result.outcome.recovery)
              return failure(new Error("Recovery acknowledgement is incomplete"));
            return {
              ok: true as const,
              value: result.outcome.recovery,
              localCommit: rendererLocalCommitApply(result),
            };
          }),
          Effect.catch((error) => Effect.succeed(failure(error))),
        );
    });
  }),
);
