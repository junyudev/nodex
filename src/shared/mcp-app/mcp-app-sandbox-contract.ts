export const MCP_APP_SANDBOX_SCHEME = "nodex-mcp-sandbox";
export const MCP_APP_SANDBOX_REMOTE_HOST = "web-sandbox.oaiusercontent.com";
export const MCP_APP_SANDBOX_PARTITION_PREFIX = "nodex-mcp-app-sandbox:";
export const MCP_APP_SANDBOX_GUEST_MESSAGE_CHANNEL = "nodex:mcp-app-sandbox-guest-message";
export const MCP_APP_SANDBOX_HOST_MESSAGE_CHANNEL = "nodex:mcp-app-sandbox-host-message";
export type McpAppSandboxHostMessageChannel = typeof MCP_APP_SANDBOX_HOST_MESSAGE_CHANNEL;

export const MCP_APP_REQUIRED_GUEST_PORT_NAMES = [
  "navigate",
  "notifyMcpAppsHostContext",
  "notifyMcpAppsToolCancelled",
  "notifyMcpAppsToolInput",
  "notifyMcpAppsToolResult",
  "requestMcpAppsResourceTeardown",
  "runWidgetCode",
  "setAdditionalGlobals",
  "setSafeArea",
  "setTheme",
  "setWidgetData",
  "setWidgetView",
] as const;

export const MCP_APP_OPTIONAL_GUEST_PORT_NAMES = ["notifyMcpAppsMcpNotification"] as const;

export type McpAppRequiredGuestPortName = (typeof MCP_APP_REQUIRED_GUEST_PORT_NAMES)[number];
export type McpAppOptionalGuestPortName = (typeof MCP_APP_OPTIONAL_GUEST_PORT_NAMES)[number];
export type McpAppGuestPortName = McpAppRequiredGuestPortName | McpAppOptionalGuestPortName;

export interface McpAppSandboxGuestInitMessage {
  type: "init";
  initId: string;
  origin: string;
  portNames: McpAppGuestPortName[];
}

export interface McpAppSandboxHostInitMessage extends McpAppSandboxGuestInitMessage {
  sandboxId: string;
  skybridgeCacheState?: "cold" | "warming" | "warm";
}

export type McpAppSandboxOriginScope =
  | {
      connectorId: string | null;
      instanceFallbackId: string;
      kind: "codex_app";
    }
  | {
      kind: "mcp_server";
      server: string;
    }
  | {
      kind: "inline_visualization";
      scopeId: string;
    };

export interface McpAppSandboxIdentity {
  origin: string;
  partition: string;
  sandboxId: string;
  subdomain: string;
  sourceUrl: string;
}

export interface ParsedMcpAppSandboxSource {
  sourceUrl: string;
  origin: string;
  initId: string | null;
  locale: string;
  subdomain: string;
}

const SANDBOX_ID_PATTERN = /^source-[0-9a-f]{16}$/u;
const INIT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SUBDOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/u;
const EXPECTED_QUERY_KEYS = ["app", "locale", "deviceType", "unsafeSkipTargetOriginCheck"] as const;
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fnv1a64(value: string): string {
  let hash = 14_695_981_039_346_656_037n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return hash.toString(16).padStart(16, "0").slice(0, 16);
}

function stableSlug(input: { fallback: string; prefix: string; value: string }): string {
  const suffix = fnv1a64(input.value);
  const slugBudget = 63 - input.prefix.length - suffix.length - 2;
  const slug = input.value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, slugBudget)
    .replace(/-+$/u, "");
  return `${input.prefix}-${slug || input.fallback}-${suffix}`;
}

