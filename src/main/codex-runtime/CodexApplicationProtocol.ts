import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { CodexServerRequest as ParsedCodexServerRequest } from "../codex/codex-app-server-message-parser";

export const CODEX_SERVER_REQUEST_OCCURRENCE_TOKEN = Symbol(
  "codex-server-request-occurrence-token",
);
export const CODEX_SERVER_REQUEST_OCCURRENCE_ID = Symbol("codex-server-request-occurrence-id");

export type CodexServerRequest = ParsedCodexServerRequest & {
  readonly [CODEX_SERVER_REQUEST_OCCURRENCE_ID]?: string;
  readonly [CODEX_SERVER_REQUEST_OCCURRENCE_TOKEN]?: number;
};

export type CodexServerNotification = ServerNotification;
