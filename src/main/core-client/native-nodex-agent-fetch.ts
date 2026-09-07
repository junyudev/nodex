import { createHash } from "node:crypto";
import type { components } from "@nodex/core-protocol";
import { canonicalizePortableRichText } from "../../shared/block-documents/portable-rich-text";
import type {
  NodexAgentV3ReadCommandResult,
  NodexAgentV3ReadRequest,
} from "../../shared/nodex-agent-tools";
import { FetchV6OutputSchema } from "../../shared/nodex-agent-tools/v6-schemas";
import { serializeInlineMarkdownTitle } from "../../shared/nfm/agent-title";
import { extractPlainText } from "../../shared/nfm/extract-text";
import { nativeAgentClient, type NativeNodexAgentCore } from "./native-nodex-agent-core";
import { toCoreAgentExecutionAuthorization } from "./core-agent-execution-authorization";
import { mapNativeNodexAgentCoreError } from "./native-nodex-agent-page-update";

export type NativeNodexAgentFetchRequest = Extract<
  NodexAgentV3ReadRequest,
  { readonly tool: "fetch" }
>;
type FetchSuccess = Extract<NodexAgentV3ReadCommandResult, { readonly tool: "fetch" }>;
export type NativeNodexAgentFetchObservation =
  | Extract<NodexAgentV3ReadCommandResult, { readonly ok: false }>
  | (FetchSuccess & {
      readonly validators: { readonly title: string | null; readonly body: string | null };
      readonly document: {
        readonly documentId: string;
        readonly ownerPageId: string;
        readonly targetBlockId: string;
        readonly storeEpoch: string;
        readonly generation: number;
        readonly headSeq: number;
        readonly commitHead: number;
      };
    });
