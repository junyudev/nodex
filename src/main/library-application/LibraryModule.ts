import type { ReadFileBytesInput } from "../../shared/library-files";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ContentAccessContext } from "../../shared/content-access-context";
import type {
  LibraryModuleApplyRequest,
  LibraryModuleApplyResult,
  LibraryModuleReadRequest,
  LibraryModuleReadResult,
} from "../../shared/library-module";
import type { LibraryPageDetailResult, PageDetailResult } from "../../shared/page-detail";
import type { ListPageHistoryRequest } from "../../shared/page-history";
import type { PageHistoryCommandResult } from "../../shared/page-history-transport";
import type {
  BlockPropertyMutationCommandResultV2,
  BlockPropertyMutationRequestV2,
  LibraryBlockPropertyMutationCommandResultV2,
  LibraryBlockPropertyMutationRequestV2,
} from "../../shared/block-property-mutations-v2";
import type {
  PageLifecycleMutationCommandResultV2,
  PageLifecycleMutationRequestV2,
} from "../../shared/page-lifecycle-v2";
import type { PageLifecyclePreflightResultV2 } from "../../shared/page-lifecycle-v2-runtime";
import type { PageOwnershipPathReadModel } from "../../shared/page-ownership-paths";
import type { ResolvePageOwnershipPathInput } from "../../shared/page-ownership-paths";
import type { PageTargetReadModel, ResolvePageTargetInput } from "../../shared/page-targets";
import type {
  PageSearchFacets,
  PageSearchInput,
  PageSearchMetadataSnapshot,
  PageSearchSnapshot,
} from "../../shared/types";
import {
  createCoreLibraryModuleAdapter,
  type CoreLibraryModuleAdapter,
} from "../core-client/library-module-adapter";
import type { CoreClientPort, ManagedBlobBytes, PreparedBlobReceipt } from "../core-client/types";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import {
  type CoreMinimumCommitTimeout,
  type CoreStoreEpochMismatch,
  readCoreProjectionAtLeast,
} from "../core-runtime/CoreMinimumCommit";

