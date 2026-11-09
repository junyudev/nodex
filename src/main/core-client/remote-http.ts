import { createHash, timingSafeEqual } from "node:crypto";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import { connect } from "node:tls";
import type { Duplex } from "node:stream";
import type { CoreRequestOptions } from "./types";
import type { components } from "@nodex/core-protocol";
import { SpaceNameSchema } from "../../shared/space-connection";
import {
  CoreHttpError,
  CoreRateLimitError,
  CoreTransportError,
  LocalHttpTransport,
} from "./local-http";

export class RemoteCertificateError extends Error {
  constructor() {
    super("Remote Core certificate does not match the enrolled fingerprint");
    this.name = "RemoteCertificateError";
  }
}
/** Constructed only from pinned device-credential renewal, never an operation status. */
export class RemoteAccessWithdrawnError extends CoreHttpError {
  constructor(error: CoreHttpError) {
    super(error.status, error.message, error.failure, error.coreError);
    this.name = "RemoteAccessWithdrawnError";
  }
}
export interface RemoteEndpoint {
  readonly url: string;
  /** SHA-256 of the complete leaf DER certificate, obtained from the Owner. */
  readonly fingerprint: string;
}
export interface RemoteCoreConnectionInput extends RemoteEndpoint {
  readonly deviceCredential: string;
  readonly spaceId: string;
  readonly buildId: string;
  readonly projectId?: string;
  readonly signal?: AbortSignal;
}
type EnrollmentRequest = components["schemas"]["EnrollmentRequest"];
type EnrollmentResponse = components["schemas"]["EnrollmentResponse"];
type SessionResponse = components["schemas"]["SessionResponse"];

const endpoint = (input: RemoteEndpoint): URL => {
  const url = new URL(input.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Remote Core requires an HTTPS origin");
  }
  if (!/^[a-f0-9]{64}$/iu.test(input.fingerprint))
    throw new Error("Invalid SHA-256 certificate fingerprint");
  return url;
};

/** Do not hand a socket to HTTP until the pin is verified. This also protects
 * enrollment and session credentials when a private CA is not installed. */
class PinnedAgent extends Agent {
  constructor(readonly fingerprint: string) {
    // One credential owns this bounded pool; ordinary reads must not spend a TLS admission each.
    super({
      keepAlive: true,
      maxCachedSessions: 0,
      maxSockets: 16,
      maxFreeSockets: 16,
      timeout: 15_000,
    });
  }
  override createConnection(
    options: RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): undefined {
    const socket = connect({
      host: options.hostname ?? options.host ?? "localhost",
      port: Number(options.port ?? 443),
      servername: options.servername,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    });
    let delivered = false;
    const fail = (error: Error): void => {
      if (delivered) return;
      delivered = true;
      clearTimeout(deadline);
      callback?.(error, socket);
      socket.destroy();
    };
    const deadline = setTimeout(
      () => fail(new CoreTransportError("timeout", "connect", "ETIMEDOUT", null)),
      5_000,
    );
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate().raw;
      if (
        !raw ||
        !timingSafeEqual(
          createHash("sha256").update(raw).digest(),
          Buffer.from(this.fingerprint, "hex"),
        )
      ) {
        fail(new RemoteCertificateError());
        return;
      }
      if (delivered) return;
      delivered = true;
      clearTimeout(deadline);
      socket.setTimeout(0);
      callback?.(null, socket);
    });
    return undefined;
  }
}

const connection = (input: RemoteEndpoint) => {
  const url = endpoint(input);
  return {
    request: httpsRequest,
    maximumQueuedRequests: 64,
    options: {
      socketPath: undefined,
      protocol: "https:",
      hostname: url.hostname.replace(/^\[|\]$/gu, ""),
      port: url.port || 443,
      agent: new PinnedAgent(input.fingerprint),
    },
  };
};

/** One enrollment attempt. A lost response requires a new Owner-issued invite. */
export const enrollRemoteCore = (
  input: RemoteEndpoint,
  request: EnrollmentRequest,
  signal?: AbortSignal,
): Promise<EnrollmentResponse> => {
  const transport = new LocalHttpTransport("", "", {
    connection: { ...connection(input), credential: () => "" },
  });
  return transport
    .requestJson<EnrollmentResponse>("POST", "/enroll", request, {}, { signal })
    .then((response) => ({ ...response, space_name: SpaceNameSchema.parse(response.space_name) }));
};

/** Cancelling one HTTP caller must not withdraw a shared device renewal. */
const waitForSession = (renewal: Promise<void>, signal?: AbortSignal): Promise<void> => {
  if (!signal) return renewal;
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new CoreTransportError("aborted", "connect", "ABORT_ERR", signal.reason));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void renewal.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
};

const remoteAbort = (signal: AbortSignal): CoreTransportError =>
  new CoreTransportError(
    signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
      ? "timeout"
      : "aborted",
    "response",
    signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
      ? "ETIMEDOUT"
      : "ABORT_ERR",
    signal.reason,
  );