async function deriveMcpAppSandboxSubdomain(input: {
  originScope: McpAppSandboxOriginScope;
  widgetDomain: string | null;
}): Promise<string> {
  const scope = input.originScope;
  if (scope.kind === "inline_visualization") {
    return `codex-inline-visualization-${fnv1a64(scope.scopeId)}`;
  }
  if (scope.kind === "mcp_server") {
    return stableSlug({
      fallback: "server",
      prefix: "mcp-server",
      value: scope.server,
    });
  }

  if (input.widgetDomain !== null) {
    const rawDomain = input.widgetDomain.trim();
    try {
      const url = new URL(rawDomain);
      if (url.hostname) {
        const connectorId = scope.connectorId?.trim() ?? "";
        const seed = JSON.stringify([
          connectorId ? "connector" : "instance",
          connectorId || scope.instanceFallbackId,
          url.hostname,
        ]);
        return `widget-${(await sha256Hex(seed)).slice(0, 48)}`;
      }
    } catch {
      if (!rawDomain.startsWith("http")) {
        return deriveMcpAppSandboxSubdomain({
          ...input,
          widgetDomain: `https://${rawDomain}`,
        });
      }
    }
  }

  const connectorId = scope.connectorId?.trim();
  return connectorId
    ? stableSlug({ fallback: "app", prefix: "mcp-app", value: connectorId })
    : stableSlug({
        fallback: "instance",
        prefix: "mcp-app-instance",
        value: scope.instanceFallbackId,
      });
}

function originScopeKey(scope: McpAppSandboxOriginScope): string {
  if (scope.kind === "inline_visualization") return `inline_visualization:${scope.scopeId}`;
  if (scope.kind === "mcp_server") return `mcp_server:${scope.server}`;
  return `codex_app:${scope.connectorId ?? `instance:${scope.instanceFallbackId}`}`;
}

export async function deriveMcpAppSandboxIdentity(input: {
  locale: string;
  originScope: McpAppSandboxOriginScope;
  widgetDomain: string | null;
}): Promise<McpAppSandboxIdentity> {
  const subdomain = await deriveMcpAppSandboxSubdomain(input);
  const sourceUrl = buildMcpAppSandboxSourceUrl({
    locale: input.locale,
    subdomain,
  });
  const sandboxId = `source-${fnv1a64(`${originScopeKey(input.originScope)}\n${sourceUrl}`)}`;
  const source = parseMcpAppSandboxSourceUrl(sourceUrl);
  if (!source) throw new Error("Failed to derive MCP App sandbox source");
  return {
    origin: source.origin,
    partition: buildMcpAppSandboxPartition(sandboxId),
    sandboxId,
    sourceUrl,
    subdomain,
  };
}

export function isValidMcpAppSandboxId(value: string): boolean {
  return SANDBOX_ID_PATTERN.test(value);
}

export function isValidMcpAppInitId(value: string): boolean {
  return INIT_ID_PATTERN.test(value);
}

export function buildMcpAppSandboxPartition(sandboxId: string): string {
  if (!isValidMcpAppSandboxId(sandboxId)) {
    throw new Error("Invalid MCP App sandbox id");
  }
  return `${MCP_APP_SANDBOX_PARTITION_PREFIX}${sandboxId}`;
}

export function parseMcpAppSandboxPartition(partition: string): string | null {
  if (!partition.startsWith(MCP_APP_SANDBOX_PARTITION_PREFIX)) return null;
  const sandboxId = partition.slice(MCP_APP_SANDBOX_PARTITION_PREFIX.length);
  return isValidMcpAppSandboxId(sandboxId) ? sandboxId : null;
}

export function buildMcpAppSandboxSourceUrl(input: { subdomain: string; locale: string }): string {
  if (!SUBDOMAIN_PATTERN.test(input.subdomain)) {
    throw new Error("Invalid MCP App sandbox subdomain");
  }
  const url = new URL(
    `${MCP_APP_SANDBOX_SCHEME}://${input.subdomain}.${MCP_APP_SANDBOX_REMOTE_HOST}/`,
  );
  url.searchParams.set("app", "skybridge");
  url.searchParams.set("locale", input.locale.trim() || "en-US");
  url.searchParams.set("deviceType", "desktop");
  url.searchParams.set("unsafeSkipTargetOriginCheck", "true");
  return url.toString();
}

