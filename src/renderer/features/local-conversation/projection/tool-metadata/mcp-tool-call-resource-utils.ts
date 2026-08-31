import type {
  CodexMcpToolCallContentBlock,
  CodexMcpToolCallView,
  ProtocolListMcpServerStatusResponse,
  ProtocolMcpResourceReadResponse,
} from "../../../../lib/types";
import {
  resolveCodexMcpAppResourceMetadata,
  resolveCodexMcpResourceUriFromMetadata,
} from "../../../../../shared/codex-mcp-tool-call";
import type { ThreadMcpAppSidePanelInput } from "../../thread-stage-types";
import { formatMcpServerName } from "./mcp-tool-call-labels";
import {
  MCP_APP_HTML_MAX_BYTES,
  getMcpAppHtmlByteSize,
  isMcpAppHtmlTooLarge,
  resolveMcpAppFrameHeight,
  resolveMcpRenderableResource,
  resolveMcpWidgetMetadata,
  type McpRenderableResource,
  type McpWidgetCsp,
  type McpWidgetMetadata,
} from "../../../../../shared/mcp-app/mcp-app-resource-contract";

export {
  MCP_APP_HTML_MAX_BYTES,
  getMcpAppHtmlByteSize,
  isMcpAppHtmlTooLarge,
  resolveMcpAppFrameHeight,
  resolveMcpRenderableResource,
  resolveMcpWidgetMetadata,
};
export type { McpRenderableResource, McpWidgetCsp, McpWidgetMetadata };

export function buildMcpAppSidePanelInput(input: {
  threadId: string;
  payload: CodexMcpToolCallView;
  resource: McpRenderableResource;
}): ThreadMcpAppSidePanelInput {
  const server = input.payload.invocation.server;
  const tool = input.payload.invocation.tool;
  const title = `${formatMcpServerName(tool)} - ${formatMcpServerName(server)}`;

  return {
    mcpAppId: `${server}:${input.resource.uri}`,
    capabilityId: buildMcpAppCapabilityId({
      threadId: input.threadId,
      server,
      tool,
      callId: input.payload.callId,
      resourceUri: input.resource.uri,
    }),
    title,
    threadId: input.threadId,
    server,
    tool,
  };
}

