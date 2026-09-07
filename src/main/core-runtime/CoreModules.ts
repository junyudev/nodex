import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProjectionImpact } from "../../shared/projection-stream";
import type {
  CanvasSceneSyncRequest,
  CanvasSceneSyncResponse,
} from "../../shared/block-documents/canvas-scene-sync";
import type {
  DocumentAwarenessPublishAck,
  DocumentAwarenessPublishRequest,
  DocumentSyncApplyAck,
  DocumentSyncApplyRequest,
  DocumentSyncRequest,
  DocumentSyncResponse,
} from "../../shared/block-documents/document-sync";
import type {
  AutomationApplyInput,
  AutomationApplyResult,
  AutomationRead,
  AutomationReadSnapshot,
  CoreLocalMutationResolveRequest,
  CoreLocalMutationResolveResponse,
  CoreRequestOptions,
  DatabaseApplyInput,
  DatabaseApplyResult,
  DatabaseRead,
  DatabaseReadSnapshot,
  QueryRead,
  QueryReadSnapshot,
  LibraryApplyInput,
  LibraryApplyResult,
  LibraryRead,
  LibraryReadSnapshot,
  OwnedDocumentApplyInput,
  OwnedDocumentApplyResult,
  OwnedDocumentRead,
  OwnedDocumentReadSnapshot,
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceApplyResult,
  ProjectWorkspaceRead,
  ProjectWorkspaceReadSnapshot,
  StoreAdministrationApplyInput,
  StoreAdministrationApplyResult,
  StoreAdministrationRead,
  StoreAdministrationReadSnapshot,
} from "../core-client/types";
import { CoreSessionAccess } from "./CoreAuthority";
import { CoreApplicationAgent } from "./CoreApplicationAgent";
import { coreRuntimeError, type CoreRuntimeError } from "./CoreRuntimeError";

type CoreEffect<A> = Effect.Effect<A, CoreRuntimeError>;

export interface CoreModuleClients {
  readonly query: {
    readonly read: (
      read: QueryRead,
      projectId: string | null,
      options?: CoreRequestOptions,
    ) => CoreEffect<QueryReadSnapshot>;
  };
  readonly localMutation: {
    readonly resolve: (
      input: CoreLocalMutationResolveRequest,
    ) => CoreEffect<CoreLocalMutationResolveResponse>;
  };
  readonly library: {
    readonly read: (
      read: LibraryRead,
      options?: CoreRequestOptions,
      projectId?: string | null,
    ) => CoreEffect<LibraryReadSnapshot>;
    readonly apply: (
      input: LibraryApplyInput,
      projectId?: string | null,
    ) => CoreEffect<LibraryApplyResult>;
    readonly filterProjectionImpactForProject: (
      projectId: string,
      impact: ProjectionImpact,
    ) => CoreEffect<ProjectionImpact>;
  };
  readonly database: {
    readonly read: (
      read: DatabaseRead,
      projectId?: string | null,
    ) => CoreEffect<DatabaseReadSnapshot>;
    readonly apply: (
      input: DatabaseApplyInput,
      projectId?: string | null,
    ) => CoreEffect<DatabaseApplyResult>;
  };
  readonly workspace: {
    readonly read: (
      read: ProjectWorkspaceRead,
      options?: CoreRequestOptions,
      projectId?: string | null,
    ) => CoreEffect<ProjectWorkspaceReadSnapshot>;
    readonly apply: (
      input: ProjectWorkspaceApplyInput,
      options?: CoreRequestOptions,
      projectId?: string | null,
    ) => CoreEffect<ProjectWorkspaceApplyResult>;
  };
  readonly automation: {
    readonly read: (
      read: AutomationRead,
      options?: CoreRequestOptions,
      projectId?: string | null,
    ) => CoreEffect<AutomationReadSnapshot>;
    readonly apply: (
      input: AutomationApplyInput,
      options?: CoreRequestOptions,
      projectId?: string | null,
    ) => CoreEffect<AutomationApplyResult>;
  };
  readonly administration: {
    readonly read: (read: StoreAdministrationRead) => CoreEffect<StoreAdministrationReadSnapshot>;
    readonly apply: (
      input: StoreAdministrationApplyInput,
    ) => CoreEffect<StoreAdministrationApplyResult>;
  };
  readonly document: {
    readonly read: (
      clientSessionId: string,
      read: OwnedDocumentRead,
      options?: CoreRequestOptions,
      projectId?: string | null,
    ) => CoreEffect<OwnedDocumentReadSnapshot>;
    readonly apply: (
      input: OwnedDocumentApplyInput,
      options?: CoreRequestOptions,
      projectId?: string | null,
    ) => CoreEffect<OwnedDocumentApplyResult>;
    readonly sync: (
      input: DocumentSyncRequest,
      projectId?: string | null,
    ) => CoreEffect<DocumentSyncResponse>;
    readonly canvasSync: (
      input: CanvasSceneSyncRequest,
      projectId?: string | null,
    ) => CoreEffect<CanvasSceneSyncResponse>;
    readonly applyUpdate: (
      input: DocumentSyncApplyRequest,
      projectId?: string | null,
    ) => CoreEffect<DocumentSyncApplyAck>;
    readonly publishAwareness: (
      input: DocumentAwarenessPublishRequest,
      projectId?: string | null,
    ) => CoreEffect<DocumentAwarenessPublishAck>;
  };
}

