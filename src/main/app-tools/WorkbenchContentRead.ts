import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { contentAccessContextKey } from "../../shared/content-access-context";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { NodexAgentResourceAccessOverlay } from "../../shared/nodex-agent-resource-access";
import type { WorkbenchSceneReference } from "../../shared/nodex-app-tools/workbench";
import type { WorkbenchPreparedPageContent } from "../../shared/nodex-app-tools/workbench-content";
import { BlockIdSchema } from "../../shared/nodex-agent-tools/base-schemas";
import type {
  NativeNodexAgentFetchObservation,
  NativeNodexAgentFetchRequest,
} from "../core-client/native-nodex-agent-fetch";
import { NodexAgentApplication } from "../nodex-agent-application/NodexAgentApplication";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import type { WorkbenchContentDescription } from "./WorkbenchContentAccess";
import {
  make as makeViewContentRead,
  type WorkbenchViewContentReadResult,
} from "./WorkbenchViewContentRead";

type PageObservation = Extract<NativeNodexAgentFetchObservation, { readonly ok: true }>;
type AuthorizedDescription = Extract<
  WorkbenchContentDescription,
  { readonly status: "authorized" }
>;

export interface WorkbenchContentReadInput {
  readonly authority: FrozenNodexAgentTurnAuthority;
  readonly callId: string;
  readonly taskAccess?: NodexAgentResourceAccessOverlay;
  readonly description: WorkbenchContentDescription;
  readonly live?: {
    readonly reference: WorkbenchSceneReference;
    readonly tabId: string;
    readonly expectedPresentationRevision: number;
  };
  readonly format?: NativeNodexAgentFetchRequest["input"]["format"];
  readonly page?: NativeNodexAgentFetchRequest["input"]["page"];
  readonly range?: "viewport" | "loaded" | "selected";
  readonly offset?: number;
  readonly limit?: number;
  readonly propertyIds?: readonly string[];
  readonly isCurrent: Effect.Effect<boolean>;
}

export type WorkbenchContentReadResult =
  | WorkbenchViewContentReadResult
  | {
      readonly status: "ready";
      readonly kind: "page";
      readonly readiness: "canonical" | "synchronized";
      readonly output: PageObservation["output"];
      readonly document: PageObservation["document"];
      readonly validators: PageObservation["validators"];
      readonly synchronization?: {
        readonly editorSurfaceId: string;
        readonly preparedAt: string;
        readonly checkedAt: string;
        readonly localEditRevision: number;
      };
    }
  | {
      readonly status: "ready";
      readonly kind: "canvas";
      readonly readiness: "metadata_only";
      readonly description: Extract<AuthorizedDescription, { readonly kind: "canvas" }>;
    }
  | {
      readonly status:
        | "access_denied"
        | "unavailable"
        | "pending_local_edits"
        | "stale_presentation"
        | "surface_unavailable"
        | "cancelled"
        | "result_too_large";
    }
  | {
      readonly status: "failed";
      readonly error: Extract<NativeNodexAgentFetchObservation, { readonly ok: false }>["error"];
    };

export class WorkbenchContentRead extends Context.Service<
  WorkbenchContentRead,
  {
    readonly read: (input: WorkbenchContentReadInput) => Effect.Effect<WorkbenchContentReadResult>;
    readonly query: (
      input: WorkbenchContentReadInput,
    ) => Effect.Effect<WorkbenchViewContentReadResult>;
  }
>()("nodex/main/app-tools/WorkbenchContentRead") {}

const preparedFor = (
  prepared: WorkbenchPreparedPageContent,
  description: Extract<AuthorizedDescription, { readonly kind: "page" }>,
  authority: FrozenNodexAgentTurnAuthority,
) =>
  prepared.pageId === description.pageId &&
  prepared.libraryId === description.libraryId &&
  prepared.libraryId === authority.libraryId &&
  prepared.storeEpoch === authority.storeEpoch &&
  contentAccessContextKey(prepared.accessContext) ===
    contentAccessContextKey(description.displayedAccessContext);

const matchesFence = (observation: PageObservation, prepared: WorkbenchPreparedPageContent) =>
  observation.document.documentId === prepared.documentId &&
  observation.document.ownerPageId === prepared.pageId &&
  observation.document.targetBlockId === prepared.pageId &&
  observation.document.storeEpoch === prepared.storeEpoch &&
  observation.document.generation === prepared.generation &&
  observation.document.headSeq >= prepared.expectedHeadSeq;

