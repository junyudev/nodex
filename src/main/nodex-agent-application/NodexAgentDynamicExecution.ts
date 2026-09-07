import type {
  AgentDocumentEditEffects,
  NodexAgentAuthorizationPreview,
  NodexAgentPageUpdateOutput,
  NodexAgentCreatePagesCommand,
  NodexAgentDuplicatePageCommand,
  NodexAgentMovePagesCommand,
  NodexAgentTransferAuthorizationEvidence,
  ToolFailure,
} from "../../shared/nodex-agent-tools";
import type {
  NodexAgentResourceAccessOverlay,
  NodexAgentResourceGrantSpec,
  NodexAgentResourceIntent,
} from "../../shared/nodex-agent-resource-access";
import * as Effect from "effect/Effect";
import { type NodexAgentV3ToolInput } from "../codex/nodex-dynamic-tool-registry";
import { NodexAgentApplication, type NodexAgentApplicationFailure } from "./NodexAgentApplication";
import {
  authorizationFootprint,
  type NodexAgentAuthorizationFootprint,
} from "../agent-tools/authorization-footprint";
import {
  authorizeNodexAgentResourceIntents,
  fail,
  NodexAgentDynamicToolFailure,
  prepareAuthorizedWrite,
  actorProject,
  toolFailure,
  withExecutionTimeout,
  type NodexAgentDynamicExecutionContext,
} from "./NodexAgentDynamicPolicy";

const NODEX_AGENT_EXECUTION_TIMEOUT_MS = 30_000;
const MAX_AUTHORIZATION_MARKDOWN_PREVIEW_CHARS = 1_600;

type PageDestination =
  | { readonly kind: "library" }
  | { readonly kind: "page"; readonly pageId: string }
  | { readonly kind: "data_source"; readonly dataSourceId: string };

type PageUpdateInput =
  | NodexAgentV3ToolInput<"update_page">
  | NodexAgentV3ToolInput<"advanced_update_page">;

function destinationLabel(destination: PageDestination): string {
  if (destination.kind === "library") return "Library";
  if (destination.kind === "page") return `Page ${destination.pageId}`;
  return `Data Source ${destination.dataSourceId}`;
}

function destinationResource(destination: PageDestination): string {
  if (destination.kind === "library") return "library";
  if (destination.kind === "page") return `page:${destination.pageId}`;
  return `data_source:${destination.dataSourceId}`;
}

function destinationIntent(
  destination: PageDestination,
  libraryId: string,
): NodexAgentResourceIntent {
  if (destination.kind === "library") {
    return {
      target: { kind: "library", libraryId },
      action: "create_child",
    };
  }
  if (destination.kind === "page") {
    return {
      target: { kind: "page", pageId: destination.pageId },
      action: "create_child",
    };
  }
  return {
    target: { kind: "data_source", dataSourceId: destination.dataSourceId },
    action: "create_child",
  };
}

function readPreview(
  title: string,
  summary: string,
  label: string,
  value: string,
): NodexAgentAuthorizationPreview {
  return {
    title,
    summary,
    details: [{ label, value }],
  };
}

function searchIntents(
  input: NodexAgentV3ToolInput<"search">,
): readonly NodexAgentResourceIntent[] {
  const scope = input.scope;
  if (!scope || scope.kind === "library") return [];
  if (scope.kind === "page") {
    return [
      {
        target: { kind: "page", pageId: scope.pageId },
        action: "read",
      },
    ];
  }
  if (scope.kind === "database") {
    return [
      {
        target: { kind: "database", databaseId: scope.databaseId },
        action: "read",
      },
    ];
  }
  return [
    {
      target: { kind: "data_source", dataSourceId: scope.dataSourceId },
      action: "read",
    },
  ];
}

function boundedMarkdownPreview(markdown: string): string | undefined {
  const normalized = markdown.trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_AUTHORIZATION_MARKDOWN_PREVIEW_CHARS) return normalized;
  return `${normalized.slice(0, MAX_AUTHORIZATION_MARKDOWN_PREVIEW_CHARS)}\n…`;
}

