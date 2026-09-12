import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  CODEX_ATTACH_AUTH_HEADER,
  type CodexHttpFetchFailure,
  type CodexHttpFetchRequest,
  type CodexHttpFetchResult,
} from "../../shared/codex-http-fetch";
import { extractChatGptAccountIdFromAuthToken } from "../codex/chatgpt-desktop-request";
import { ElectronNet, ElectronNetError } from "../platform/electron/ElectronNet";
import { ChatGptDesktop } from "./ChatGptDesktop";

const ATTACH_DESKTOP_SURFACE_HEADER = "X-OpenAI-Attach-Desktop-Surface";
const ATTACH_DEVICE_CHECK_TOKEN_HEADER = "X-OpenAI-Attach-DeviceCheck-Token";
const ATTACH_INTEGRITY_STATE_HEADER = "X-OpenAI-Attach-Integrity-State";
const EXPECTED_ACCOUNT_ID_HEADER = "X-OpenAI-Expected-Account-Id";

class CodexHttpFetchHttpError extends Schema.TaggedError<CodexHttpFetchHttpError>()(
  "CodexHttpFetchHttpError",
  {
    message: Schema.String,
    status: Schema.Number,
    responseStatus: Schema.NullOr(Schema.Number),
    errorCode: Schema.optional(Schema.String),
  },
) {}

const findHeaderKey = (headers: Readonly<Record<string, string>>, name: string): string | null => {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === lowerName) ?? null;
};

const hasHeader = (headers: Readonly<Record<string, string>>, name: string): boolean =>
  findHeaderKey(headers, name) !== null;

const setHeader = (headers: Record<string, string>, name: string, value: string): void => {
  const current = findHeaderKey(headers, name);
  if (current) delete headers[current];
  headers[name] = value;
};

const consumeBooleanControlHeader = (headers: Record<string, string>, name: string): boolean => {
  const key = findHeaderKey(headers, name);
  if (!key) return false;
  const value = headers[key] ?? "";
  delete headers[key];
  return value !== "0" && value.toLowerCase() !== "false";
};

const consumeStringControlHeader = (
  headers: Record<string, string>,
  name: string,
): string | null => {
  const key = findHeaderKey(headers, name);
  if (!key) return null;
  const value = headers[key] ?? "";
  delete headers[key];
  return value;
};

export function isCodexDesktopAuthAllowedUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.host.toLowerCase();
  if (host === "localhost" || host === "localhost:8000") return true;
  if (host === "status.openai.com") return false;
  if (host === "openai.com" || host.endsWith(".openai.com")) return true;
  return host === "chatgpt.com" || (host.endsWith(".chatgpt.com") && !host.startsWith("ab."));
}

export function shouldInferCodexDesktopAuth(value: string): boolean {
  if (!isCodexDesktopAuthAllowedUrl(value)) return false;
  let pathname: string;
  try {
    pathname = new URL(value).pathname.replace(/\/+$/u, "");
  } catch {
    return false;
  }
  return (
    pathname === "/wham" ||
    pathname.startsWith("/wham/") ||
    pathname === "/api/wham" ||
    pathname.startsWith("/api/wham/") ||
    pathname === "/backend-api/wham" ||
    pathname.startsWith("/backend-api/wham/") ||
    pathname === "/backend-api/estuary/content" ||
    pathname.startsWith("/backend-api/estuary/content/")
  );
}