export class CoreModules extends Context.Service<CoreModules, CoreModuleClients>()(
  "nodex/main/core-runtime/CoreModules",
) {}

const requestOptions = (
  options: CoreRequestOptions | undefined,
  signal: AbortSignal,
): CoreRequestOptions => ({ ...options, signal });

export const live: Layer.Layer<CoreModules, never, CoreSessionAccess> = Layer.effect(
  CoreModules,
  Effect.gen(function* () {
    const access = yield* CoreSessionAccess;
    return CoreModules.of({
      query: {
        read: Effect.fn("CoreModules.query.read")((read, projectId, options) =>
          access.use(
            "query.read",
            (client, signal) => client.queryRead(read, requestOptions(options, signal)),
            { projectId },
          ),
        ),
      },
      localMutation: {
        resolve: Effect.fn("CoreModules.localMutation.resolve")((input) =>
          access.use("localMutation.resolve", (client) => client.resolveLocalMutation(input)),
        ),
      },
      library: {
        read: Effect.fn("CoreModules.library.read")((read, options, projectId) =>
          access.use(
            "library.read",
            (client, signal) => client.libraryRead(read, requestOptions(options, signal)),
            { projectId },
          ),
        ),
        apply: Effect.fn("CoreModules.library.apply")((input, projectId) =>
          access.use("library.apply", (client, signal) => client.libraryApply(input, { signal }), {
            projectId,
          }),
        ),
        filterProjectionImpactForProject: Effect.fn(
          "CoreModules.library.filterProjectionImpactForProject",
        )((projectId, impact) =>
          access.use(
            "library.filterProjectionImpactForProject",
            (client) => client.filterProjectionImpactForProject(projectId, impact),
            { projectId },
          ),
        ),
      },
      database: {
        read: Effect.fn("CoreModules.database.read")((read, projectId) =>
          access.use("database.read", (client, signal) => client.databaseRead(read, { signal }), {
            projectId,
          }),
        ),
        apply: Effect.fn("CoreModules.database.apply")((input, projectId) =>
          access.use(
            "database.apply",
            (client, signal) => client.databaseApply(input, { signal }),
            { projectId },
          ),
        ),
      },
      workspace: {
        read: Effect.fn("CoreModules.workspace.read")((read, options, projectId) =>
          access.use(
            "workspace.read",
            (client, signal) => client.workspaceRead(read, requestOptions(options, signal)),
            { projectId },
          ),
        ),
        apply: Effect.fn("CoreModules.workspace.apply")(function* (input, options, projectId) {
          const provenance = yield* CoreApplicationAgent;
          const request = provenance
            ? {
                ...input,
                intent: { kind: "agent_command" as const, provenance, intent: input.intent },
              }
            : input;
          return yield* access.use(
            "workspace.apply",
            (client, signal) => client.workspaceApply(request, requestOptions(options, signal)),
            { projectId: provenance ? (provenance.authority.actor_project_id ?? null) : projectId },
          );
        }),
      },
      automation: {
        read: Effect.fn("CoreModules.automation.read")(function* (read, options, projectId) {
          const provenance = yield* CoreApplicationAgent;
          if (
            provenance &&
            read.kind !== "definition" &&
            read.kind !== "agent_definition" &&
            read.kind !== "definitions" &&
            read.kind !== "agent_definitions"
          ) {
            return yield* coreRuntimeError({
              operation: "automation.read",
              reason: "operation",
              retryable: false,
              cause: new Error("Agent Automation access is limited to definitions"),
            });
          }
          let request: AutomationRead = read;
          if (provenance && (read.kind === "definition" || read.kind === "agent_definition")) {
            request = { kind: "agent_definition", provenance, automation_id: read.automation_id };
          }
          if (provenance && (read.kind === "definitions" || read.kind === "agent_definitions")) {
            request = {
              kind: "agent_definitions",
              provenance,
              search_query: read.search_query,
              window: read.window,
            };
          }
          return yield* access.use(
            "automation.read",
            (client, signal) => client.automationRead(request, requestOptions(options, signal)),
            { projectId: provenance ? (provenance.authority.actor_project_id ?? null) : projectId },
          );
        }),
        apply: Effect.fn("CoreModules.automation.apply")(function* (input, options, projectId) {
          const provenance = yield* CoreApplicationAgent;
          const request: AutomationApplyInput = provenance
            ? { ...input, intent: { kind: "agent_command", provenance, intent: input.intent } }
            : input;
          return yield* access.use(
            "automation.apply",
            (client, signal) => client.automationApply(request, requestOptions(options, signal)),
            { projectId: provenance ? (provenance.authority.actor_project_id ?? null) : projectId },
          );
        }),
      },
      administration: {
        read: Effect.fn("CoreModules.administration.read")((read) =>
          access.use("administration.read", (client) => client.administrationRead(read)),
        ),
        apply: Effect.fn("CoreModules.administration.apply")((input) =>
          access.use("administration.apply", (client) => client.administrationApply(input)),
        ),
      },
      document: {
        read: Effect.fn("CoreModules.document.read")((clientSessionId, read, options, projectId) =>
          access.use(
            "document.read",
            (client, signal) =>
              client.documentRead(clientSessionId, read, requestOptions(options, signal)),
            { projectId },
          ),
        ),
        apply: Effect.fn("CoreModules.document.apply")((input, options, projectId) =>
          access.use(
            "document.apply",
            (client, signal) => client.documentApply(input, requestOptions(options, signal)),
            { projectId },
          ),
        ),
        sync: Effect.fn("CoreModules.document.sync")((input, projectId) =>
          access.use("document.sync", (client, signal) => client.documentSync(input, { signal }), {
            projectId,
          }),
        ),
        canvasSync: Effect.fn("CoreModules.document.canvasSync")((input, projectId) =>
          access.use(
            "document.canvasSync",
            (client, signal) => client.documentCanvasSync(input, { signal }),
            {
              projectId,
            },
          ),
        ),
        applyUpdate: Effect.fn("CoreModules.document.applyUpdate")((input, projectId) =>
          access.use(
            "document.applyUpdate",
            (client, signal) => client.documentApplyUpdate(input, { signal }),
            {
              projectId,
            },
          ),
        ),
        publishAwareness: Effect.fn("CoreModules.document.publishAwareness")((input, projectId) =>
          access.use(
            "document.publishAwareness",
            (client, signal) => client.documentPublishAwareness(input, { signal }),
            { projectId, replayAfterRecovery: false },
          ),
        ),
      },
    });
  }),
);