function recordTopLevelTaskPages(
  context: NodexAgentDynamicExecutionContext,
  destination: PageDestination,
  resourceAccess: NodexAgentResourceAccessOverlay | undefined,
  pageIds: readonly string[],
): Effect.Effect<void> {
  if (
    destination.kind !== "library" ||
    resourceAccess?.scope !== "task" ||
    !context.recordTaskResourceAccess
  )
    return Effect.void;
  const grants: NodexAgentResourceGrantSpec[] = pageIds.map((pageId) => ({
    root: { kind: "page", pageId },
    access: "read_write",
  }));
  return context.recordTaskResourceAccess(grants);
}

function createPagesPreview(
  input: NodexAgentV3ToolInput<"create_pages">,
  pages: readonly {
    readonly title: string;
    readonly bodyBlockCount: number;
    readonly targetMarkdown: string;
  }[],
): NodexAgentAuthorizationPreview {
  const blocks = pages.reduce((total, page) => total + page.bodyBlockCount, 0);
  const preview = boundedMarkdownPreview(
    pages
      .map((page) => [`# ${page.title}`, page.targetMarkdown].filter(Boolean).join("\n\n"))
      .join("\n\n---\n\n"),
  );
  return {
    title: `Create ${pages.length} Page${pages.length === 1 ? "" : "s"}`,
    summary: `Create ${pages.length} complete Page${pages.length === 1 ? "" : "s"} with ${blocks} body Block${blocks === 1 ? "" : "s"}.`,
    details: [
      { label: "Destination", value: destinationLabel(input.destination) },
      { label: "Pages", value: pages.map((page) => page.title).join(", ") },
    ],
    ...(preview ? { markdownPreview: preview } : {}),
  };
}

function pageUpdatePreview(
  tool: "update_page" | "advanced_update_page",
  input: PageUpdateInput,
  effects: AgentDocumentEditEffects,
  targetMarkdown: string,
): NodexAgentAuthorizationPreview {
  const counts = [
    effects.createdBlockIds.length > 0 ? `${effects.createdBlockIds.length} create` : null,
    effects.updatedBlockIds.length > 0 ? `${effects.updatedBlockIds.length} update` : null,
    effects.movedBlockIds.length > 0 ? `${effects.movedBlockIds.length} move` : null,
    effects.deletedBlockIds.length > 0 ? `${effects.deletedBlockIds.length} delete` : null,
    tool === "update_page" && "title" in input && input.title ? "title update" : null,
  ].filter((entry): entry is string => entry !== null);
  const preview = boundedMarkdownPreview(targetMarkdown);
  return {
    title: tool === "update_page" ? "Update Page" : "Advanced Page update",
    summary: counts.length > 0 ? counts.join(", ") : "Update Page content.",
    details: [
      { label: "Page", value: input.pageId },
      ...(tool === "update_page" && "body" in input && input.body
        ? [{ label: "Method", value: input.body.kind }]
        : []),
    ],
    ...(preview ? { markdownPreview: preview } : {}),
  };
}

function movePagesPreview(
  input: NodexAgentV3ToolInput<"move_pages">,
  authorization: NodexAgentTransferAuthorizationEvidence,
): NodexAgentAuthorizationPreview {
  return {
    title: `Move ${input.pageIds.length} Page${input.pageIds.length === 1 ? "" : "s"}`,
    summary: "Move the selected Pages and their complete owned content atomically.",
    details: [
      { label: "Destination", value: destinationLabel(input.destination) },
      { label: "Pages", value: input.pageIds.join(", ") },
      ...(authorization.documentIds.length > 0
        ? [
            {
              label: "Document scope",
              value: `${authorization.documentIds.length} Document${authorization.documentIds.length === 1 ? "" : "s"}`,
            },
          ]
        : []),
    ],
  };
}

function duplicatePagePreview(
  input: NodexAgentV3ToolInput<"duplicate_page">,
  authorization: NodexAgentTransferAuthorizationEvidence,
): NodexAgentAuthorizationPreview {
  return {
    title: "Duplicate Page",
    summary: "Copy the complete Page ownership subtree with fresh identities.",
    details: [
      { label: "Source Page", value: input.pageId },
      { label: "Destination", value: destinationLabel(input.destination) },
      ...(authorization.documentIds.length > 0
        ? [
            {
              label: "Document scope",
              value: `${authorization.documentIds.length} Document${authorization.documentIds.length === 1 ? "" : "s"}`,
            },
          ]
        : []),
    ],
  };
}

