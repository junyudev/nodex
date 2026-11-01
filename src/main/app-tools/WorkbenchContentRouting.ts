import type { components } from "@nodex/core-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { ContentRoutingContext } from "../../shared/content-routing-context";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type { WorkbenchSurfaceReference } from "../../shared/nodex-app-tools/workbench";
import { toCoreAgentExecutionAuthorization } from "../core-client/core-agent-execution-authorization";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";

export type WorkbenchContentSurface = Extract<
  WorkbenchSurfaceReference,
  { readonly kind: "page_stage" | "db_view" | "canvas_stage" }
>;

type CoreDescription = components["schemas"]["LibraryAgentSurfaceDescription"];
type AvailableMetadata = {
  readonly status: "available";
  readonly title: string;
  readonly libraryId: string;
  readonly displayedRoutingContext: ContentRoutingContext;
};

export type WorkbenchContentDescription =
  | Extract<CoreDescription, { readonly status: "unavailable" }>
  | (AvailableMetadata &
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

export type WorkbenchPageFileDescription =
  | { readonly status: "unavailable" }
  | (AvailableMetadata & {
      readonly kind: "page_file";
      readonly pageId: string;
      readonly pageTitle: string;
      readonly fileId: string;
      readonly logicalPath: string | null;
    });

export class WorkbenchContentRouting extends Context.Service<
  WorkbenchContentRouting,
  {
    readonly describePageFile: (input: {
      readonly authority: NodexAgentTurnContext;
      readonly callId: string;
      readonly surface: Extract<WorkbenchSurfaceReference, { readonly kind: "page_file" }>;
    }) => Effect.Effect<WorkbenchPageFileDescription>;
    readonly describe: (input: {
      readonly authority: NodexAgentTurnContext;
      readonly callId: string;

      readonly surface: WorkbenchContentSurface;
    }) => Effect.Effect<WorkbenchContentDescription>;
  }
>()("nodex/main/app-tools/WorkbenchContentRouting") {}

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
  if (value.status === "unavailable") return value;
  const metadata: AvailableMetadata = {
    status: "available",
    title: value.title,
    libraryId: value.library_id,
    displayedRoutingContext: value.displayed_routing_context,
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
  const describe = Effect.fn("WorkbenchContentRouting.describe")(
    (input: Parameters<WorkbenchContentRouting["Service"]["describe"]>[0]) =>
      core.library
        .read(
          {
            kind: "agent_surface_description",
            authorization: toCoreAgentExecutionAuthorization(
              identity.identity.profileId,
              input.authority,
              input.callId,
            ),
            displayed_routing_context: input.surface.config.routingContext,
            target: coreTarget(input.surface),
          },
          { deadlineMs: 5_000 },
          input.authority.actorProjectId,
        )
        .pipe(
          Effect.map((snapshot): WorkbenchContentDescription =>
            snapshot.value.kind === "agent_surface_description"
              ? description(snapshot.value.value)
              : { status: "unavailable" },
          ),
          Effect.catch(() =>
            Effect.succeed<WorkbenchContentDescription>({ status: "unavailable" }),
          ),
        ),
  );
  return WorkbenchContentRouting.of({
    describe,
    describePageFile: Effect.fn("WorkbenchContentRouting.describePageFile")(function* (input) {
      const config = input.surface.config;
      const page = yield* describe({
        ...input,
        surface: {
          ...input.surface,
          kind: "page_stage",
          config: { routingContext: config.routingContext, pageId: config.pageId },
        },
      });
      if (page.status !== "available" || page.kind !== "page") return { status: "unavailable" };
      const resolved = yield* core.library
        .read(
          {
            kind: "resolve_page_file",
            page_id: config.pageId,
            selector: { kind: "file_id", file_id: config.fileId },
          },
          { deadlineMs: 5_000 },
          input.authority.actorProjectId,
        )
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (
        resolved?.value.kind !== "resolved_page_file" ||
        resolved.value.value.file.lifecycle !== "live"
      )
        return { status: "unavailable" };
      const item = resolved.value.value;
      return {
        status: "available",
        kind: "page_file",
        libraryId: item.file.library_id,
        displayedRoutingContext: page.displayedRoutingContext,
        pageId: page.pageId,
        pageTitle: page.title,
        fileId: item.file.file_id,
        logicalPath: item.logical_path ?? null,
        title: item.logical_path?.split("/").at(-1) ?? item.file.default_name,
      };
    }),
  });
});
