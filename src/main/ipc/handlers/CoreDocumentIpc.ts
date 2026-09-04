import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import type { IpcApi } from "../../../shared/ipc-api";
import { documentSyncApplyCommandResult } from "../../../shared/block-documents/document-sync";
import type { CanvasSceneMutationError } from "../../../shared/block-documents/canvas-scene-sync";
import { MainConfig } from "../../app/MainConfig";
import { DesktopDocumentSessionRuntime } from "../../core-client";
import { DatabaseModule } from "../../database-application/DatabaseModule";
import {
  type DocumentSyncClientTarget,
  documentSyncUnauthorized,
} from "../../document-sync-transport";
import { LibraryModule } from "../../library-application/LibraryModule";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class CoreDocumentIpcError extends Schema.TaggedError<CoreDocumentIpcError>()(
  "CoreDocumentIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

type Handler<Channel extends keyof IpcApi> = (
  event: IpcMainInvokeEvent,
  ...args: IpcApi[Channel]["args"]
) => Effect.Effect<IpcApi[Channel]["result"], unknown>;

type ProjectDocumentChannel =
  | "document-sync:apply"
  | "document-sync:awareness:publish"
  | "document-sync:subscribe"
  | "document-sync:sync"
  | "document-sync:unsubscribe";

type LibraryDocumentChannel =
  | "library-document-sync:apply"
  | "library-document-sync:awareness:publish"
  | "library-document-sync:subscribe"
  | "library-document-sync:sync"
  | "library-document-sync:unsubscribe";

const omitProjectScope = <Request extends { readonly projectId: string }>(
  request: Request,
): Omit<Request, "projectId"> => {
  const { projectId, ...unscoped } = request;
  void projectId;
  return unscoped;
};

const canvasUnauthorized = (
  message: string,
  mutationId?: string,
): {
  readonly ok: false;
  readonly error: CanvasSceneMutationError;
} => ({
  ok: false,
  error: {
    code: "access_scope_mismatch",
    message,
    retryable: false,
    resetRequired: false,
    ...(mutationId ? { mutationId } : {}),
  },
});

export const live: Layer.Layer<
  never,
  never,
  | DatabaseModule
  | DesktopDocumentSessionRuntime
  | ElectronIpc
  | LibraryModule
  | MainConfig
  | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const database = yield* DatabaseModule;
    const documents = yield* DesktopDocumentSessionRuntime;
    const ipc = yield* ElectronIpc;
    const library = yield* LibraryModule;
    const windows = yield* WindowRuntime;
    const { handleControl, handleLocalCommitCommand, handlePlainCommand, handleQuery } = ipc;
    const targetFor = (event: IpcMainInvokeEvent): DocumentSyncClientTarget | null => {
      try {
        requireTrustedAppRendererSender(event, "Document authority", config.rendererUrl);
        if (!windows.has(event.sender.id)) return null;
        return event.sender;
      } catch {
        return null;
      }
    };
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          if (!targetFor(event)) throw new Error("Document authority requires an owned window");
        },
        catch: (cause) => new CoreDocumentIpcError({ operation: "authorize-renderer", cause }),
      });
    const unauthorizedResult = <A>() => Effect.succeed(documentSyncUnauthorized() as A);

    yield* handleQuery("page-target:resolve", (event, input) =>
      authorize(event).pipe(Effect.andThen(library.resolvePageTarget(input))),
    );
    yield* handleQuery("page-ownership-path:resolve", (event, input) =>
      authorize(event).pipe(Effect.andThen(library.resolvePageOwnershipPath(input))),
    );
    yield* handleQuery("database-view:reference:get", (event, input) =>
      authorize(event).pipe(Effect.andThen(database.resolveDatabaseViewReference(input))),
    );
    yield* handleQuery("block-document:owned:get", (event, projectId, ownerBlockId) =>
      authorize(event).pipe(
        Effect.andThen(documents.getOwnedDocumentDescriptor(projectId, ownerBlockId)),
      ),
    );
    yield* handlePlainCommand("block-document:owned:prepare", (event, projectId, ownerBlockId) =>
      authorize(event).pipe(
        Effect.andThen(documents.prepareOwnedBlockDocument(projectId, ownerBlockId)),
      ),
    );
    yield* handlePlainCommand("library-block-document:owned:prepare", (event, ownerBlockId) =>
      authorize(event).pipe(
        Effect.andThen(documents.prepareLibraryOwnedBlockDocument(ownerBlockId)),
      ),
    );

    const projectDocumentHandler =
      <Channel extends ProjectDocumentChannel>(
        operation: string,
        execute: (
          target: DocumentSyncClientTarget,
          request: IpcApi[Channel]["args"][0],
        ) => Effect.Effect<IpcApi[Channel]["result"]>,
      ): Handler<Channel> =>
      (event, request) => {
        const target = targetFor(event);
        if (!target) return unauthorizedResult<IpcApi[Channel]["result"]>();
        return execute(target, request).pipe(Effect.withSpan(`CoreDocumentIpc.${operation}`));
      };
    const projectDocumentControl = <
      Channel extends
        | "document-sync:subscribe"
        | "document-sync:unsubscribe"
        | "document-sync:sync"
        | "document-sync:awareness:publish",
    >(
      channel: Channel,
      operation: string,
      execute: (
        target: DocumentSyncClientTarget,
        request: IpcApi[Channel]["args"][0],
      ) => Effect.Effect<IpcApi[Channel]["result"]>,
    ) => handleControl(channel, projectDocumentHandler<Channel>(operation, execute));
    const projectDocumentApply = (
      channel: "document-sync:apply",
      operation: string,
      execute: (
        target: DocumentSyncClientTarget,
        request: IpcApi["document-sync:apply"]["args"][0],
      ) => Effect.Effect<IpcApi["document-sync:apply"]["result"]>,
    ) =>
      handleLocalCommitCommand(
        channel,
        projectDocumentHandler<"document-sync:apply">(operation, execute),
      );

    yield* projectDocumentControl(
      "document-sync:subscribe",
      "subscribe-project-document",
      (target, request) =>
        documents.subscribe(
          { kind: "project", projectId: request.projectId },
          target,
          omitProjectScope(request),
        ),
    );
    yield* projectDocumentControl(
      "document-sync:unsubscribe",
      "unsubscribe-project-document",
      (target, request) =>
        documents.unsubscribe(
          { kind: "project", projectId: request.projectId },
          target,
          omitProjectScope(request),
        ),
    );
    yield* projectDocumentControl(
      "document-sync:sync",
      "sync-project-document",
      (target, request) =>
        documents.sync(
          { kind: "project", projectId: request.projectId },
          target,
          omitProjectScope(request),
        ),
    );
    yield* projectDocumentApply(
      "document-sync:apply",
      "apply-project-document",
      (target, request) =>
        documents
          .applyUpdate(
            { kind: "project", projectId: request.projectId },
            target,
            omitProjectScope(request),
          )
          .pipe(Effect.map(documentSyncApplyCommandResult)),
    );
    yield* projectDocumentControl(
      "document-sync:awareness:publish",
      "publish-project-awareness",
      (target, request) =>
        documents.publishAwareness(
          { kind: "project", projectId: request.projectId },
          target,
          omitProjectScope(request),
        ),
    );

    const libraryDocumentHandler =
      <Channel extends LibraryDocumentChannel>(
        operation: string,
        execute: (
          target: DocumentSyncClientTarget,
          request: IpcApi[Channel]["args"][0],
        ) => Effect.Effect<IpcApi[Channel]["result"]>,
      ): Handler<Channel> =>
      (event, request) => {
        const target = targetFor(event);
        if (!target) return unauthorizedResult<IpcApi[Channel]["result"]>();
        return execute(target, request).pipe(Effect.withSpan(`CoreDocumentIpc.${operation}`));
      };
    const libraryDocumentControl = <
      Channel extends
        | "library-document-sync:subscribe"
        | "library-document-sync:unsubscribe"
        | "library-document-sync:sync"
        | "library-document-sync:awareness:publish",
    >(
      channel: Channel,
      operation: string,
      execute: (
        target: DocumentSyncClientTarget,
        request: IpcApi[Channel]["args"][0],
      ) => Effect.Effect<IpcApi[Channel]["result"]>,
    ) => handleControl(channel, libraryDocumentHandler<Channel>(operation, execute));
    const libraryDocumentApply = (
      channel: "library-document-sync:apply",
      operation: string,
      execute: (
        target: DocumentSyncClientTarget,
        request: IpcApi["library-document-sync:apply"]["args"][0],
      ) => Effect.Effect<IpcApi["library-document-sync:apply"]["result"]>,
    ) =>
      handleLocalCommitCommand(
        channel,
        libraryDocumentHandler<"library-document-sync:apply">(operation, execute),
      );

    yield* libraryDocumentControl(
      "library-document-sync:subscribe",
      "subscribe-library-document",
      (target, request) => documents.subscribe({ kind: "library" }, target, request),
    );
    yield* libraryDocumentControl(
      "library-document-sync:unsubscribe",
      "unsubscribe-library-document",
      (target, request) => documents.unsubscribe({ kind: "library" }, target, request),
    );
    yield* libraryDocumentControl(
      "library-document-sync:sync",
      "sync-library-document",
      (target, request) => documents.sync({ kind: "library" }, target, request),
    );
    yield* libraryDocumentApply(
      "library-document-sync:apply",
      "apply-library-document",
      (target, request) =>
        documents
          .applyUpdate({ kind: "library" }, target, request)
          .pipe(Effect.map(documentSyncApplyCommandResult)),
    );
    yield* libraryDocumentControl(
      "library-document-sync:awareness:publish",
      "publish-library-awareness",
      (target, request) => documents.publishAwareness({ kind: "library" }, target, request),
    );

    yield* handleControl("canvas-scene:subscribe", (event, request) => {
      const target = targetFor(event);
      if (!target)
        return Effect.succeed(canvasUnauthorized("Canvas scene subscription is unauthorized"));
      return documents.subscribeCanvasScene(target, request);
    });
    yield* handleControl("canvas-scene:unsubscribe", (event, request) => {
      const target = targetFor(event);
      if (!target)
        return Effect.succeed(canvasUnauthorized("Canvas scene subscription is unauthorized"));
      return documents.unsubscribeCanvasScene(target, request);
    });
    yield* handleControl("canvas-scene:sync", (event, request) => {
      const target = targetFor(event);
      if (!target) return Effect.succeed(canvasUnauthorized("Canvas scene sync is unauthorized"));
      return documents.syncCanvasScene(target, request);
    });
    yield* handleLocalCommitCommand("canvas-scene:apply", (event, request) => {
      const target = targetFor(event);
      if (!target) {
        return Effect.succeed(
          canvasUnauthorized("Canvas scene mutation is unauthorized", request.mutationId),
        );
      }
      return documents.applyCanvasSceneMutation(target, request);
    });
    yield* handleControl("canvas-scene:presence:publish", (event, request) => {
      const target = targetFor(event);
      if (!target) {
        return Effect.succeed({
          ok: false as const,
          error: {
            code: "unauthorized" as const,
            message: "Canvas presence publication is unauthorized",
            retryable: false as const,
            resetRequired: false as const,
          },
        });
      }
      return documents.publishCanvasPresence(target, request);
    });
    yield* handleQuery("canvas-scene:compaction:read", (event, request) => {
      const target = targetFor(event);
      if (!target)
        return Effect.succeed(canvasUnauthorized("Canvas compaction read is unauthorized"));
      return documents.readCanvasSceneCompaction(target, request);
    });
    yield* handleLocalCommitCommand("canvas-scene:compaction:apply", (event, request) => {
      const target = targetFor(event);
      if (!target) {
        return Effect.succeed(
          canvasUnauthorized("Canvas compaction is unauthorized", request.mutationId),
        );
      }
      return documents.compactCanvasScene(target, request);
    });
  }),
);
