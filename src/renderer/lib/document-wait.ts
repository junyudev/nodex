export const DOCUMENT_STRUCTURAL_WAIT_TIMEOUT_MS = 10_000;

/** A caller's waiting budget; cancelling it never discards a durable update. */
export interface DocumentWaitOptions {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

export class DocumentWaitError extends Error {
  constructor(readonly reason: "cancelled" | "timeout") {
    super(
      reason === "cancelled"
        ? "The structural edit was cancelled."
        : "Changes are still waiting to save. Reconnect and try the structural edit again.",
    );
    this.name = "DocumentWaitError";
  }
}

export const assertDocumentWaitActive = (options: DocumentWaitOptions): void => {
  if (options.signal?.aborted) throw new DocumentWaitError("cancelled");
  if (options.deadlineAt === undefined) return;
  if (!Number.isFinite(options.deadlineAt)) throw new TypeError("Document deadline must be finite");
  if (Date.now() >= options.deadlineAt) throw new DocumentWaitError("timeout");
};

/** Settle only this observer and remove its listeners. Late completion cannot resume the caller. */
export const waitForDocumentOperation = <Value>(
  operation: () => Promise<Value>,
  options: DocumentWaitOptions = {},
): Promise<Value> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancel);
      action();
    };
    const cancel = (): void => finish(() => reject(new DocumentWaitError("cancelled")));
    try {
      assertDocumentWaitActive(options);
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.deadlineAt !== undefined) {
        timeout = setTimeout(
          () => finish(() => reject(new DocumentWaitError("timeout"))),
          Math.max(0, options.deadlineAt - Date.now()),
        );
      }
      operation().then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
