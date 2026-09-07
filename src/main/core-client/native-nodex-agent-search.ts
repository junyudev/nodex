import type { components } from "@nodex/core-protocol";
import type {
  NodexAgentV3ReadCommandResult,
  NodexAgentV3ReadRequest,
} from "../../shared/nodex-agent-tools";
import { SearchV6OutputSchema } from "../../shared/nodex-agent-tools/v6-schemas";
import { nativeAgentClient, type NativeNodexAgentCore } from "./native-nodex-agent-core";
import { toCoreAgentExecutionAuthorization } from "./core-agent-execution-authorization";
import { mapNativeNodexAgentCoreError } from "./native-nodex-agent-page-update";

type SearchRequest = Extract<NodexAgentV3ReadRequest, { readonly tool: "search" }>;
type CoreSearchResult = components["schemas"]["LibraryAgentSearchResult"];
type CorePageMatch = components["schemas"]["LibraryAgentPageSearchMatch"];

const mapScope = (
  scope: SearchRequest["input"]["scope"],
): components["schemas"]["LibraryAgentSearchScope"] => {
  if (!scope || scope.kind === "library") return { kind: "library" };
  if (scope.kind === "database") {
    return { kind: scope.kind, database_id: scope.databaseId };
  }
  if (scope.kind === "data_source") {
    return { kind: scope.kind, data_source_id: scope.dataSourceId };
  }
  return { kind: scope.kind, page_id: scope.pageId };
};

const mapLocation = (
  location: Extract<CoreSearchResult, { readonly kind: "page" }>["location"],
) => {
  if (location.kind === "library") {
    return { kind: location.kind, libraryId: location.library_id } as const;
  }
  if (location.kind === "page") {
    return { kind: location.kind, pageId: location.page_id } as const;
  }
  return { kind: location.kind, dataSourceId: location.data_source_id } as const;
};

const mapPageMatch = (match: CorePageMatch) => {
  if (match.source === "page_key") {
    return {
      source: match.source,
      quality: match.quality,
      pageKey: match.page_key,
      isCurrent: match.is_current,
    } as const;
  }
  if (match.source === "property") {
    return {
      source: match.source,
      quality: match.quality,
      propertyId: match.property_id,
      propertyName: match.property_name,
      excerpt: match.excerpt,
    } as const;
  }
  if (match.source === "body") {
    return {
      source: match.source,
      quality: match.quality,
      blockId: match.block_id,
      blockType: match.block_type,
      excerpt: match.excerpt,
    } as const;
  }
  return {
    source: match.source,
    quality: match.quality,
    excerpt: match.excerpt,
  } as const;
};

const mapResult = (result: CoreSearchResult) => {
  if (result.kind === "page") {
    return {
      kind: result.kind,
      id: result.id,
      pageKey: result.page_key ?? null,
      title: result.title,
      location: mapLocation(result.location),
      matches: result.matches.map(mapPageMatch),
    } as const;
  }
  if (result.quality === "fuzzy") {
    throw new Error("Core Agent Block search returned fuzzy evidence");
  }
  return {
    kind: result.kind,
    id: result.id,
    blockType: result.block_type,
    ownerPageId: result.owner_page_id,
    source: result.source === "document_title" ? ("title" as const) : ("body" as const),
    quality: result.quality,
    excerpt: result.excerpt,
  } as const;
};

export async function readNativeSearch(
  request: SearchRequest,
  runtime: NativeNodexAgentCore,
  signal?: AbortSignal,
): Promise<NodexAgentV3ReadCommandResult> {
  if (!request.authority) {
    return {
      ok: false,
      error: {
        code: "authorization_denied",
        message: "Native Agent search requires exact Turn authority",
        retryable: false,
        recovery: "start_new_task",
      },
    };
  }
  try {
    const authorization = toCoreAgentExecutionAuthorization(
      runtime.identity.profileId,
      request.authority,
      request.callId ?? `nodex-agent:${request.tool}`,
      request.resourceAccess,
    );
    const read = {
      kind: "agent_search" as const,
      authorization,
      query: request.input.query,
      target: request.input.target ?? "pages",
      scope: mapScope(request.input.scope),
      block_types: request.input.blockTypes ?? null,
      include_archived: request.input.includeArchived ?? false,
      cursor: request.input.page?.cursor ?? null,
      limit: request.input.page?.limit ?? null,
    };
    const client = nativeAgentClient(runtime, request.projectId);
    const snapshot = signal
      ? await client.libraryRead(read, { class: "background", signal })
      : await client.libraryRead(read);
    if (snapshot.value.kind !== "agent_search") {
      throw new Error("Core returned the wrong Agent search variant");
    }
    return {
      ok: true,
      tool: request.tool,
      output: SearchV6OutputSchema.parse({
        data: { results: snapshot.value.items.map(mapResult) },
        page: {
          hasMore: snapshot.value.has_more,
          ...(snapshot.value.next_cursor ? { nextCursor: snapshot.value.next_cursor } : {}),
        },
      }),
    };
  } catch (error) {
    return { ok: false, error: mapNativeNodexAgentCoreError(error) };
  }
}