/** Reads canonical content, claiming live synchronization only after the exact editor revalidates. */
export const make = Effect.gen(function* () {
  const bridge = yield* WorkbenchAgentBridge;
  const application = yield* NodexAgentApplication;
  const readView = yield* makeViewContentRead;

  const readPage = Effect.fn("WorkbenchContentRead.readPage")(function* (
    input: WorkbenchContentReadInput,
    description: Extract<AuthorizedDescription, { readonly kind: "page" }>,
  ): Effect.fn.Return<WorkbenchContentReadResult> {
    const id = BlockIdSchema.safeParse(description.pageId);
    if (!id.success) return { status: "unavailable" };
    let prepared: WorkbenchPreparedPageContent | undefined;
    if (input.live) {
      const result = yield* bridge
        .request(input.live.reference, {
          kind: "prepare_content",
          sceneOwner: input.live.reference.sceneOwner,
          tabId: input.live.tabId,
          expectedPresentationRevision: input.live.expectedPresentationRevision,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.succeed({
              kind: "prepare_content" as const,
              preparation: {
                status:
                  error.reason === "cancelled"
                    ? ("cancelled" as const)
                    : ("surface_unavailable" as const),
              },
            }),
          ),
        );
      if (!(yield* input.isCurrent)) return { status: "cancelled" };
      if (result.preparation.status !== "ready") return result.preparation;
      prepared = result.preparation;
      if (!preparedFor(prepared, description, input.authority))
        return { status: "stale_presentation" };
    }
    const observation = yield* application
      .readPageObservation({
        tool: "fetch",
        projectId: input.authority.actorProjectId,
        authority: input.authority,
        callId: input.callId,
        ...(input.taskAccess ? { resourceAccess: input.taskAccess } : {}),
        input: {
          id: id.data,
          format: input.format ?? "markdown",
          includeDataSource: false,
          ...(input.page ? { page: input.page } : {}),
        },
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!(yield* input.isCurrent)) return { status: "cancelled" };
    if (!observation) return { status: "unavailable" };
    if (!observation.ok) return { status: "failed", error: observation.error };
    if (
      observation.document.ownerPageId !== description.pageId ||
      observation.document.targetBlockId !== description.pageId ||
      observation.document.storeEpoch !== input.authority.storeEpoch
    )
      return { status: "unavailable" };
    const content = observation.output.data.content;
    if (!content) return { status: "unavailable" };
    if (content.format === "markdown" && Buffer.byteLength(content.markdown, "utf8") > 64 * 1024)
      return { status: "result_too_large" };
    const result = {
      status: "ready" as const,
      kind: "page" as const,
      output: observation.output,
      document: observation.document,
      validators: observation.validators,
    };
    if (!prepared || !input.live) return { ...result, readiness: "canonical" };
    if (!matchesFence(observation, prepared)) return { status: "stale_presentation" };
    const validation = yield* bridge
      .request(input.live.reference, {
        kind: "validate_content",
        token: prepared.token,
      })
      .pipe(
        Effect.map((reply) => reply.validation),
        Effect.catch(() => Effect.succeed({ status: "surface_unavailable" as const })),
      );
    if (!(yield* input.isCurrent)) return { status: "cancelled" };
    if (validation.status === "expired") return { status: "stale_presentation" };
    if (validation.status !== "synchronized") return validation;
    if (
      validation.token !== prepared.token ||
      validation.localEditRevision !== prepared.localEditRevision ||
      observation.document.headSeq < validation.headSeq
    )
      return { status: "stale_presentation" };
    return {
      ...result,
      readiness: "synchronized",
      synchronization: {
        editorSurfaceId: prepared.editorSurfaceId,
        preparedAt: prepared.preparedAt,
        checkedAt: validation.checkedAt,
        localEditRevision: validation.localEditRevision,
      },
    };
  });

  return WorkbenchContentRead.of({
    query: (input) => readView(input, "effective_query"),
    read: Effect.fn("WorkbenchContentRead.read")(function* (input) {
      if (!(yield* input.isCurrent)) return { status: "cancelled" as const };
      const description = input.description;
      if (description.status === "restricted")
        return {
          status:
            description.reason === "access_denied"
              ? ("access_denied" as const)
              : ("unavailable" as const),
        };
      if (description.libraryId !== input.authority.libraryId)
        return { status: "access_denied" as const };
      if (description.kind === "page") return yield* readPage(input, description);
      if (description.kind === "canvas")
        return {
          status: "ready" as const,
          kind: "canvas" as const,
          readiness: "metadata_only" as const,
          description,
        };
      return yield* readView(input, "display");
    }),
  });
});
