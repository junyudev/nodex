import { APP_PROTOCOL_SCHEME } from "../../shared/app-protocol";
import { PAGE_FILE_HTML_SCHEME } from "../../shared/page-file-html";
import { MCP_APP_SANDBOX_SCHEME } from "../../shared/mcp-app/mcp-app-sandbox-contract";
import type { ApplicationNetworkRequirements } from "@nodex/codex-app-server-protocol/v2/ApplicationNetworkRequirements";

/** Application network requirements compose with, rather than replace, page navigation policy. */
export function allowsBrowserSessionRequest(input: {
  readonly url: string;
  readonly developmentOrigin?: string | null;
  readonly network: ApplicationNetworkRequirements | null;
}): boolean {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return false;
  }
  if (
    [
      `${APP_PROTOCOL_SCHEME}:`,
      `${PAGE_FILE_HTML_SCHEME}:`,
      `${MCP_APP_SANDBOX_SCHEME}:`,
      "nodex:",
      "nodex-dev:",
      "codex-sandbox:",
      "data:",
      "blob:",
      "file:",
      "about:",
    ].includes(url.protocol)
  )
    return true;
  if (input.developmentOrigin) {
    const development = new URL(input.developmentOrigin);
    if (url.origin === development.origin) return true;
    development.protocol = development.protocol === "https:" ? "wss:" : "ws:";
    if (url.origin === development.origin) return true;
  }
  if (input.network?.enabled !== true) return true;
  return (
    (url.protocol === "https:" || url.protocol === "wss:") &&
    input.network.domains[url.hostname.replace(/\.$/u, "")] === "allow"
  );
}
