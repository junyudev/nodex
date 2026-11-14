import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

export const MCP_APP_HTML_MAX_BYTES = 10_000_000;
export const MCP_APP_DEFAULT_HEIGHT = 240;
export const MCP_APP_MIN_HEIGHT = 200;
export const MCP_APP_MAX_HEIGHT = 720;

const HTML_MIME_TYPES = new Set(["text/html", "text/html;profile=mcp-app", "text/html+skybridge"]);
const DIL_MIME_TYPES = new Set(["text/x-dil;profile=mcp-app"]);
const UNSAFE_CSP_DOMAIN_CHARACTER_PATTERN = /[\s"';]/u;

export interface McpWidgetCsp {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
  includeDefaultDomains: false;
  isTrusted: boolean;
}

export interface McpWidgetRequestedPermissions {
  camera: boolean;
  microphone: boolean;
  geolocation: boolean;
  clipboardWrite: boolean;
}

export interface McpWidgetMetadata {
  domain: string | null;
  csp: McpWidgetCsp;
  requestedPermissions: McpWidgetRequestedPermissions;
  heightHint: number | null;
  minFrameHeight: number | null;
  prefersBorder: boolean;
  isCollapsible: boolean;
}

export interface McpRenderableResource {
  uri: string;
  mode: "html";
  html: string;
  mimeType: string | null;
  metadata: McpWidgetMetadata;
}

export interface NormalizeMcpCspDomainOptions {
  kind: "base" | "connect" | "frame" | "resource";
  allowLocalDevelopment?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getNestedValue(record: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  if (!key.includes(".")) return undefined;

  return key.split(".").reduce<unknown>((acc, part) => {
    const nested = asRecord(acc);
    return nested ? nested[part] : undefined;
  }, record);
}

function readStringMeta(meta: unknown, keys: readonly string[]): string | null {
  const record = asRecord(meta);
  if (!record) return null;

  for (const key of keys) {
    const value = getNestedValue(record, key);
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }

  return null;
}

function readNumberMeta(meta: unknown, keys: readonly string[]): number | null {
  const record = asRecord(meta);
  if (!record) return null;

  for (const key of keys) {
    const value = getNestedValue(record, key);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }

  return null;
}

function readBooleanMeta(meta: unknown, keys: readonly string[]): boolean | null {
  const record = asRecord(meta);
  if (!record) return null;

  for (const key of keys) {
    const value = getNestedValue(record, key);
    if (typeof value === "boolean") return value;
  }

  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function normalizeMcpCspDomain(
  rawValue: string,
  options: NormalizeMcpCspDomainOptions,
): string | null {
  const value = rawValue.trim();
  if (!value || UNSAFE_CSP_DOMAIN_CHARACTER_PATTERN.test(value)) return null;

  if (value === "blob:" || value === "data:") return value;

  try {
    const wildcardNormalized = value.replace(/^([a-z][a-z0-9+.-]*:\/\/)?%2a(?=\.)/iu, "$1*");
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(wildcardNormalized)
        ? wildcardNormalized
        : `https://${wildcardNormalized}`,
    );
    const isSecureWeb =
      url.protocol === "https:" || (options.kind === "connect" && url.protocol === "wss:");
    const isLocalDevelopment =
      options.allowLocalDevelopment === true &&
      isLoopbackHostname(url.hostname) &&
      (url.protocol === "http:" || (options.kind === "connect" && url.protocol === "ws:"));

    if (!isSecureWeb && !isLocalDevelopment) return null;
    if (url.username || url.password) return null;

    const hostname = url.hostname.toLowerCase();
    if (!hostname) return null;
    if (hostname.includes("*") && !hostname.startsWith("*.")) return null;
    if (hostname.slice(2).includes("*")) return null;

    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function normalizeDomainList(value: unknown, options: NormalizeMcpCspDomainOptions): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = normalizeMcpCspDomain(entry, options);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function readCspDefinitions(meta: unknown): {
  mcpAppCsp: Record<string, unknown> | null;
  openAiWidgetCsp: Record<string, unknown> | null;
} {
  const record = asRecord(meta);
  return {
    mcpAppCsp: asRecord(record?.["ui.csp"]) ?? asRecord(asRecord(record?.ui)?.csp),
    openAiWidgetCsp: asRecord(record?.["openai/widgetCSP"]),
  };
}

function resolveCspMeta(meta: unknown, fallbackMeta?: unknown): McpWidgetCsp {
  const primary = readCspDefinitions(meta);
  const fallback = readCspDefinitions(fallbackMeta);
  const definitions = primary.mcpAppCsp || primary.openAiWidgetCsp ? primary : fallback;
  const mcpAppCsp = definitions.mcpAppCsp;
  const openAiWidgetCsp = definitions.openAiWidgetCsp;

  const connectDomains = normalizeDomainList(
    mcpAppCsp?.connectDomains ??
      openAiWidgetCsp?.connectDomains ??
      openAiWidgetCsp?.connect_domains,
    { kind: "connect" },
  );
  const declaredResourceDomains = normalizeDomainList(
    mcpAppCsp?.resourceDomains ??
      openAiWidgetCsp?.resourceDomains ??
      openAiWidgetCsp?.resource_domains,
    { kind: "resource" },
  );
  const frameDomains = normalizeDomainList(
    mcpAppCsp?.frameDomains ?? openAiWidgetCsp?.frameDomains ?? openAiWidgetCsp?.frame_domains,
    { kind: "frame" },
  );
  const baseUriDomains = normalizeDomainList(
    mcpAppCsp?.baseUriDomains ??
      openAiWidgetCsp?.baseUriDomains ??
      openAiWidgetCsp?.base_uri_domains,
    { kind: "base" },
  );
  const combinedConnectDomains = [...connectDomains, ...declaredResourceDomains];

  return {
    baseUriDomains,
    connectDomains: [...new Set(combinedConnectDomains)],
    frameDomains,
    includeDefaultDomains: false,
    isTrusted: mcpAppCsp !== null || openAiWidgetCsp !== null,
    resourceDomains: declaredResourceDomains,
  };
}

function permissionRecord(meta: unknown): Record<string, unknown> | null {
  const record = asRecord(meta);
  return asRecord(record?.["ui.permissions"]) ?? asRecord(asRecord(record?.ui)?.permissions);
}

function readRequestedPermissions(
  meta: unknown,
  fallbackMeta?: unknown,
): McpWidgetRequestedPermissions {
  const permissions = permissionRecord(meta);
  const fallback = permissionRecord(fallbackMeta);
  const read = (camelCase: string, snakeCase = camelCase): boolean =>
    permissions?.[camelCase] === true ||
    permissions?.[snakeCase] === true ||
    fallback?.[camelCase] === true ||
    fallback?.[snakeCase] === true;

  return {
    camera: read("camera"),
    microphone: read("microphone"),
    geolocation: read("geolocation"),
    clipboardWrite: read("clipboardWrite", "clipboard_write"),
  };
}

export function resolveMcpWidgetMetadata(meta: unknown, fallbackMeta?: unknown): McpWidgetMetadata {
  const primary = asRecord(meta);
  const fallback = asRecord(fallbackMeta);
  const readFromPrimaryOrFallback = <Value>(
    reader: (value: unknown) => Value | null,
  ): Value | null => reader(primary) ?? reader(fallback);

  return {
    domain: readFromPrimaryOrFallback((value) =>
      readStringMeta(value, ["ui.domain", "ui/widgetDomain", "openai/widgetDomain"]),
    ),
    csp: resolveCspMeta(primary, fallback),
    requestedPermissions: readRequestedPermissions(primary, fallback),
    heightHint: readFromPrimaryOrFallback((value) =>
      readNumberMeta(value, ["ui.heightHint", "ui/widgetHeightHint", "openai/widgetHeightHint"]),
    ),
    minFrameHeight: readFromPrimaryOrFallback((value) =>
      readNumberMeta(value, [
        "ui.minFrameHeight",
        "ui/widgetMinFrameHeight",
        "openai/widgetMinFrameHeight",
      ]),
    ),
    prefersBorder:
      readFromPrimaryOrFallback((value) =>
        readBooleanMeta(value, [
          "ui.prefersBorder",
          "ui/widgetPrefersBorder",
          "openai/widgetPrefersBorder",
        ]),
      ) ?? false,
    isCollapsible: !(
      readFromPrimaryOrFallback((value) =>
        readBooleanMeta(value, [
          "ui.showCodexWidgetInline",
          "ui/widgetShowCodexWidgetInline",
          "openai/widgetShowCodexWidgetInline",
        ]),
      ) ?? false
    ),
  };
}

function normalizeMimeType(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

type RenderableResourceContent = Omit<ReadResourceResult["contents"][number], "_meta"> & {
  readonly _meta?: unknown;
} & ({ readonly text: string } | { readonly blob: string });

function decodeResourceContent(content: RenderableResourceContent): string {
  if ("text" in content) return content.text;
  if (!("blob" in content)) return "";

  try {
    const binary = atob(content.blob);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
}

export function getMcpAppHtmlByteSize(html: string): number {
  if (typeof TextEncoder === "function") {
    return new TextEncoder().encode(html).byteLength;
  }

  if (typeof Blob === "function") return new Blob([html]).size;
  return html.length;
}

export function resolveMcpRenderableResource(
  resourceUri: string,
  response: {
    readonly contents: readonly RenderableResourceContent[];
    readonly originCallId?: string | null;
  } | null,
  listingMeta?: unknown,
): McpRenderableResource | null {
  const contents = response?.contents ?? [];
  const orderedContents = [
    ...contents.filter((entry) => entry.uri === resourceUri),
    ...contents.filter((entry) => entry.uri !== resourceUri),
  ];

  for (const content of orderedContents) {
    const mimeType = normalizeMimeType(content.mimeType);
    const html = decodeResourceContent(content);
    if (!html.trim()) continue;

    if (HTML_MIME_TYPES.has(mimeType)) {
      return {
        uri: content.uri,
        mode: "html",
        html,
        mimeType: content.mimeType ?? null,
        metadata: resolveMcpWidgetMetadata(content._meta, listingMeta),
      };
    }

    if (!DIL_MIME_TYPES.has(mimeType)) continue;
  }

  return null;
}

export function isMcpAppHtmlTooLarge(resource: McpRenderableResource): boolean {
  return getMcpAppHtmlByteSize(resource.html) > MCP_APP_HTML_MAX_BYTES;
}

export function resolveMcpAppFrameHeight(metadata?: McpWidgetMetadata | null): number {
  const preferredHeight = metadata?.heightHint ?? MCP_APP_DEFAULT_HEIGHT;
  const minHeight = metadata?.minFrameHeight ?? MCP_APP_MIN_HEIGHT;
  return Math.min(Math.max(preferredHeight, minHeight), MCP_APP_MAX_HEIGHT);
}