function createPagesFootprint(
  projectId: string | null,
  command: NodexAgentCreatePagesCommand,
): NodexAgentAuthorizationFootprint {
  return authorizationFootprint({
    tool: "create_pages",
    projectId,
    effect: "write",
    resources: [
      destinationResource(command.input.destination),
      ...command.pages.map((page) => `page:${page.pageId}`),
    ],
    deletions: [],
    transformations: command.pages.map(
      (page) =>
        `page.create:${page.pageId}:body-blocks:${page.bodyBlockIds.length}:${command.input.destination.kind}`,
    ),
  });
}

function pageUpdateFootprint(
  projectId: string | null,
  tool: "update_page" | "advanced_update_page",
  input: PageUpdateInput,
  effects: AgentDocumentEditEffects,
): NodexAgentAuthorizationFootprint {
  const destructive =
    effects.deletedBlockIds.length > 0 ||
    (tool === "update_page" && "body" in input && input.body?.kind === "replace");
  return authorizationFootprint({
    tool,
    projectId,
    effect: destructive ? "destructive" : "write",
    resources: [
      `page:${input.pageId}`,
      ...effects.createdBlockIds.map((id) => `block:${id}`),
      ...effects.updatedBlockIds.map((id) => `block:${id}`),
      ...effects.movedBlockIds.map((id) => `block:${id}`),
      ...effects.deletedBlockIds.map((id) => `block:${id}`),
    ],
    deletions: [
      ...effects.deletedBlockIds.map((id) => `block:${id}`),
      ...effects.deletedOwnerBlockIds.map((id) => `owner:${id}`),
    ],
    transformations:
      tool === "update_page"
        ? [
            ...("title" in input && input.title ? ["title.set"] : []),
            ...("body" in input && input.body ? [`body.${input.body.kind}`] : []),
          ]
        : ["stable-block-edits"],
  });
}

function movePagesFootprint(
  projectId: string | null,
  command: NodexAgentMovePagesCommand,
): NodexAgentAuthorizationFootprint {
  return authorizationFootprint({
    tool: "move_pages",
    projectId,
    effect: "write",
    resources: [
      destinationResource(command.input.destination),
      ...command.input.pageIds.map((pageId) => `page:${pageId}`),
      ...command.documentHeads.map((head) => `document:${head.documentId}`),
    ],
    deletions: [],
    transformations: command.transfers.map((step) => {
      if (step.normalizedInput.mode !== "move") {
        throw new Error("Prepared Page move contains a non-move transfer");
      }
      return `page.move:${step.pageId}:${step.normalizedInput.from.kind}->${command.input.destination.kind}`;
    }),
  });
}

function duplicatePageFootprint(
  projectId: string | null,
  command: NodexAgentDuplicatePageCommand,
): NodexAgentAuthorizationFootprint {
  return authorizationFootprint({
    tool: "duplicate_page",
    projectId,
    effect: "write",
    resources: [
      `page:${command.input.pageId}`,
      destinationResource(command.input.destination),
      ...command.documentHeads.map((head) => `document:${head.documentId}`),
    ],
    deletions: [],
    transformations: [`page.duplicate:${command.input.pageId}:${command.input.destination.kind}`],
  });
}

function mapDocumentMutationFailure(error: {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}): ToolFailure {
  const conflict = error.code.includes("conflict");
  return toolFailure(
    conflict ? "conflict" : "internal_error",
    error.message,
    conflict ? "fetch_again" : "retry_same",
    error.retryable,
  );
}

const executePageUpdate = (
  tool: "update_page" | "advanced_update_page",
  input: PageUpdateInput,
  context: NodexAgentDynamicExecutionContext,
  application: NodexAgentApplication["Service"],
  executionTimeoutMs: number,
): Effect.Effect<
  NodexAgentPageUpdateOutput,
  NodexAgentApplicationFailure | NodexAgentDynamicToolFailure
