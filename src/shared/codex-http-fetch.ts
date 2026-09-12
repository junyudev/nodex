export const CODEX_ATTACH_AUTH_HEADER = "X-OpenAI-Attach-Auth";

export interface CodexHttpFetchRequest {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly keepalive?: boolean;
}

export interface CodexHttpFetchSuccess {
  readonly responseType: "success";
  readonly requestId: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface CodexHttpFetchFailure {
  readonly responseType: "error";
  readonly requestId: string;
  readonly status: number;
  readonly error: string;
  readonly errorCode?: string;
  readonly responseStatus: number | null;
  readonly errorKind?: string;
}

export type CodexHttpFetchResult = CodexHttpFetchSuccess | CodexHttpFetchFailure;
