import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { IpcApi } from "../../../shared/ipc-api";
import {
  additionalDocumentCommandFailure,
  additionalDocumentCommandTransportFailure,
  bindAdditionalDocumentCommandToProject,
} from "../../../shared/additional-document-command-transport";
import {
  bindTrustedBlockPropertyMutationV2,
  bindTrustedLibraryBlockPropertyMutationV2,
  blockPropertyMutationFailureV2,
  blockPropertyMutationTransportFailureV2,
  libraryBlockPropertyMutationTransportFailureV2,
} from "../../../shared/block-property-mutation-v2-transport";
import {
  bindBlockTransferIntent,
  bindBlockTransferUndoIntent,
  blockTransferFailure,
} from "../../../shared/block-transfer-transport";
import type {
  CreatedDocumentVersionSummary,
  DocumentVersionDetail,
  DocumentVersionSummary,
} from "../../../shared/block-documents/document-history";
import {
  bindTrustedDocumentVersionCheckpoint,
  documentHistoryFailure,
  DocumentHistoryContractError,
  parseGetDocumentVersion,
  parseListDocumentVersions,
  type DocumentHistoryCommandResult,
} from "../../../shared/block-documents/document-history-transport";
import {
  bindTrustedDocumentMutation,
  documentMutationFailure,
} from "../../../shared/block-documents/document-operation-transport";
import {
  bindDatabaseApplyV2,
  bindDatabaseModuleReadV2,
  bindLibraryDatabaseApplyV2,
  bindLibraryDatabaseModuleReadV2,
  databaseModuleFailureV2,
} from "../../../shared/database-module-v2-transport";
import { parseContentAccessContext } from "../../../shared/content-access-context";
import {
  bindLibraryModuleApply,
  bindLibraryModuleRead,
  libraryModuleFailure,
} from "../../../shared/library-module-transport";
import {
  bindTrustedPageLifecycleMutationV2,
  pageLifecycleMutationFailureV2,
  pageLifecycleTransportFailureV2,
} from "../../../shared/page-lifecycle-v2-transport";
import {
  PageHistoryContractError,
  pageHistoryFailure,
  pageHistoryTransportFailure,
  parseListPageHistoryRequest,
} from "../../../shared/page-history-transport";
import { MainConfig } from "../../app/MainConfig";
import { DesktopDocumentSessionRuntime } from "../../core-client";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { EditorHistoryRuntime } from "../../host-runtime/EditorHistoryRuntime";
import { DatabaseModule } from "../../database-application/DatabaseModule";
import { LibraryModule } from "../../library-application/LibraryModule";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const documentHistoryInvalid = <A>(error: unknown): DocumentHistoryCommandResult<A> => ({
  ok: false,
  error: documentHistoryFailure(
    "invalid_document_history_request",
    error instanceof DocumentHistoryContractError
      ? error.message
      : "Document history request is invalid",
  ),
});

const documentHistoryUnavailable = <A>(error: unknown): DocumentHistoryCommandResult<A> => ({
  ok: false,
  error: documentHistoryFailure(
    "unknown",
    messageOf(error, "The durable Document history writer is unavailable"),
    { retryable: true },
  ),
});

