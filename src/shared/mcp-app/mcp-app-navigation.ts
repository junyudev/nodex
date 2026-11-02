import { parsePageDeepLink, parseSessionDeepLink, parseViewDeepLink } from "../nodex-deeplink";
import { requireCredentialFreeHttpsUrl } from "../external-navigation-url";

export interface McpAppLinkRequest {
  readonly href: string;
  readonly openMode?: "tab" | "popup";
}

/** Guest navigation admits HTTPS and Nodex's own resource destinations only. */
export function requireMcpAppNavigationUrl(value: string): string {
  if (typeof value !== "string" || value.length > 8_192) throw new Error("Invalid app link");
  if (parsePageDeepLink(value) || parseSessionDeepLink(value) || parseViewDeepLink(value))
    return value;
  return requireCredentialFreeHttpsUrl(value);
}

export function parseMcpAppLinkRequest(value: unknown): McpAppLinkRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid app link request");
  const record = value as Record<string, unknown>;
  if (
    typeof record.href !== "string" ||
    (record.openMode !== undefined && record.openMode !== "tab" && record.openMode !== "popup")
  )
    throw new Error("Invalid app link request");
  return {
    href: requireMcpAppNavigationUrl(record.href),
    ...(record.openMode ? { openMode: record.openMode } : {}),
  };
}