> =>
  Effect.gen(function* () {
    const projectId = actorProject(context);
    const prepared = yield* prepareAuthorizedWrite(context, {
      intents: [
        {
          target: { kind: "page", pageId: input.pageId },
          action: "write",
        },
      ],
      prepare: (resourceAccess) => {
        const identity = {
          threadId: context.threadId,
          callId: context.callId,
          operationId: context.operationId,
          projectId,
          authority: context.authority ?? undefined,
          ...(resourceAccess ? { resourceAccess } : {}),
        };
        const request =
          tool === "update_page"
            ? {
                ...identity,
                tool,
                input: input as NodexAgentV3ToolInput<"update_page">,
              }
            : {
                ...identity,
                tool,
                input: input as NodexAgentV3ToolInput<"advanced_update_page">,
              };
        return application.prepare({ kind: "page_update", request }).pipe(
          Effect.map((prepared) => {
            if (prepared.kind !== "page_update") throw new Error("Nodex preparation mismatch");
            const result = prepared.value.result;
            if (!result.ok) return fail({ error: result.error });
            return result.value;
          }),
        );
      },
      footprint: (value) => pageUpdateFootprint(projectId, tool, input, value.effects),
      authorization: (value) => ({
        tool,
        preview: pageUpdatePreview(tool, input, value.effects, value.targetMarkdown),
      }),
    });
    if (prepared.kind === "completed") return prepared.output;
    const mutationResult = yield* withExecutionTimeout(
      application.apply({ kind: "document_mutation", request: prepared.mutation }).pipe(
        Effect.map((result) => {
          if (result.kind !== "document_mutation") {
            throw new Error("Nodex application result mismatch");
          }
          return result.value;
        }),
      ),
      executionTimeoutMs,
    );
    if (!mutationResult.ok) return fail(mapDocumentMutationFailure(mutationResult.error));
    const completed = (yield* application.completePageUpdate({
      tool,
      threadId: context.threadId,
      callId: context.callId,
      operationId: context.operationId,
      projectId,
      authority: context.authority ?? undefined,
      ...(prepared.resourceAccess ? { resourceAccess: prepared.resourceAccess } : {}),
      pageId: input.pageId,
      result: mutationResult.value,
    })).result;
    if (!completed.ok) return fail({ error: completed.error });
    return completed.output;
  });

export const executeNodexAgentV3Tool = (
  tool: string,
  input: unknown,
  context: NodexAgentDynamicExecutionContext,
  options?: { readonly executionTimeoutMs?: number },
): Effect.Effect<
  unknown,
  NodexAgentApplicationFailure | NodexAgentDynamicToolFailure,
  NodexAgentApplication