export function buildMcpAppCapabilityId(input: {
  callId: string;
  resourceUri: string;
  server: string;
  threadId: string;
  tool: string;
}): string {
  return [
    "mcp-capability",
    input.threadId,
    input.server,
    input.tool,
    input.callId,
    input.resourceUri,
  ]
    .map(encodeURIComponent)
    .join(":");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

export function resolveMcpResourceUriFromMeta(meta: unknown): string | null {
  return resolveCodexMcpResourceUriFromMetadata(meta);
}

export function resolveMcpAppResourceScopeUri(input: {
  payload: CodexMcpToolCallView;
  mcpServerStatuses?: ProtocolListMcpServerStatusResponse | null;
}): string | null {
  const metadataResourceUri =
    resolveCodexMcpAppResourceMetadata({
      payload: input.payload,
      mcpServerStatuses: input.mcpServerStatuses ?? null,
    })?.resourceUri ?? null;
  if (metadataResourceUri !== null) return metadataResourceUri;
  if (input.payload.result?.type !== "success") return null;
  return input.payload.mcpAppResourceUri ?? null;
}

export function resolveMcpAppResourceUri(input: {
  payload: CodexMcpToolCallView;
  mcpServerStatuses?: ProtocolListMcpServerStatusResponse | null;
}): string | null {
  return resolveMcpAppResourceScopeUri(input) ?? input.payload.mcpAppResourceUri ?? null;
}

function getEmbeddedResourceContents(
  payload: CodexMcpToolCallView,
): ProtocolMcpResourceReadResponse["contents"] {
  if (payload.result?.type !== "success") return [];

  type ResourceContent = ProtocolMcpResourceReadResponse["contents"][number];

  return payload.result.raw.content.flatMap<ResourceContent>((rawContent) => {
    const content = asRecord(rawContent);
    if (content?.type !== "embedded_resource" && content?.type !== "resource") return [];
    const resource = asRecord(content.resource);
    if (!resource || typeof resource.uri !== "string") return [];

    if (typeof resource.text === "string") {
      const resourceContent: ResourceContent = {
        uri: resource.uri,
        mimeType: typeof resource.mimeType === "string" ? resource.mimeType : undefined,
        text: resource.text,
        _meta: resource._meta as ResourceContent["_meta"],
      };
      return [resourceContent];
    }

    if (typeof resource.blob === "string") {
      const resourceContent: ResourceContent = {
        uri: resource.uri,
        mimeType: typeof resource.mimeType === "string" ? resource.mimeType : undefined,
        blob: resource.blob,
        _meta: resource._meta as ResourceContent["_meta"],
      };
      return [resourceContent];
    }

    return [];
  });
}

export function resolveMcpEmbeddedRenderableResource(input: {
  payload: CodexMcpToolCallView;
  mcpServerStatuses?: ProtocolListMcpServerStatusResponse | null;
}): McpRenderableResource | null {
  const contents = getEmbeddedResourceContents(input.payload);
  if (contents.length === 0) return null;

  const resourceUri = resolveMcpAppResourceUri(input) ?? contents[0]?.uri;
  if (!resourceUri) return null;

  return resolveMcpRenderableResource(resourceUri, {
    contents,
    originCallId: input.payload.callId,
  });
}

export function shouldHideDuplicateMcpTextContent(
  content: CodexMcpToolCallContentBlock,
  resource: McpRenderableResource | null,
): boolean {
  if (!resource || content.type !== "text") return false;
  const text = content.text.trim();
  if (!text) return false;
  return text === resource.html.trim() || text === resource.uri;
}

export function stringifyMcpValue(value: unknown, spacing = 2): string {
  try {
    return (
      JSON.stringify(
        value,
        (_key, nestedValue) =>
          typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue,
        spacing,
      ) ?? "null"
    );
  } catch {
    return "";
  }
}

function parseSingleJsonTextContent(
  content: readonly CodexMcpToolCallContentBlock[],
): string | null {
  if (content.length !== 1) return null;
  const [block] = content;
  if (!block || block.type !== "text" || block.annotations != null) return null;

  const trimmed = block.text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;

  try {
    return stringifyMcpValue(JSON.parse(trimmed), 2);
  } catch {
    return null;
  }
}

export function resolveMcpExpandedSuccessDisplay(input: {
  content: readonly CodexMcpToolCallContentBlock[];
  structuredContentJson: string | null;
  isExpanded: boolean;
}): {
  displayContent: readonly CodexMcpToolCallContentBlock[];
  displayStructuredContentJson: string | null;
} {
  if (!input.isExpanded) {
    return {
      displayContent: input.content,
      displayStructuredContentJson: input.structuredContentJson,
    };
  }

  const parsedContentJson = parseSingleJsonTextContent(input.content);
  if (parsedContentJson === null) {
    return {
      displayContent: input.content,
      displayStructuredContentJson: input.structuredContentJson,
    };
  }

  if (input.structuredContentJson === null || parsedContentJson === input.structuredContentJson) {
    return {
      displayContent: [],
      displayStructuredContentJson: input.structuredContentJson ?? parsedContentJson,
    };
  }

  return {
    displayContent: input.content,
    displayStructuredContentJson: input.structuredContentJson,
  };
}

export function shouldShowMcpStructuredContent(input: {
  structuredContentJson: string | null;
  hasMcpAppBranch: boolean;
  hasResourceScope: boolean;
}): boolean {
  return Boolean(input.structuredContentJson) && !(input.hasMcpAppBranch && input.hasResourceScope);
}