const waitForRemoteRequest = <A>(request: Promise<A>, signal?: AbortSignal): Promise<A> => {
  if (!signal) return request;
  return new Promise((resolve, reject) => {
    const abort = () => reject(remoteAbort(signal));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
};
const remoteDelay = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(
        signal
          ? remoteAbort(signal)
          : new CoreTransportError("aborted", "response", "ABORT_ERR", null),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });

interface SharedRemoteRead {
  readonly request: Promise<unknown>;
  readonly controller: AbortController;
  waiters: number;
  settled: boolean;
}

/** Same bounded HTTP and SSE interface as the local adapter. Renewal is
 * single-flight on demand at the Core boundary; no background runtime is created. */
export class RemoteHttpTransport extends LocalHttpTransport {
  readonly #reads = new Map<string, SharedRemoteRead>();
  #pending = 0;
  #waiters = 0;
  #retryAt = 0;

  override async requestJson<Response>(
    method: "GET" | "POST",
    requestPath: string,
    body?: unknown,
    headers: Readonly<Record<string, string>> = {},
    options: CoreRequestOptions = {},
  ): Promise<Response> {
    if (options.signal?.aborted) throw remoteAbort(options.signal);
    if (this.#waiters >= 64)
      throw new CoreRateLimitError(
        new CoreHttpError(429, "Remote client waiter queue is full"),
        1_000,
      );
    this.#waiters += 1;
    try {
      const read =
        method === "GET" ||
        requestPath.endsWith("/read") ||
        (requestPath === "/core/v1/host/call" &&
          typeof body === "object" &&
          body !== null &&
          "operation" in body &&
          [
            "session_read",
            "session_control",
            "session_inspect",
            "session_history",
            "session_prompt_turns",
            "session_prompt_index",
            "session_queue_read",
            "session_item",
            "session_attachment",
            "session_overview",
            "activity",
            "connection",
            "providers",
          ].includes(String(body.operation)));
      const key = read
        ? JSON.stringify([method, requestPath, body, headers, options.class, options.deadlineMs])
        : null;
      const existing = key === null ? undefined : this.#reads.get(key);
      if (existing && key !== null)
        return await this.#waitForRead<Response>(key, existing, options.signal);
      if (this.#pending >= 64)
        throw new CoreRateLimitError(
          new CoreHttpError(429, "Remote client request queue is full"),
          1_000,
        );
      this.#pending += 1;
      const controller = read ? new AbortController() : undefined;
      let shared: SharedRemoteRead | undefined;
      const pending = this.#requestWithBackoff<Response>(
        method,
        requestPath,
        body,
        headers,
        controller ? { ...options, signal: controller.signal } : options,
      ).finally(() => {
        this.#pending -= 1;
        if (!shared || key === null) return;
        shared.settled = true;
        if (this.#reads.get(key) === shared) this.#reads.delete(key);
      });
      if (key !== null && controller) {
        shared = { request: pending, controller, waiters: 0, settled: false };
        this.#reads.set(key, shared);
        return await this.#waitForRead<Response>(key, shared, options.signal);
      }
      return await waitForRemoteRequest(pending, options.signal);
    } finally {
      this.#waiters -= 1;
    }
  }

  async #waitForRead<Response>(
    key: string,
    shared: SharedRemoteRead,
    signal?: AbortSignal,
  ): Promise<Response> {
    shared.waiters += 1;
    try {
      return await waitForRemoteRequest(shared.request as Promise<Response>, signal);
    } finally {
      shared.waiters -= 1;
      // Shared reads belong to their callers, including while waiting for backoff.
      if (shared.waiters === 0 && !shared.settled) {
        if (this.#reads.get(key) === shared) this.#reads.delete(key);
        shared.controller.abort();
      }
    }
  }

  async #requestWithBackoff<Response>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>>,
    options: CoreRequestOptions,
  ): Promise<Response> {
    const deadline = Date.now() + 90_000;
    const timeout = AbortSignal.timeout(90_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    for (let attempt = 0; ; attempt += 1) {
      const delay = this.#retryAt - Date.now();
      if (delay > 0) await remoteDelay(delay, signal);
      try {
        return await waitForRemoteRequest(
          super.requestJson<Response>(method, path, body, headers, { ...options, signal }),
          signal,
        );
      } catch (error) {
        if (!(error instanceof CoreRateLimitError)) throw error;
        // Every caller shares the host's cooldown, including after this call gives up.
        this.#retryAt = Math.max(this.#retryAt, Date.now() + error.retryAfterMs);
        if (attempt >= 2 || this.#retryAt >= deadline) throw error;
      }
    }
  }

  constructor(input: RemoteCoreConnectionInput) {
    const physical = connection(input);
    const state: { token: string; expiresAt: number; renewing: Promise<void> | null } = {
      token: "",
      expiresAt: 0,
      renewing: null,
    };
    const auth = new LocalHttpTransport("", "", {
      connection: { ...physical, credential: () => "" },
    });
    const beforeRequest = async (signal?: AbortSignal): Promise<void> => {
      if (Date.now() < state.expiresAt - 60_000) return;
      if (state.renewing) return waitForSession(state.renewing, signal);
      state.renewing = auth
        .requestJson<SessionResponse>(
          "POST",
          "/session",
          { device_credential: input.deviceCredential },
          {},
        )
        .catch((error: unknown) => {
          if (
            error instanceof CoreHttpError &&
            error.coreError?.recovery.kind === "remote_access_withdrawn"
          )
            throw new RemoteAccessWithdrawnError(error);
          throw error;
        })
        .then((session) => {
          if (
            session.principal.space_id !== input.spaceId ||
            !/^[a-f0-9]{64}$/u.test(session.session_token) ||
            !Number.isSafeInteger(session.expires_at)
          ) {
            throw new Error("Remote Core returned an invalid session identity");
          }
          state.token = session.session_token;
          state.expiresAt = session.expires_at * 1000;
        })
        .finally(() => {
          state.renewing = null;
        });
      return waitForSession(state.renewing, signal);
    };
    super("", "", {
      connection: {
        ...physical,
        credential: () => state.token,
        beforeRequest,
        streamIdleTimeoutMs: 45_000,
      },
    });
  }
}