export class LibraryModuleError extends Schema.TaggedError<LibraryModuleError>()(
  "LibraryModuleError",
  {
    operation: Schema.String,
    projectId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

type LibraryEffect<A> = Effect.Effect<
  A,
  LibraryModuleError | CoreStoreEpochMismatch | CoreMinimumCommitTimeout
>;

export class LibraryModule extends Context.Service<
  LibraryModule,
  {
    readonly read: (
      accessContext: ContentAccessContext,
      request: LibraryModuleReadRequest,
    ) => LibraryEffect<LibraryModuleReadResult>;
    readonly apply: (
      accessContext: ContentAccessContext,
      request: LibraryModuleApplyRequest,
    ) => LibraryEffect<LibraryModuleApplyResult>;
    readonly prepareFileBlob: (
      accessContext: ContentAccessContext,
      operationId: string,
      idempotencySlot: string,
      bytes: Uint8Array,
    ) => LibraryEffect<PreparedBlobReceipt>;
    readonly readFileBlob: (
      accessContext: ContentAccessContext,
      input: ReadFileBytesInput,
    ) => LibraryEffect<ManagedBlobBytes>;
    readonly readProjectPageDetail: (
      projectId: string,
      pageId: string,
      minimumCommitSeq?: number,
    ) => LibraryEffect<PageDetailResult>;
    readonly readLibraryPageDetail: (
      pageId: string,
      accessActor?: "app_window" | "http_loopback",
      minimumCommitSeq?: number,
    ) => LibraryEffect<LibraryPageDetailResult>;
    readonly listPageHistory: (
      request: ListPageHistoryRequest,
    ) => LibraryEffect<PageHistoryCommandResult>;
    readonly searchPages: (input: PageSearchInput) => LibraryEffect<PageSearchSnapshot>;
    readonly pageSearchMetadata: (
      projectIds: string[],
      pageIds?: string[],
    ) => LibraryEffect<PageSearchMetadataSnapshot>;
    readonly pageSearchFacets: (projectIds: string[]) => LibraryEffect<PageSearchFacets>;
    readonly resolvePageTarget: (
      input: ResolvePageTargetInput,
    ) => LibraryEffect<PageTargetReadModel | null>;
    readonly resolvePageOwnershipPath: (
      input: ResolvePageOwnershipPathInput,
    ) => LibraryEffect<PageOwnershipPathReadModel | null>;
    readonly findPageLocation: (
      pageId: string,
    ) => LibraryEffect<{ readonly pageId: string; readonly projectId: string } | null>;
    readonly findViewLocation: (viewId: string) => LibraryEffect<{
      readonly viewId: string;
      readonly dataSourceId: string;
      readonly databaseId: string;
      readonly projectId: string;
    } | null>;
    readonly readPageLifecyclePreflight: (
      projectId: string,
      pageId: string,
    ) => LibraryEffect<PageLifecyclePreflightResultV2>;
    readonly applyPageLifecycleMutation: (
      request: PageLifecycleMutationRequestV2,
    ) => LibraryEffect<PageLifecycleMutationCommandResultV2>;
    readonly applyBlockPropertyMutation: (
      request: BlockPropertyMutationRequestV2,
    ) => LibraryEffect<BlockPropertyMutationCommandResultV2>;
    readonly applyLibraryBlockPropertyMutation: (input: {
      readonly request: LibraryBlockPropertyMutationRequestV2;
      readonly actor: BlockPropertyMutationRequestV2["actor"];
      readonly accessActor?: "app_window" | "http_loopback";
    }) => LibraryEffect<LibraryBlockPropertyMutationCommandResultV2>;
  }
>()("nodex/main/library-application/LibraryModule") {}

export const live: Layer.Layer<LibraryModule, never, CoreAuthority | CoreSessionAccess> =
  Layer.effect(
    LibraryModule,
    Effect.gen(function* () {
      const authority = yield* CoreAuthority;
      const sessions = yield* CoreSessionAccess;
      const adapter = (client: CoreClientPort): CoreLibraryModuleAdapter =>
        createCoreLibraryModuleAdapter({
          client,
          libraryId: authority.identity.libraryId,
          profileId: authority.identity.profileId,
          storeEpoch: authority.identity.storeEpoch,
        });
      const useClient = <A>(
        operation: string,
        projectId: string | undefined,
        run: (client: CoreClientPort, signal: AbortSignal) => Promise<A>,
      ): LibraryEffect<A> =>
        sessions
          .use(operation, run, {
            ...(projectId ? { projectId } : {}),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new LibraryModuleError({ operation, ...(projectId ? { projectId } : {}), cause }),
            ),
          );
      const use = <A>(
        operation: string,
        projectId: string | undefined,
        run: (adapter: CoreLibraryModuleAdapter, signal: AbortSignal) => Promise<A>,
      ): LibraryEffect<A> =>
        useClient(operation, projectId, (client, signal) => run(adapter(client), signal));
      const projectIdForAccess = (access: ContentAccessContext): string | undefined =>
        access.kind === "project" ? access.projectId : undefined;
      const readPageDetailAtLeast = <A extends PageDetailResult | LibraryPageDetailResult>(
        read: LibraryEffect<A>,
        minimumCommitSeq = 0,
      ): LibraryEffect<A> =>
        readCoreProjectionAtLeast(
          read,
          authority.identity.storeEpoch,
          minimumCommitSeq,
          (result) =>
            result.ok
              ? {
                  store_epoch: result.value.storeEpoch,
                  commit_head: result.value.commitSeq,
                }
              : null,
        );

      return LibraryModule.of({
        read: (accessContext, request) =>
          use("library.read", projectIdForAccess(accessContext), (core) => core.read(request)),
        apply: (accessContext, request) =>
          use("library.apply", projectIdForAccess(accessContext), (core) => core.apply(request)),
        prepareFileBlob: (accessContext, operationId, idempotencySlot, bytes) =>
          useClient(
            "library.prepareFileBlob",
            projectIdForAccess(accessContext),
            (client, signal) =>
              client.prepareFileBlob({ operationId, idempotencySlot, bytes }, { signal }),
          ),
        readFileBlob: (accessContext, input) =>
          useClient("library.readFileBlob", projectIdForAccess(accessContext), (client, signal) =>
            client.readFileBlob(input, { signal }),
          ),
        readProjectPageDetail: (projectId, pageId, minimumCommitSeq) =>
          readPageDetailAtLeast(
            use("library.readProjectPageDetail", projectId, (core) =>
              core.readProjectPageDetail(projectId, pageId),
            ),
            minimumCommitSeq,
          ),
        readLibraryPageDetail: (pageId, _accessActor, minimumCommitSeq) =>
          readPageDetailAtLeast(
            use("library.readLibraryPageDetail", undefined, (core) =>
              core.readLibraryPageDetail(pageId),
            ),
            minimumCommitSeq,
          ),
        listPageHistory: (request) =>
          use("library.listPageHistory", request.requestingProjectId, (core) =>
            core.listPageHistory(request),
          ),
        searchPages: (input) =>
          use("library.searchPages", undefined, (core, signal) => core.searchPages(input, signal)),
        pageSearchMetadata: (projectIds, pageIds) =>
          use("library.pageSearchMetadata", undefined, (core) =>
            core.pageSearchMetadata(projectIds, pageIds),
          ),
        pageSearchFacets: (projectIds) =>
          use("library.pageSearchFacets", undefined, (core) => core.pageSearchFacets(projectIds)),
        resolvePageTarget: (input) =>
          use("library.resolvePageTarget", projectIdForAccess(input.accessContext), (core) =>
            core.resolvePageTarget(input),
          ),
        resolvePageOwnershipPath: (input) =>
          use("library.resolvePageOwnershipPath", projectIdForAccess(input.accessContext), (core) =>
            core.resolvePageOwnershipPath(input),
          ),
        findPageLocation: (pageId) =>
          use("library.findPageLocation", undefined, (core) => core.findPageLocation(pageId)),
        findViewLocation: (viewId) =>
          use("library.findViewLocation", undefined, (core) => core.findViewLocation(viewId)),
        readPageLifecyclePreflight: (projectId, pageId) =>
          use("library.readPageLifecyclePreflight", projectId, (core) =>
            core.readPageLifecyclePreflight(projectId, pageId),
          ),
        applyPageLifecycleMutation: (request) =>
          use("library.applyPageLifecycleMutation", request.projectId, (core) =>
            core.applyPageLifecycleMutation(request),
          ),
        applyBlockPropertyMutation: (request) =>
          use("library.applyBlockPropertyMutation", request.projectId, (core) =>
            core.applyBlockPropertyMutation(request),
          ),
        applyLibraryBlockPropertyMutation: ({ request, actor }) =>
          use("library.applyLibraryBlockPropertyMutation", undefined, (core) =>
            core.applyLibraryBlockPropertyMutation({ request, actor }),
          ),
      });
    }),
  );