> =>
  Effect.gen(function* () {
    const application = yield* NodexAgentApplication;
    const executionTimeoutMs = options?.executionTimeoutMs ?? NODEX_AGENT_EXECUTION_TIMEOUT_MS;
    switch (tool) {
      case "get_context": {
        const parsed = input as NodexAgentV3ToolInput<"get_context">;
        const result = (yield* application.read({
          tool,
          callId: context.callId,
          projectId: context.authority?.actorProjectId ?? null,
          authority: context.authority ?? undefined,
          resourceAccess: context.resourceAccess,
          access: context.access,
          input: parsed,
        })).result;
        if (!result.ok) return fail({ error: result.error });
        if (result.tool !== tool) throw new Error("Nodex v3 read tool mismatch");
        return result.output;
      }
      case "search": {
        const parsed = input as NodexAgentV3ToolInput<"search">;
        const intents = searchIntents(parsed);
        const resourceAccess =
          intents.length > 0
            ? yield* authorizeNodexAgentResourceIntents(context, {
                intents,
                tool,
                effect: "read",
                preview: readPreview(
                  "Search this Nodex resource",
                  "Search Pages and Blocks inside the requested resource.",
                  "Scope",
                  parsed.scope?.kind ?? "authorized Library resources",
                ),
              })
            : context.resourceAccess;
        const result = (yield* application.read({
          tool,
          callId: context.callId,
          projectId: actorProject(context),
          authority: context.authority ?? undefined,
          ...(resourceAccess ? { resourceAccess } : {}),
          input: parsed,
        })).result;
        if (!result.ok) return fail({ error: result.error });
        if (result.tool !== tool) throw new Error("Nodex v3 read tool mismatch");
        return result.output;
      }
      case "fetch": {
        const parsed = input as NodexAgentV3ToolInput<"fetch">;
        const resourceAccess = yield* authorizeNodexAgentResourceIntents(context, {
          intents: [{ target: { kind: "page_or_block", id: parsed.id }, action: "read" }],
          tool,
          effect: "read",
          preview: readPreview(
            "Read this Nodex Page or Block",
            "Read the requested content and its current metadata.",
            "Resource",
            parsed.id,
          ),
        });
        const result = (yield* application.read({
          tool,
          callId: context.callId,
          projectId: actorProject(context),
          authority: context.authority ?? undefined,
          ...(resourceAccess ? { resourceAccess } : {}),
          input: parsed,
        })).result;
        if (!result.ok) return fail({ error: result.error });
        if (result.tool !== tool) throw new Error("Nodex v3 read tool mismatch");
        return result.output;
      }
      case "query_database_view":
      case "query_data_source": {
        const parsed = input as
          | NodexAgentV3ToolInput<"query_database_view">
          | NodexAgentV3ToolInput<"query_data_source">;
        const isView = tool === "query_database_view";
        const resourceAccess = yield* authorizeNodexAgentResourceIntents(context, {
          intents: [
            isView
              ? {
                  target: {
                    kind: "view",
                    viewId: (parsed as NodexAgentV3ToolInput<"query_database_view">).viewId,
                  },
                  action: "read",
                }
              : {
                  target: {
                    kind: "data_source",
                    dataSourceId: (parsed as NodexAgentV3ToolInput<"query_data_source">)
                      .dataSourceId,
                  },
                  action: "read",
                },
          ],
          tool,
          effect: "read",
          preview: readPreview(
            isView ? "Query this Nodex View" : "Query this Nodex Data Source",
            isView
              ? "Read rows and properties from the requested Database View."
              : "Read rows and properties from the requested Data Source.",
            isView ? "View" : "Data Source",
            isView
              ? (parsed as NodexAgentV3ToolInput<"query_database_view">).viewId
              : (parsed as NodexAgentV3ToolInput<"query_data_source">).dataSourceId,
          ),
        });
        const result = (yield* application.read({
          tool,
          callId: context.callId,
          projectId: actorProject(context),
          authority: context.authority ?? undefined,
          ...(resourceAccess ? { resourceAccess } : {}),
          input: parsed as never,
        })).result;
        if (!result.ok) return fail({ error: result.error });
        if (result.tool !== tool) throw new Error("Nodex v3 read tool mismatch");
        return result.output;
      }
      case "create_pages": {
        const parsed = input as NodexAgentV3ToolInput<"create_pages">;
        const projectId = actorProject(context);
        const prepared = yield* prepareAuthorizedWrite(context, {
          intents: [destinationIntent(parsed.destination, context.authority?.libraryId ?? "")],
          prepare: (resourceAccess) =>
            application
              .prepare({
                kind: "create_pages",
                request: {
                  threadId: context.threadId,
                  callId: context.callId,
                  operationId: context.operationId,
                  projectId,
                  authority: context.authority ?? undefined,
                  ...(resourceAccess ? { resourceAccess } : {}),
                  input: parsed,
                },
              })
              .pipe(
                Effect.map((preparation) => {
                  if (preparation.kind !== "create_pages")
                    throw new Error("Nodex preparation mismatch");
                  const result = preparation.value.result;
                  if (!result.ok) return fail({ error: result.error });
                  return result.value;
                }),
              ),
          footprint: (value) => createPagesFootprint(projectId, value.command),
          authorization: (value) => ({
            tool,
            preview: createPagesPreview(parsed, value.previews),
          }),
        });
        if (prepared.kind === "completed") return prepared.output;
        const applied = yield* withExecutionTimeout(
          application.apply({
            kind: "create_pages",
            command: prepared.command,
            documentHeads: prepared.documentHeads,
          }),
          executionTimeoutMs,
        );
        if (applied.kind !== "create_pages") throw new Error("Nodex application result mismatch");
        if (!applied.value.ok) return fail({ error: applied.value.error });
        yield* recordTopLevelTaskPages(
          context,
          parsed.destination,
          prepared.command.resourceAccess,
          applied.value.value.output.data.pages.map((page) => page.pageId),
        );
        return applied.value.value.output;
      }
      case "update_page":
        return yield* executePageUpdate(
          tool,
          input as NodexAgentV3ToolInput<"update_page">,
          context,
          application,
          executionTimeoutMs,
        );
      case "advanced_update_page":
        return yield* executePageUpdate(
          tool,
          input as NodexAgentV3ToolInput<"advanced_update_page">,
          context,
          application,
          executionTimeoutMs,
        );
      case "move_pages": {
        const parsed = input as NodexAgentV3ToolInput<"move_pages">;
        const projectId = actorProject(context);
        const prepared = yield* prepareAuthorizedWrite(context, {
          intents: [
            ...parsed.pageIds.map((pageId) => ({
              target: { kind: "page" as const, pageId },
              action: "move" as const,
            })),
            destinationIntent(parsed.destination, context.authority?.libraryId ?? ""),
          ],
          prepare: (resourceAccess) =>
            application
              .prepare({
                kind: "move_pages",
                request: {
                  threadId: context.threadId,
                  callId: context.callId,
                  operationId: context.operationId,
                  projectId,
                  authority: context.authority ?? undefined,
                  ...(resourceAccess ? { resourceAccess } : {}),
                  input: parsed,
                },
              })
              .pipe(
                Effect.map((preparation) => {
                  if (preparation.kind !== "move_pages")
                    throw new Error("Nodex preparation mismatch");
                  const result = preparation.value.result;
                  if (!result.ok) return fail({ error: result.error });
                  return result.value;
                }),
              ),
          footprint: (value) => movePagesFootprint(projectId, value.command),
          authorization: (value) => ({
            tool,
            preview: movePagesPreview(parsed, value.authorization),
          }),
        });
        if (prepared.kind === "completed") return prepared.output;
        const applied = yield* withExecutionTimeout(
          application.apply({ kind: "move_pages", command: prepared.command }),
          executionTimeoutMs,
        );
        if (applied.kind !== "move_pages") throw new Error("Nodex application result mismatch");
        if (!applied.value.ok) return fail({ error: applied.value.error });
        yield* recordTopLevelTaskPages(
          context,
          parsed.destination,
          prepared.command.resourceAccess,
          applied.value.value.output.data.pages.map((page) => page.pageId),
        );
        return applied.value.value.output;
      }
      case "duplicate_page": {
        const parsed = input as NodexAgentV3ToolInput<"duplicate_page">;
        const projectId = actorProject(context);
        const prepared = yield* prepareAuthorizedWrite(context, {
          intents: [
            { target: { kind: "page", pageId: parsed.pageId }, action: "read" },
            destinationIntent(parsed.destination, context.authority?.libraryId ?? ""),
          ],
          prepare: (resourceAccess) =>
            application
              .prepare({
                kind: "duplicate_page",
                request: {
                  threadId: context.threadId,
                  callId: context.callId,
                  operationId: context.operationId,
                  projectId,
                  authority: context.authority ?? undefined,
                  ...(resourceAccess ? { resourceAccess } : {}),
                  input: parsed,
                },
              })
              .pipe(
                Effect.map((preparation) => {
                  if (preparation.kind !== "duplicate_page")
                    throw new Error("Nodex preparation mismatch");
                  const result = preparation.value.result;
                  if (!result.ok) return fail({ error: result.error });
                  return result.value;
                }),
              ),
          footprint: (value) => duplicatePageFootprint(projectId, value.command),
          authorization: (value) => ({
            tool,
            preview: duplicatePagePreview(parsed, value.authorization),
          }),
        });
        if (prepared.kind === "completed") return prepared.output;
        const applied = yield* withExecutionTimeout(
          application.apply({ kind: "duplicate_page", command: prepared.command }),
          executionTimeoutMs,
        );
        if (applied.kind !== "duplicate_page") throw new Error("Nodex application result mismatch");
        if (!applied.value.ok) return fail({ error: applied.value.error });
        yield* recordTopLevelTaskPages(
          context,
          parsed.destination,
          prepared.command.resourceAccess,
          [applied.value.value.output.data.pageId],
        );
        return applied.value.value.output;
      }
      default:
        throw new Error(`Unsupported Nodex dynamic tool: ${tool}`);
    }
  });
