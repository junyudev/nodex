import type { CodexHttpFetchRequest, CodexHttpFetchResult } from "../../shared/codex-http-fetch";
import { invokeRendererControl } from "./renderer-command";

export class CodexHttpFetchError extends Error {
  readonly status: number;
  readonly errorCode: string | undefined;
  readonly responseStatus: number | null;
  readonly errorKind: string | undefined;

  constructor(result: Extract<CodexHttpFetchResult, { readonly responseType: "error" }>) {
    super(result.error);
    this.name = "CodexHttpFetchError";
    this.status = result.status;
    this.errorCode = result.errorCode;
    this.responseStatus = result.responseStatus;
    this.errorKind = result.errorKind;
  }
}

export interface CodexHttpFetchPort {
  readonly fetch: (request: CodexHttpFetchRequest) => Promise<CodexHttpFetchResult>;
  readonly cancel: (requestId: string) => Promise<void>;
}

const defaultPort: CodexHttpFetchPort = {
  fetch: (request) => invokeRendererControl("codex:http-fetch", request),
  cancel: (requestId) => invokeRendererControl("codex:http-fetch:cancel", requestId),
};

const abortError = (signal: AbortSignal): unknown =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");

const responseAllowsBody = (status: number): boolean =>
  status !== 204 && status !== 205 && status !== 304;

export async function fetchCodexHttp(
  url: string,
  init: {
    readonly method?: string;
    readonly body?: string | Uint8Array;
    readonly headers?: Readonly<Record<string, string>>;
    readonly keepalive?: boolean;
    readonly signal?: AbortSignal | null;
  } = {},
  port: CodexHttpFetchPort = defaultPort,
): Promise<Response> {
  const signal = init.signal ?? undefined;
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  const request: CodexHttpFetchRequest = {
    requestId,
    url,
    method: init.method ?? "GET",
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(init.keepalive === undefined ? {} : { keepalive: init.keepalive }),
  };

  let rejectAborted: ((reason: unknown) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => {
    void port.cancel(requestId).catch(() => {});
    rejectAborted?.(abortError(signal as AbortSignal));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await Promise.race([port.fetch(request), aborted]);
    if (result.responseType === "error") throw new CodexHttpFetchError(result);
    return new Response(responseAllowsBody(result.status) ? Uint8Array.from(result.body) : null, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