type CorePageDetail = components["schemas"]["LibraryPageDetail"];

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const requiredString = (value: unknown, label: string): string => {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Core Agent fetch returned invalid ${label}`);
};

const pageLocation = (detail: CorePageDetail) => {
  const page = record(detail.page);
  const parent = record(page?.parent);
  const kind = requiredString(parent?.kind, "Page parent kind");
  if (kind === "library") {
    return {
      kind,
      libraryId: requiredString(parent?.libraryId, "Page Library parent"),
    } as const;
  }
  if (kind === "page") {
    return {
      kind,
      pageId: requiredString(parent?.pageId, "Page parent"),
    } as const;
  }
  if (kind === "data_source") {
    return {
      kind,
      dataSourceId: requiredString(parent?.dataSourceId, "Page Data Source parent"),
    } as const;
  }
  throw new Error("Core Agent fetch returned an unsupported Page parent");
};

const selectedProperties = (
  detail: CorePageDetail,
  propertyIds: readonly string[] | undefined,
): Readonly<Record<string, { readonly value: unknown }>> | undefined => {
  if (!propertyIds) return undefined;
  const values = new Map<string, unknown>();
  for (const property of detail.intrinsic_properties) {
    values.set(property.key, property.value);
  }
  if (detail.data_source_context.kind === "member") {
    for (const [propertyId, entry] of Object.entries(detail.data_source_context.values)) {
      const value = record(entry)?.value;
      if (value !== undefined) values.set(propertyId, value);
    }
  }
  return Object.fromEntries(
    propertyIds.flatMap((propertyId) =>
      values.has(propertyId) ? [[propertyId, { value: values.get(propertyId) }]] : [],
    ),
  );
};

const dataSource = (detail: CorePageDetail) => {
  if (detail.data_source_context.kind !== "member") return undefined;
  const database = record(detail.data_source_context.database);
  return {
    dataSourceId: detail.data_source_context.membership.data_source_id,
    databaseId: requiredString(database?.databaseId, "Page Database identity"),
  };
};

export async function readNativeFetch(
  request: NativeNodexAgentFetchRequest,
  runtime: NativeNodexAgentCore,
  signal?: AbortSignal,
): Promise<NodexAgentV3ReadCommandResult> {
  const observation = await readFetchObservation(request, runtime, signal, false);
  if (!observation.ok) return observation;
  return { ok: true, tool: "fetch", output: observation.output };
}

/** Retains the same canonical read's fence for exact live Document observations. */
export function readNativeFetchObservation(
  request: NativeNodexAgentFetchRequest,
  runtime: NativeNodexAgentCore,
  signal?: AbortSignal,
): Promise<NativeNodexAgentFetchObservation> {
  return readFetchObservation(request, runtime, signal, true);
}

async function readFetchObservation(
  request: NativeNodexAgentFetchRequest,
  runtime: NativeNodexAgentCore,
  signal: AbortSignal | undefined,
  prepareValidators: boolean,
): Promise<NativeNodexAgentFetchObservation> {
  if (!request.authority) {
    return {
      ok: false,
      error: {
        code: "authorization_denied",
        message: "Native Agent fetch requires exact Turn authority",
        retryable: false,
        recovery: "start_new_task",
      },
    };
  }
  try {
    const client = nativeAgentClient(runtime, request.projectId);
    const authorization = toCoreAgentExecutionAuthorization(
      runtime.identity.profileId,
      request.authority,
      request.callId ?? `nodex-agent:${request.tool}`,
      request.resourceAccess,
    );
    const targetRead = await client.libraryRead(
      {
        kind: "agent_block_target",
        block_id: request.input.id,
        authorization,
      },
      { class: "background", signal },
    );
    if (targetRead.value.kind !== "agent_block_target") {
      throw new Error("Core returned the wrong Agent Block target variant");
    }
    const target = targetRead.value.value;
    if (!target) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Page or Block ${request.input.id} was not found`,
          retryable: false,
          recovery: "none",
          details: {
            resourceId: request.input.id,
            domainCode: "block_not_found",
          },
        },
      };
    }
    const detail = target.owner_page;
    const preparesTitle =
      prepareValidators ||
      (request.input.prepareFor?.some((entry) => entry.kind === "title") ?? false);
    const preparesBody =
      prepareValidators ||
      (request.input.prepareFor?.some((entry) => entry.kind === "body") ?? false);
    const blockGuards = (request.input.prepareFor ?? []).flatMap((entry) => {
      if (entry.kind !== "block_update" && entry.kind !== "block_delete") return [];
      return entry.blockIds.map((blockId) => ({
        block_id: blockId,
        kind: entry.kind === "block_update" ? ("update" as const) : ("delete" as const),
      }));
    });
    const snapshotRead = await client.documentRead(
      `nodex-agent:${request.authority.threadId}`.slice(0, 512),
      {
        kind: "agent_semantic_snapshot",
        store_epoch: request.authority.storeEpoch,
        authorization,
        document_id: target.document_id,
        target_block_id: target.block_id,
        prepare_title: preparesTitle,
        prepare_body: preparesBody,
        block_guards: blockGuards,
        max_depth: request.input.maxDepth ?? null,
        cursor: request.input.page?.cursor ?? null,
        limit: request.input.page?.limit ?? null,
      },
      { class: "background", signal },
    );
    if (snapshotRead.value.kind !== "agent_semantic_snapshot") {
      throw new Error("Core returned the wrong Agent Document snapshot variant");
    }
    const snapshot = snapshotRead.value.snapshot;
    if (
      snapshot.document_id !== target.document_id ||
      snapshot.owner_block_id !== target.owner_page_id ||
      snapshot.target_block_id !== target.block_id ||
      snapshot.generation !== target.document_generation ||
      snapshotRead.store_epoch !== request.authority.storeEpoch
    ) {
      throw new Error("Core Agent fetch authorities diverged");
    }
    const format = request.input.format ?? "markdown";
    const content =
      format === "summary"
        ? {
            format,
            text: extractPlainText(snapshot.nested_markdown, 4_096),
          }
        : format === "blocks"
          ? {
              format,
              blocks: snapshot.blocks.map((block) => ({
                id: block.block_id,
                parentId: block.parent_block_id ?? null,
                index: block.sibling_index,
                depth: block.depth,
                type: block.block_type,
                props: block.props,
                ...(block.content === undefined ? {} : { content: block.content }),
                ...(block.etag ? { etag: block.etag } : {}),
              })),
            }
          : {
              format,
              markdown: snapshot.nested_markdown,
              contentHash: createHash("sha256").update(snapshot.nested_markdown).digest("hex"),
              ...(snapshot.body_etag ? { etag: snapshot.body_etag } : {}),
            };
    const ownsDocument = target.block_id === target.owner_page_id;
    const title = ownsDocument
      ? {
          markdown: serializeInlineMarkdownTitle(canonicalizePortableRichText(snapshot.rich_title)),
          ...(snapshot.title_etag ? { etag: snapshot.title_etag } : {}),
        }
      : undefined;
    const properties = ownsDocument
      ? selectedProperties(detail, request.input.propertyIds)
      : undefined;
    const membership =
      ownsDocument && request.input.includeDataSource !== false ? dataSource(detail) : undefined;
    return {
      ok: true,
      tool: "fetch",
      validators: { title: snapshot.title_etag ?? null, body: snapshot.body_etag ?? null },
      document: {
        documentId: snapshot.document_id,
        ownerPageId: snapshot.owner_block_id,
        targetBlockId: snapshot.target_block_id,
        storeEpoch: snapshotRead.store_epoch,
        generation: snapshot.generation,
        headSeq: snapshot.head_seq,
        commitHead: snapshotRead.commit_head,
      },
      output: FetchV6OutputSchema.parse({
        data: {
          resource: {
            id: target.block_id,
            pageKey:
              ownsDocument && detail.data_source_context.kind === "member"
                ? (detail.data_source_context.page_key ?? null)
                : null,
            type: target.block_type,
            ...(title ? { title } : {}),
            lifecycle: target.lifecycle,
            location: ownsDocument
              ? pageLocation(detail)
              : { kind: "page", pageId: target.owner_page_id },
            ...(properties ? { properties } : {}),
          },
          content,
          ...(membership ? { dataSource: membership } : {}),
        },
        ...(format === "blocks"
          ? {
              page: {
                hasMore: snapshot.has_more,
                ...(snapshot.next_cursor ? { nextCursor: snapshot.next_cursor } : {}),
              },
            }
          : {}),
      }),
    };
  } catch (error) {
    return { ok: false, error: mapNativeNodexAgentCoreError(error) };
  }
}