export function appendMcpAppSandboxInitId(sourceUrl: string, initId: string): string {
  if (!isValidMcpAppInitId(initId)) {
    throw new Error("Invalid MCP App sandbox init id");
  }
  const source = parseMcpAppSandboxSourceUrl(sourceUrl);
  if (!source || source.initId !== null) {
    throw new Error("Invalid MCP App sandbox source URL");
  }
  const url = new URL(source.sourceUrl);
  url.hash = new URLSearchParams({ initId }).toString();
  return url.toString();
}

export function parseMcpAppSandboxSourceUrl(value: string): ParsedMcpAppSandboxSource | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== `${MCP_APP_SANDBOX_SCHEME}:`) return null;
    if (url.port || url.username || url.password || url.pathname !== "/") return null;
    const isBaseHost = url.hostname === MCP_APP_SANDBOX_REMOTE_HOST;
    if (!isBaseHost && !url.hostname.endsWith(`.${MCP_APP_SANDBOX_REMOTE_HOST}`)) {
      return null;
    }
    const subdomain = isBaseHost
      ? ""
      : url.hostname.slice(0, -`.${MCP_APP_SANDBOX_REMOTE_HOST}`.length);
    if (subdomain && !SUBDOMAIN_PATTERN.test(subdomain)) return null;

    const queryKeys = [...url.searchParams.keys()];
    if (
      queryKeys.length !== EXPECTED_QUERY_KEYS.length ||
      !EXPECTED_QUERY_KEYS.every((key) => queryKeys.includes(key)) ||
      url.searchParams.get("app") !== "skybridge" ||
      !url.searchParams.get("locale")?.trim() ||
      url.searchParams.get("deviceType") !== "desktop" ||
      url.searchParams.get("unsafeSkipTargetOriginCheck") !== "true"
    ) {
      return null;
    }

    const hashParams = new URLSearchParams(url.hash.slice(1));
    const initId = hashParams.get("initId");
    if ((url.hash && (!initId || !isValidMcpAppInitId(initId))) || (!url.hash && initId !== null)) {
      return null;
    }

    return {
      sourceUrl: url.toString(),
      origin: `${url.protocol}//${url.host}`,
      initId: initId ?? null,
      locale: url.searchParams.get("locale") ?? "en-US",
      subdomain,
    };
  } catch {
    return null;
  }
}

export function parseMcpAppSandboxGuestInitMessage(
  value: unknown,
): McpAppSandboxGuestInitMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.type !== "init" ||
    typeof record.initId !== "string" ||
    !isValidMcpAppInitId(record.initId) ||
    typeof record.origin !== "string" ||
    !Array.isArray(record.portNames)
  ) {
    return null;
  }

  const portNames = record.portNames;
  if (portNames.some((name) => typeof name !== "string")) return null;
  const uniqueNames = new Set(portNames as string[]);
  if (uniqueNames.size !== portNames.length) return null;
  if (!MCP_APP_REQUIRED_GUEST_PORT_NAMES.every((name) => uniqueNames.has(name))) return null;
  const allowedNames = new Set<string>([
    ...MCP_APP_REQUIRED_GUEST_PORT_NAMES,
    ...MCP_APP_OPTIONAL_GUEST_PORT_NAMES,
  ]);
  if ([...uniqueNames].some((name) => !allowedNames.has(name))) return null;

  return {
    type: "init",
    initId: record.initId,
    origin: record.origin,
    portNames: portNames as McpAppGuestPortName[],
  };
}

export function parseMcpAppSandboxHostInitMessage(
  value: unknown,
): McpAppSandboxHostInitMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sandboxId !== "string" || !isValidMcpAppSandboxId(record.sandboxId)) {
    return null;
  }
  const guestMessage = parseMcpAppSandboxGuestInitMessage(record);
  if (!guestMessage) return null;
  const cacheState = record.skybridgeCacheState;
  if (
    cacheState !== undefined &&
    cacheState !== "cold" &&
    cacheState !== "warming" &&
    cacheState !== "warm"
  ) {
    return null;
  }
  return {
    ...guestMessage,
    sandboxId: record.sandboxId,
    ...(cacheState ? { skybridgeCacheState: cacheState } : {}),
  };
}
