import type { DictationHttpDiagnostics } from "../../shared/dictation-diagnostics";

/** Measures the client boundary. Header wait includes authentication, upload and server wait. */
export class DictationRequestDiagnostics {
  readonly #startedAt: number;
  #headersAt: number | undefined;
  readonly #value: DictationHttpDiagnostics;

  constructor(
    operation: DictationHttpDiagnostics["operation"],
    requestId: string,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.#startedAt = now();
    this.#value = {
      operation,
      requestId,
      endpoint: operation === "cleanup" ? "/codex/responses" : "/transcribe",
      ...(operation === "cleanup" ? { model: "gpt-5.6-luna" as const } : {}),
      outcome: "failed",
      totalMs: 0,
      attempts: 0,
    };
  }

  readonly sentHeaders = (headers: Headers): void => {
    this.#value.attempts += 1;
    this.#value.headers = {
      originator: (headers.get("originator") ?? "").slice(0, 160),
      userAgent: (headers.get("user-agent") ?? "").slice(0, 256),
      authorizationPresent: headers.has("authorization"),
      accountHeaderPresent: headers.has("chatgpt-account-id"),
    };
  };

  response(response: Response): void {
    this.#headersAt = this.now();
    this.#value.headersMs = Math.max(0, this.#headersAt - this.#startedAt);
    this.#value.status = response.status;
    const responseId = response.headers.get("x-request-id");
    if (responseId && /^[A-Za-z0-9_-]{1,160}$/u.test(responseId)) {
      this.#value.responseId = responseId;
    }
  }

  finish(outcome: DictationHttpDiagnostics["outcome"]): DictationHttpDiagnostics {
    const endedAt = this.now();
    return {
      ...this.#value,
      outcome,
      totalMs: Math.max(0, endedAt - this.#startedAt),
      ...(this.#headersAt === undefined ? {} : { bodyMs: Math.max(0, endedAt - this.#headersAt) }),
    };
  }
}
