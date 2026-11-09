import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { fromBase64, toBase64, encodeUtf8 } from "./encoding";

export const TLS_BODY_LIMIT = 8 * 1024 * 1024;
export const TLS_FRAME_LIMIT = 1024 * 1024;
export type TlsErrorCode = "invalid" | "pin" | "timeout" | "limit" | "transport" | "closed";
export class PinnedTlsFailure extends Data.TaggedError("PinnedTlsFailure")<{
  readonly code: TlsErrorCode;
}> {}
export type PinnedEndpoint = {
  url: string;
  /** SHA-256 of the complete leaf certificate DER, never SPKI. */
  fingerprint: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};
export type PinnedRequest = PinnedEndpoint & { method?: string; body?: Uint8Array };
export type PinnedResponse = { status: number; headers: Record<string, string>; body: Uint8Array };
export type TlsEvent =
  | { type: "open" }
  | { type: "response"; status: number; headers: Record<string, string>; body: string }
  | { type: "message"; text?: string; body?: string }
  | { type: "close"; code: number }
  | { type: "error"; code: TlsErrorCode };
export type NativeTlsOptions = {
  url: string;
  fingerprint: string;
  headers: Record<string, string>;
  timeoutMs: number;
  method: string;
  body: string;
};
/** Synchronous admission/cancellation prevents a cancelled, queued start from leaking a handle. */
export interface NativePinnedTls {
  listen(id: string, event: (event: TlsEvent) => void): () => void;
  startRequest(id: string, options: NativeTlsOptions): void;
  openSocket(id: string, options: NativeTlsOptions): void;
  send(id: string, body: string, binary: boolean): void;
  cancel(id: string): void;
}

function options(input: PinnedRequest, socket: boolean): NativeTlsOptions {
  const url = new URL(input.url);
  const timeoutMs = input.timeoutMs ?? 15_000;
  const method = input.method ?? "GET";
  if (
    url.protocol !== (socket ? "wss:" : "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    !/^[a-f0-9]{64}$/iu.test(input.fingerprint) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000 ||
    !/^[A-Z]+$/u.test(method) ||
    method === "CONNECT" ||
    method === "TRACE" ||
    ((method === "GET" || method === "HEAD") && input.body !== undefined) ||
    (input.body?.length ?? 0) > TLS_BODY_LIMIT
  )
    throw new PinnedTlsFailure({ code: "invalid" });
  const headers = input.headers ?? {};
  if (
    Object.entries(headers).some(
      ([key, value]) =>
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(key) ||
        /[\r\n\0]/u.test(value) ||
        /^(host|connection|upgrade|content-length|transfer-encoding|sec-websocket-.*)$/iu.test(key),
    ) ||
    Object.entries(headers).reduce((size, [key, value]) => size + key.length + value.length, 0) >
      16_384
  )
    throw new PinnedTlsFailure({ code: "invalid" });
  return {
    url: url.href,
    fingerprint: input.fingerprint.toLowerCase(),
    headers,
    timeoutMs,
    method,
    body: toBase64(input.body ?? new Uint8Array()),
  };
}

/** The connection owner supplies verified enrollment pins and scoped Device sessions. */
export function makePinnedTls(native: NativePinnedTls) {
  let sequence = 0;
  const acquire = Effect.fn("PinnedTls.acquire")(function* (input: PinnedRequest, socket: boolean) {
    const config = yield* Effect.try({
      try: () => options(input, socket),
      catch: () => new PinnedTlsFailure({ code: "invalid" }),
    });
    const id = `tls-${++sequence}`;
    const queue = yield* Queue.dropping<TlsEvent>(128);
    const failed = yield* Deferred.make<never, PinnedTlsFailure>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        native.listen(id, (event) => {
          if (Queue.offerUnsafe(queue, event)) return;
          Deferred.doneUnsafe(failed, Effect.fail(new PinnedTlsFailure({ code: "limit" })));
          native.cancel(id);
        }),
      ),
      (remove) => Effect.sync(remove),
    );
    // Register release before starting, including starts that throw after partial admission.
    yield* Effect.addFinalizer(() => Effect.sync(() => native.cancel(id)));
    yield* Effect.try({
      try: () => (socket ? native.openSocket(id, config) : native.startRequest(id, config)),
      catch: () => new PinnedTlsFailure({ code: "transport" }),
    });
    const take = Effect.raceFirst(Deferred.await(failed), Queue.take(queue)).pipe(
      Effect.flatMap((event) =>
        event.type === "error"
          ? Effect.fail(new PinnedTlsFailure({ code: event.code }))
          : Effect.succeed(event),
      ),
    );
    return {
      id,
      take,
      fail: (error: PinnedTlsFailure) => {
        Deferred.doneUnsafe(failed, Effect.fail(error));
        native.cancel(id);
      },
    };
  });
  const request = (input: PinnedRequest) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operation = yield* acquire(input, false);
        const event = yield* operation.take;
        if (event.type !== "response") return yield* new PinnedTlsFailure({ code: "transport" });
        return yield* Effect.try({
          try: () => {
            if (event.body.length > Math.ceil(TLS_BODY_LIMIT / 3) * 4) throw new Error();
            const body = fromBase64(event.body);
            if (body.length > TLS_BODY_LIMIT) throw new Error();
            return { status: event.status, headers: event.headers, body } satisfies PinnedResponse;
          },
          catch: () => new PinnedTlsFailure({ code: "limit" }),
        });
      }),
    );
  const openSocket = Effect.fn("PinnedTls.openSocket")(function* (input: PinnedEndpoint) {
    const operation = yield* acquire(input, true);
    const first = yield* operation.take.pipe(
      Effect.timeoutOrElse({
        duration: input.timeoutMs ?? 15_000,
        orElse: () => Effect.fail(new PinnedTlsFailure({ code: "timeout" })),
      }),
      Effect.tapError((error) => Effect.sync(() => operation.fail(error))),
    );
    if (first.type !== "open") return yield* new PinnedTlsFailure({ code: "closed" });
    return {
      take: operation.take.pipe(
        Effect.flatMap((event) =>
          Effect.try({
            try: () => {
              if (event.type === "close") return { type: "close" as const, code: event.code };
              if (event.type !== "message") throw new Error();
              const data = event.text ?? fromBase64(event.body ?? "");
              if (
                (typeof data === "string" ? encodeUtf8(data).length : data.length) > TLS_FRAME_LIMIT
              )
                throw new Error();
              return { type: "message" as const, data };
            },
            catch: () => new PinnedTlsFailure({ code: "limit" }),
          }),
        ),
      ),
      send: (data: string | Uint8Array) =>
        Effect.try({
          try: () => {
            const bytes = typeof data === "string" ? encodeUtf8(data) : data;
            if (bytes.length > TLS_FRAME_LIMIT) throw new PinnedTlsFailure({ code: "limit" });
            native.send(
              operation.id,
              typeof data === "string" ? data : toBase64(data),
              typeof data !== "string",
            );
          },
          catch: (cause) =>
            cause instanceof PinnedTlsFailure ? cause : new PinnedTlsFailure({ code: "transport" }),
        }).pipe(Effect.tapError((error) => Effect.sync(() => operation.fail(error)))),
      close: Effect.sync(() => native.cancel(operation.id)),
    };
  });
  return { request, openSocket };
}
export type PinnedTls = ReturnType<typeof makePinnedTls>;