const parseErrorCode = (body: string): string | undefined => {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const direct = record.error_code ?? record.file_parse_error_code ?? record.code;
    if (typeof direct === "string" && direct.length > 0) return direct;
    for (const key of ["extra", "error", "detail"] as const) {
      const nested = record[key];
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
      const nestedRecord = nested as Record<string, unknown>;
      const nestedCode =
        nestedRecord.error_code ?? nestedRecord.file_parse_error_code ?? nestedRecord.code;
      if (typeof nestedCode === "string" && nestedCode.length > 0) return nestedCode;
      const nestedError = nestedRecord.error;
      if (!nestedError || typeof nestedError !== "object" || Array.isArray(nestedError)) continue;
      const nestedErrorRecord = nestedError as Record<string, unknown>;
      const nestedErrorCode =
        nestedErrorRecord.error_code ??
        nestedErrorRecord.file_parse_error_code ??
        nestedErrorRecord.code;
      if (typeof nestedErrorCode === "string" && nestedErrorCode.length > 0) return nestedErrorCode;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const responseHeaders = (headers: Headers): Readonly<Record<string, string>> =>
  Object.fromEntries(headers.entries());

const responseBytes = (response: Response) =>
  Effect.tryPromise({
    try: () => response.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
    catch: (cause) =>
      new CodexHttpFetchHttpError({
        message: cause instanceof Error ? cause.message : "Failed to read HTTP response body",
        status: 500,
        responseStatus: response.status,
      }),
  });

const responseText = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: () => response.statusText || `Request failed with status ${response.status}`,
  }).pipe(
    Effect.catch((fallback) => Effect.succeed(fallback)),
    Effect.map(
      (body) => body || response.statusText || `Request failed with status ${response.status}`,
    ),
  );

const failure = (
  requestId: string,
  input: {
    readonly status: number;
    readonly error: string;
    readonly errorCode?: string;
    readonly responseStatus: number | null;
    readonly errorKind?: string;
  },
): CodexHttpFetchFailure => ({
  responseType: "error",
  requestId,
  status: input.status,
  error: input.error,
  ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  responseStatus: input.responseStatus,
  ...(input.errorKind ? { errorKind: input.errorKind } : {}),
});

const unwrapElectronNetCause = (error: ElectronNetError): unknown => error.cause;

const isAbortError = (value: unknown): boolean =>
  value instanceof Error &&
  (value.name === "AbortError" || value.message.startsWith("net::ERR_ABORTED"));

export class CodexHttpFetch extends Context.Service<
  CodexHttpFetch,
  {
    readonly fetch: (request: CodexHttpFetchRequest) => Effect.Effect<CodexHttpFetchResult>;
    readonly cancel: (requestId: string) => Effect.Effect<void>;
  }
>()("nodex/main/codex-application/CodexHttpFetch") {}

