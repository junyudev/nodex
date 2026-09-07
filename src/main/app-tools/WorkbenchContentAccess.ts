import type { components } from "@nodex/core-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { ContentAccessContext } from "../../shared/content-access-context";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { NodexAgentResourceAccessOverlay } from "../../shared/nodex-agent-resource-access";
import type { WorkbenchSurfaceReference } from "../../shared/nodex-app-tools/workbench";
import { toCoreAgentExecutionAuthorization } from "../core-client/core-agent-execution-authorization";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";

export type WorkbenchContentSurface = Extract<
  WorkbenchSurfaceReference,
  { readonly kind: "page_stage" | "db_view" | "canvas_stage" }
>;

type CoreDescription = components["schemas"]["LibraryAgentSurfaceDescription"];
type AuthorizedMetadata = {
  readonly status: "authorized";
  readonly title: string;
  readonly libraryId: string;
  readonly displayedAccessContext: ContentAccessContext;
};

export type WorkbenchContentDescription =
  | Extract<CoreDescription, { readonly status: "restricted" }>
  | (AuthorizedMetadata &
      (
        | { readonly kind: "page"; readonly pageId: string }
        | {
            readonly kind: "database_view";
            readonly databaseId: string;
            readonly dataSourceId: string;
            readonly viewId: string;
            readonly layout: components["schemas"]["DatabaseViewLayout"];
          }
        | { readonly kind: "canvas"; readonly canvasId: string }
      ));

export class WorkbenchContentAccess extends Context.Service<
  WorkbenchContentAccess,
  {
    readonly describe: (input: {
      readonly authority: FrozenNodexAgentTurnAuthority;
      readonly callId: string;
      readonly taskAccess?: NodexAgentResourceAccessOverlay;
      readonly surface: WorkbenchContentSurface;
    }) => Effect.Effect<WorkbenchContentDescription>;
  }
>()("nodex/main/app-tools/WorkbenchContentAccess") {}

const coreTarget = (
  surface: WorkbenchContentSurface,
): components["schemas"]["LibraryAgentSurfaceTarget"] => {
  if (surface.kind === "page_stage") return { kind: "page", page_id: surface.config.pageId };
  if (surface.kind === "canvas_stage")
    return { kind: "canvas", canvas_id: surface.config.canvasBlockId };
  const target = surface.config.target;
  if (target.kind === "project-default")
    return { kind: "database_view", target: { kind: "project_default" } };
  if (target.kind === "database-default")
    return {
      kind: "database_view",
      target: { kind: "database_default", database_id: target.databaseId },
    };
  return {
    kind: "database_view",
    target: { kind: "view", view_id: target.databaseViewId },
  };
};

const description = (value: CoreDescription): WorkbenchContentDescription => {
  if (value.status === "restricted") return value;
  const metadata: AuthorizedMetadata = {
    status: "authorized",
    title: value.title,
    libraryId: value.library_id,
    displayedAccessContext: value.displayed_access_context,
  };
  if (value.kind === "page") return { ...metadata, kind: "page", pageId: value.page_id };
  if (value.kind === "canvas") return { ...metadata, kind: "canvas", canvasId: value.canvas_id };
  return {
    ...metadata,
    kind: "database_view",
    databaseId: value.database_id,
    dataSourceId: value.data_source_id,
    viewId: value.view_id,
    layout: value.layout,
  };
};

export const make = Effect.gen(function* () {
  const identity = yield* CoreAuthority;
  const core = yield* CoreModules;
  return WorkbenchContentAccess.of({
    describe: Effect.fn("WorkbenchContentAccess.describe")((input) =>
      core.library
        .read(
          {
            kind: "agent_surface_description",
            authorization: toCoreAgentExecutionAuthorization(
              identity.identity.profileId,
              input.authority,
              input.callId,
              input.taskAccess,
            ),
            displayed_access_context: input.surface.config.accessContext,
            target: coreTarget(input.surface),
          },
          { deadlineMs: 5_000 },
          input.authority.actorProjectId,
        )
        .pipe(
          Effect.map((snapshot): WorkbenchContentDescription =>
            snapshot.value.kind === "agent_surface_description"
              ? description(snapshot.value.value)
              : { status: "restricted", reason: "unavailable" },
          ),
          Effect.catch((error) =>
            Effect.succeed<WorkbenchContentDescription>({
              status: "restricted",
              reason:
                error.cause instanceof CoreModuleResponseError &&
                error.cause.coreError.code === "unauthorized"
                  ? "access_denied"
                  : "unavailable",
            }),
          ),
        ),
    ),
  });
});