export const live: Layer.Layer<
  never,
  never,
  | DatabaseModule
  | DesktopDocumentSessionRuntime
  | ElectronIpc
  | EditorHistoryRuntime
  | LibraryModule
  | MainConfig
  | RendererClientRuntime
  | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const database = yield* DatabaseModule;
    const documents = yield* DesktopDocumentSessionRuntime;
    const ipc = yield* ElectronIpc;
    const library = yield* LibraryModule;
    const editorHistory = yield* EditorHistoryRuntime;
    const rendererClients = yield* RendererClientRuntime;
    const windows = yield* WindowRuntime;

    const trustedTarget = (event: IpcMainInvokeEvent): WebContents | null => {
      try {
        requireTrustedAppRendererSender(event, "Core mutation authority", config.rendererUrl);
        return windows.has(event.sender.id) ? event.sender : null;
      } catch {
        return null;
      }
    };
    const trustedIdentity = (event: IpcMainInvokeEvent) => {
      const target = trustedTarget(event);
      if (!target) return null;
      try {
        const clientId = rendererClients.ensureClient(target).clientId;
        return {
          clientSessionId: clientId,
          actor: { kind: "electron_renderer" as const, clientId },
        };
      } catch {
        return null;
      }
    };

    yield* ipc.handleLocalCommitCommand(
      "block-properties:mutate",
      (event, projectId: string, rawRequest: IpcApi["block-properties:mutate"]["args"][1]) => {
        const identity = trustedIdentity(event);
        if (!identity) {
          return Effect.succeed({
            ok: false as const,
            error: blockPropertyMutationFailureV2(
              "invalid_property_mutation_request",
              "Block property mutations are restricted to a trusted application window",
            ),
          });
        }
        const bound = bindTrustedBlockPropertyMutationV2(rawRequest, projectId, identity);
        if (!bound.ok) return Effect.succeed(bound);
        return library
          .applyBlockPropertyMutation(bound.value)
          .pipe(
            Effect.catch((error) =>
              Effect.succeed(blockPropertyMutationTransportFailureV2(bound.value, error)),
            ),
          );
      },
    );

    yield* ipc.handleLocalCommitCommand(
      "library-block-properties:mutate",
      (event, rawRequest: IpcApi["library-block-properties:mutate"]["args"][0]) => {
        const identity = trustedIdentity(event);
        if (!identity) {
          return Effect.succeed({
            ok: false as const,
            error: blockPropertyMutationFailureV2(
              "invalid_property_mutation_request",
              "Library Block property mutations are restricted to a trusted application window",
            ),
          });
        }
        const bound = bindTrustedLibraryBlockPropertyMutationV2(rawRequest, identity);
        if (!bound.ok) return Effect.succeed(bound);
        return library
          .applyLibraryBlockPropertyMutation({
            request: bound.value,
            actor: bound.actor,
            accessActor: "app_window",
          })
          .pipe(
            Effect.catch((error) =>
              Effect.succeed(libraryBlockPropertyMutationTransportFailureV2(bound.value, error)),
            ),
          );
      },
    );

    yield* ipc.handleQuery(
      "database-module:read",
      (event, projectId: string, rawRequest: IpcApi["database-module:read"]["args"][1]) => {
        if (!trustedIdentity(event)) {
          return Effect.succeed({
            ok: false as const,
            error: databaseModuleFailureV2(
              "invalid_request",
              "Database Module reads are restricted to a trusted application window",
            ),
          });
        }
        let request;
        try {
          request = bindDatabaseModuleReadV2(rawRequest, projectId);
        } catch (error) {
          return Effect.succeed({
            ok: false as const,
            error: databaseModuleFailureV2(
              "invalid_request",
              messageOf(error, "Database Module read is invalid"),
            ),
          });
        }
        return database.read(request).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              error: databaseModuleFailureV2(
                "unknown",
                messageOf(error, "The durable Database Module reader is unavailable"),
              ),
            }),
          ),
        );
      },
    );

    yield* ipc.handleLocalCommitCommand(
      "database-module:apply",
      (event, projectId: string, rawRequest: IpcApi["database-module:apply"]["args"][1]) => {
        const identity = trustedIdentity(event);
        if (!identity) {
          return Effect.succeed({
            ok: false as const,
            error: databaseModuleFailureV2(
              "invalid_request",
              "Database Module writes are restricted to a trusted application window",
            ),
          });
        }
        let request;
        try {
          request = bindDatabaseApplyV2(rawRequest, projectId, identity);
        } catch (error) {
          return Effect.succeed({
            ok: false as const,
            error: databaseModuleFailureV2(
              "invalid_request",
              messageOf(error, "Database Module apply is invalid"),
            ),
          });
        }
        return editorHistory.applyDatabase(event.sender, request);
      },
    );

    yield* ipc.handleQuery(
      "library-module:read",
      (event, rawAccess: unknown, rawRequest: IpcApi["library-module:read"]["args"][1]) => {
        if (!trustedTarget(event)) {
          return Effect.succeed({
            ok: false as const,
            error: libraryModuleFailure(
              "invalid_request",
              "Library reads are restricted to a trusted application window",
            ),
          });
        }
        let access;
        let request;
        try {
          access = parseContentAccessContext(rawAccess);
          request = bindLibraryModuleRead(rawRequest);
        } catch (error) {
          return Effect.succeed({
            ok: false as const,
            error: libraryModuleFailure(
              "invalid_request",
              messageOf(error, "Library read is invalid"),
            ),
          });
        }
        return library.read(access, request).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              error: libraryModuleFailure(
                "unknown",
                messageOf(error, "The durable Library reader is unavailable"),
                true,
              ),
            }),
          ),
        );
      },
    );

    yield* ipc.handleLocalCommitCommand(
      "library-module:apply",
      (event, rawAccess: unknown, rawRequest: IpcApi["library-module:apply"]["args"][1]) => {
        const target = trustedTarget(event);
        if (!target) {
          return Effect.succeed({
            ok: false as const,
            error: libraryModuleFailure(
              "invalid_request",
              "Library writes are restricted to a trusted application window",
            ),
          });
        }
        let access;
        let request;
        try {
          access = parseContentAccessContext(rawAccess);
          request = bindLibraryModuleApply(rawRequest);
        } catch (error) {
          return Effect.succeed({
            ok: false as const,
            error: libraryModuleFailure(
              "invalid_request",
              messageOf(error, "Library write is invalid"),
            ),
          });
        }
        const operation = request.operation.kind;
        const apply =
          operation === "apply_structural_edit" ||
          operation === "reverse_structural_edit" ||
          operation === "create_page_mention"
            ? editorHistory.apply(target, access, request)
            : library.apply(access, request);
        return apply.pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              error: libraryModuleFailure(
                "unknown",
                messageOf(error, "The durable Library writer is unavailable"),
                true,
              ),
            }),
          ),
        );
      },
    );

    for (const channel of ["editor-history:release", "editor-history:abandon"] as const) {
      yield* ipc.handleControl(channel, (event, rawAccess, rawRequest) => {
        const target = trustedTarget(event);
        if (!target)
          return Effect.succeed({
            accepted: false as const,
            message: "History cleanup requires an owned application window.",
          });
        try {
          const handoff =
            channel === "editor-history:release"
              ? editorHistory.handoffRelease
              : editorHistory.handoffAbandon;
          return handoff(
            target,
            parseContentAccessContext(rawAccess),
            bindLibraryModuleApply(rawRequest),
          );
        } catch {
          return Effect.succeed({
            accepted: false as const,
            message: "History cleanup request is invalid.",
          });
        }
      });
    }

    yield* ipc.handleQuery(
      "library-database-module:read",
      (event, rawRequest: IpcApi["library-database-module:read"]["args"][0]) => {
        if (!trustedTarget(event)) {
          return Effect.succeed({
            ok: false as const,
            error: databaseModuleFailureV2(
              "invalid_request",
              "Library Database reads are restricted to a trusted application window",
            ),
          });
        }
        let request;
        try {
          request = bindLibraryDatabaseModuleReadV2(rawRequest);
        } catch (error) {
          return Effect.succeed({
            ok: false as const,
            error: databaseModuleFailureV2(
              "invalid_request",
              messageOf(error, "Library Database read is invalid"),
            ),
          });
        }
        return database.readLibrary(request).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              error: databaseModuleFailureV2(
                "unknown",
                messageOf(error, "The durable Library Database reader is unavailable"),
              ),
            }),
          ),
        );
      },
    );

    yield* ipc.handleLocalCommitCommand(
      "library-database-module:apply",
      (event, rawRequest: IpcApi["library-database-module:apply"]["args"][0]) => {
        if (!trustedTarget(event)) {
          return Effect.succeed({
            ok: false as const,
            error: databaseModuleFailureV2(
              "invalid_request",
              "Library Database writes are restricted to a trusted application window",
            ),
          });
        }
        let request;
        try {
          request = bindLibraryDatabaseApplyV2(rawRequest);
        } catch (error) {
          return Effect.succeed({
            ok: false as const,
            error: databaseModuleFailureV2(
              "invalid_request",
              messageOf(error, "Library Database write is invalid"),
            ),
          });
        }
        return editorHistory.applyLibraryDatabase(event.sender, request);
      },
    );

    yield* ipc.handleQuery(
      "pages:detail:get",
      (event, projectId: string, pageId: string, minimumCommitSeq?: number) => {
        if (!trustedTarget(event)) {
          return Effect.succeed({
            ok: false as const,
            error: {
              code: "authorization_denied" as const,
              message: "Page Detail is restricted to a trusted application window",
              retryable: false,
            },
          });
        }
        return library.readProjectPageDetail(projectId, pageId, minimumCommitSeq).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              error: {
                code: "unknown" as const,
                message: messageOf(error, "Page Detail is unavailable"),
                retryable: true,
              },
            }),
          ),
        );
      },
    );

    yield* ipc.handleQuery(
      "library-pages:detail:get",
      (event, pageId: string, minimumCommitSeq?: number) => {
        if (!trustedTarget(event)) {
          return Effect.succeed({
            ok: false as const,
            error: {
              code: "authorization_denied" as const,
              message: "Library Page Detail is restricted to a trusted application window",
              retryable: false,
            },
          });
        }
        return library.readLibraryPageDetail(pageId, undefined, minimumCommitSeq).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              error: {
                code: "unknown" as const,
                message: messageOf(error, "Library Page Detail is unavailable"),
                retryable: true,
              },
            }),
          ),
        );
      },
    );

    yield* ipc.handleQuery(
      "pages:lifecycle:preflight",
      (event, projectId: string, pageId: string) => {
        if (!trustedTarget(event)) {
          return Effect.succeed({
            ok: false as const,
            error: {
              code: "authorization_denied" as const,
              message: "Page lifecycle preflight requires a trusted application window",
              retryable: false,
            },
          });
        }
        return library.readPageLifecyclePreflight(projectId, pageId).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              error: {
                code: "unknown" as const,
                message: messageOf(error, "Page lifecycle preflight is unavailable"),
                retryable: true,
              },
            }),
          ),
        );
      },
    );

    yield* ipc.handleLocalCommitCommand(
      "pages:lifecycle:apply",
      (event, projectId: string, rawRequest: IpcApi["pages:lifecycle:apply"]["args"][1]) => {
        const identity = trustedIdentity(event);
        if (!identity) {
          return Effect.succeed({
            ok: false as const,
            error: pageLifecycleMutationFailureV2(
              "invalid_page_lifecycle_request",
              "Page lifecycle mutations are restricted to a trusted application window",
              rawRequest,
            ),
          });
        }
        const bound = bindTrustedPageLifecycleMutationV2(rawRequest, projectId, identity);
        if (!bound.ok) return Effect.succeed(bound);
        return library
          .applyPageLifecycleMutation(bound.value)
          .pipe(
            Effect.catch((error) =>
              Effect.succeed(pageLifecycleTransportFailureV2(bound.value, error)),
            ),
          );
      },
    );

    yield* ipc.handleLocalCommitCommand(
      "block-documents:mutate",
      (
        event,
        projectId: string,
        documentId: string,
        rawRequest: IpcApi["block-documents:mutate"]["args"][2],
      ) => {
        const identity = trustedIdentity(event);
        if (!identity) {
          return Effect.succeed({
            ok: false as const,
            error: documentMutationFailure(
              "invalid_document_operation_request",
              "Document mutations are restricted to a trusted application window",
            ),
          });
        }
        const bound = bindTrustedDocumentMutation(rawRequest, projectId, documentId, identity);
        if (!bound.ok) return Effect.succeed(bound);
        return documents.applyDocumentMutation(bound.value);
      },
    );

    yield* ipc.handleLocalCommitCommand(
      "block-documents:command",
      (event, projectId: string, rawRequest: IpcApi["block-documents:command"]["args"][1]) => {
        const identity = trustedIdentity(event);
        if (!identity) {
          return Effect.succeed({
            ok: false as const,
            error: additionalDocumentCommandFailure(
              "invalid_request",
              "Additional Document commands are restricted to a trusted application window",
            ),
          });
        }
        const bound = bindAdditionalDocumentCommandToProject(rawRequest, projectId, identity);
        if (!bound.ok) return Effect.succeed(bound);
        return documents
          .applyAdditionalDocumentCommand(bound.value)
          .pipe(
            Effect.catch((error) =>
              Effect.succeed(additionalDocumentCommandTransportFailure(bound.value, error)),
            ),
          );
      },
    );

    yield* ipc.handleLocalCommitCommand(
      "blocks:transfer",
      (event, projectId: string, rawIntent: IpcApi["blocks:transfer"]["args"][1]) => {
        const identity = trustedIdentity(event);
        if (!identity) {
          return Effect.succeed({
            ok: false as const,
            error: blockTransferFailure(
              "invalid_transfer_request",
              "Block transfer is restricted to a trusted application window",
            ),
          });
        }
        const bound = bindBlockTransferIntent(rawIntent, projectId, identity);
        if (!bound.ok) return Effect.succeed(bound);
        return editorHistory.transferBlocks(event.sender, bound.value);
      },
    );

    yield* ipc.handleControl("editor-history:abandon-transfer", (event, projectId, rawIntent) => {
      const identity = trustedIdentity(event);
      if (!identity)
        return Effect.succeed({
          accepted: false,
          message: "History cleanup requires an owned application window.",
        });
      const bound = bindBlockTransferIntent(rawIntent, projectId, identity);
      if (!bound.ok) return Effect.succeed({ accepted: false, message: bound.error.message });
      return editorHistory.handoffAbandonTransfer(event.sender, bound.value);
    });

    yield* ipc.handleLocalCommitCommand(
      "blocks:transfer:undo",
      (event, projectId: string, rawIntent: IpcApi["blocks:transfer:undo"]["args"][1]) => {
        if (!trustedTarget(event)) {
          return Effect.succeed({
            ok: false as const,
            error: blockTransferFailure(
              "invalid_transfer_request",
              "Block transfer Undo is restricted to a trusted application window",
            ),
          });
        }
        const bound = bindBlockTransferUndoIntent(rawIntent, projectId);
        if (!bound.ok) return Effect.succeed(bound);
        return editorHistory.reverseBlockTransfer(event.sender, bound.value);
      },
    );

    yield* ipc.handlePlainCommand(
      "block-documents:history:checkpoint",
      (
        event,
        projectId: string,
        documentId: string,
        rawRequest: IpcApi["block-documents:history:checkpoint"]["args"][2],
      ) => {
        const identity = trustedIdentity(event);
        if (!identity) {
          return Effect.succeed(documentHistoryInvalid<CreatedDocumentVersionSummary>("untrusted"));
        }
        let request;
        try {
          request = bindTrustedDocumentVersionCheckpoint(
            rawRequest,
            projectId,
            documentId,
            identity.actor,
          );
        } catch (error) {
          return Effect.succeed(documentHistoryInvalid<CreatedDocumentVersionSummary>(error));
        }
        return documents
          .createCheckpoint(request)
          .pipe(
            Effect.catch((error) =>
              Effect.succeed(documentHistoryUnavailable<CreatedDocumentVersionSummary>(error)),
            ),
          );
      },
    );

    yield* ipc.handleQuery(
      "block-documents:history:list",
      (event, rawRequest: IpcApi["block-documents:history:list"]["args"][0]) => {
        if (!trustedTarget(event)) {
          return Effect.succeed(
            documentHistoryInvalid<readonly DocumentVersionSummary[]>("untrusted"),
          );
        }
        let request;
        try {
          request = parseListDocumentVersions(rawRequest);
        } catch (error) {
          return Effect.succeed(documentHistoryInvalid<readonly DocumentVersionSummary[]>(error));
        }
        return documents
          .listVersions(request)
          .pipe(
            Effect.catch((error) =>
              Effect.succeed(documentHistoryUnavailable<readonly DocumentVersionSummary[]>(error)),
            ),
          );
      },
    );

    yield* ipc.handleQuery(
      "block-documents:history:get",
      (event, rawRequest: IpcApi["block-documents:history:get"]["args"][0]) => {
        if (!trustedTarget(event)) {
          return Effect.succeed(documentHistoryInvalid<DocumentVersionDetail>("untrusted"));
        }
        let request;
        try {
          request = parseGetDocumentVersion(rawRequest);
        } catch (error) {
          return Effect.succeed(documentHistoryInvalid<DocumentVersionDetail>(error));
        }
        return documents
          .getVersion(request)
          .pipe(
            Effect.catch((error) =>
              Effect.succeed(documentHistoryUnavailable<DocumentVersionDetail>(error)),
            ),
          );
      },
    );

    yield* ipc.handleLocalCommitCommand(
      "block-documents:history:restore",
      (
        event,
        projectId: string,
        documentId: string,
        rawRequest: IpcApi["block-documents:history:restore"]["args"][2],
      ) => {
        const identity = trustedIdentity(event);
        if (!identity) {
          return Effect.succeed({
            ok: false as const,
            error: documentMutationFailure(
              "invalid_document_operation_request",
              "Document restore requires a trusted window and valid scope",
            ),
          });
        }
        const bound = bindTrustedDocumentMutation(rawRequest, projectId, documentId, identity);
        if (!bound.ok) return Effect.succeed(bound);
        if (!("versionId" in bound.value)) {
          return Effect.succeed({
            ok: false as const,
            error: documentMutationFailure(
              "invalid_document_operation_request",
              "Document history restore requires a versionId",
              { mutationId: bound.value.mutationId },
            ),
          });
        }
        return documents.restoreVersion(bound.value);
      },
    );

    yield* ipc.handleQuery(
      "pages:history:list",
      (event, rawRequest: IpcApi["pages:history:list"]["args"][0]) => {
        if (!trustedTarget(event)) {
          return Effect.succeed({
            ok: false as const,
            error: pageHistoryFailure(
              "invalid_page_history_request",
              "Page history requires a trusted window",
            ),
          });
        }
        let request;
        try {
          request = parseListPageHistoryRequest(rawRequest);
        } catch (error) {
          return Effect.succeed({
            ok: false as const,
            error: pageHistoryFailure(
              "invalid_page_history_request",
              error instanceof PageHistoryContractError
                ? error.message
                : "Page history request is invalid",
            ),
          });
        }
        return library
          .listPageHistory(request)
          .pipe(Effect.catch(() => Effect.succeed(pageHistoryTransportFailure())));
      },
    );
  }),
);