export const live: Layer.Layer<CodexHttpFetch, never, ChatGptDesktop | ElectronNet> = Layer.effect(
  CodexHttpFetch,
  Effect.gen(function* () {
    const chatgpt = yield* ChatGptDesktop;
    const network = yield* ElectronNet;
    const abortControllers = new Map<string, AbortController>();

    const readAuthToken = (refreshToken: boolean, errorStatus: number, message: string) =>
      chatgpt.authStatus(true, refreshToken).pipe(
        Effect.map((status) =>
          typeof status.authToken === "string" && status.authToken.length > 0
            ? status.authToken
            : null,
        ),
        Effect.mapError(
          () =>
            new CodexHttpFetchHttpError({
              message,
              status: errorStatus,
              responseStatus: null,
            }),
        ),
        Effect.flatMap((token) =>
          token
            ? Effect.succeed(token)
            : Effect.fail(
                new CodexHttpFetchHttpError({
                  message,
                  status: errorStatus,
                  responseStatus: null,
                }),
              ),
        ),
      );

    const runFetch = Effect.fn("CodexHttpFetch.runFetch")(function* (
      request: CodexHttpFetchRequest,
      controller: AbortController,
    ) {
      const headers: Record<string, string> = { ...request.headers };
      const explicitAttachAuth = consumeBooleanControlHeader(headers, CODEX_ATTACH_AUTH_HEADER);
      const attachDesktopSurface = consumeBooleanControlHeader(
        headers,
        ATTACH_DESKTOP_SURFACE_HEADER,
      );
      const attachDeviceCheck = consumeBooleanControlHeader(
        headers,
        ATTACH_DEVICE_CHECK_TOKEN_HEADER,
      );
      const attachIntegrityState = consumeBooleanControlHeader(
        headers,
        ATTACH_INTEGRITY_STATE_HEADER,
      );
      consumeStringControlHeader(headers, EXPECTED_ACCOUNT_ID_HEADER);

      if (attachDesktopSurface || attachDeviceCheck || attachIntegrityState) {
        return yield* Effect.fail(
          new CodexHttpFetchHttpError({
            message: "Unsupported desktop HTTP control header",
            status: 400,
            responseStatus: null,
          }),
        );
      }

      const attachAuth =
        (explicitAttachAuth || shouldInferCodexDesktopAuth(request.url)) &&
        !hasHeader(headers, "authorization");
      if (attachAuth && !isCodexDesktopAuthAllowedUrl(request.url)) {
        return yield* Effect.fail(
          new CodexHttpFetchHttpError({
            message: "Refusing to attach authentication to non-OpenAI URL",
            status: 400,
            responseStatus: null,
          }),
        );
      }

      const fetchOnce = (authToken: string | null) => {
        const attemptHeaders = { ...headers };
        if (authToken) {
          setHeader(attemptHeaders, "Authorization", `Bearer ${authToken}`);
          const accountId = extractChatGptAccountIdFromAuthToken(authToken);
          if (accountId) setHeader(attemptHeaders, "ChatGPT-Account-Id", accountId);
        }
        const body =
          request.body instanceof Uint8Array ? Uint8Array.from(request.body) : request.body;
        return network.fetch(request.url, {
          method: request.method,
          headers: attemptHeaders,
          ...(body === undefined ? {} : { body }),
          ...(request.keepalive === undefined ? {} : { keepalive: request.keepalive }),
          credentials: "same-origin",
          signal: controller.signal,
        });
      };

      let authToken = attachAuth
        ? yield* readAuthToken(false, 432, "Failed to retrieve authentication token")
        : null;
      let response = yield* fetchOnce(authToken);
      if (response.status === 401 && attachAuth && authToken) {
        const responseBody = response.body;
        if (responseBody) yield* Effect.tryPromise(() => responseBody.cancel()).pipe(Effect.ignore);
        authToken = yield* readAuthToken(true, 401, "Failed to refresh authentication token");
        response = yield* fetchOnce(authToken);
      }

      if (!response.ok) {
        const body = yield* responseText(response);
        return failure(request.requestId, {
          status: response.status,
          error: body,
          errorCode: parseErrorCode(body),
          responseStatus: response.status,
        });
      }

      return {
        responseType: "success" as const,
        requestId: request.requestId,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response.headers),
        body: yield* responseBytes(response),
      };
    });

    const fetch = (request: CodexHttpFetchRequest): Effect.Effect<CodexHttpFetchResult> => {
      const controller = new AbortController();
      abortControllers.set(request.requestId, controller);
      return runFetch(request, controller).pipe(
        Effect.catch((error) => {
          if (error instanceof CodexHttpFetchHttpError) {
            return Effect.succeed(
              failure(request.requestId, {
                status: error.status,
                error: error.message,
                errorCode: error.errorCode,
                responseStatus: error.responseStatus,
              }),
            );
          }
          const cause = error instanceof ElectronNetError ? unwrapElectronNetCause(error) : error;
          return Effect.succeed(
            failure(request.requestId, {
              status: controller.signal.aborted || isAbortError(cause) ? 499 : 500,
              error: cause instanceof Error ? cause.message : "Unknown error",
              responseStatus: null,
              ...(controller.signal.aborted || isAbortError(cause) ? {} : { errorKind: "network" }),
            }),
          );
        }),
        Effect.catchCause((cause) =>
          Effect.succeed(
            failure(request.requestId, {
              status: controller.signal.aborted ? 499 : 500,
              error: Cause.pretty(cause),
              responseStatus: null,
              ...(controller.signal.aborted ? {} : { errorKind: "network" }),
            }),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (abortControllers.get(request.requestId) === controller) {
              abortControllers.delete(request.requestId);
            }
          }),
        ),
      );
    };

    return CodexHttpFetch.of({
      fetch,
      cancel: (requestId) =>
        Effect.sync(() => {
          const controller = abortControllers.get(requestId);
          if (!controller) return;
          controller.abort(new DOMException("The operation was aborted", "AbortError"));
          abortControllers.delete(requestId);
        }),
    });
  }),
);
