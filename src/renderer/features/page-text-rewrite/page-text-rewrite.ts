import type {
  PageTextRewriteInput,
  PageTextRewriteResult,
} from "../../../shared/page-text-rewrite";
import { pageTextRewriteRuntime } from "../../lib/page-text-rewrite-runtime";

export type {
  PageTextRewriteInput,
  PageTextRewriteResult,
} from "../../../shared/page-text-rewrite";

export interface PageTextRewriteHandle {
  readonly requestId: string;
  readonly result: Promise<PageTextRewriteResult>;
  /** Discard, Try again and owner disposal must cancel the old handle. */
  cancel(): Promise<void>;
}

/** Owns exact-attempt settlement; no editor or document mutation is available here. */
export const createPageTextRewrite = (runtime: typeof pageTextRewriteRuntime) => ({
  start(input: PageTextRewriteInput): PageTextRewriteHandle {
    const requestId = crypto.randomUUID();
    let settled = false;
    let cancelled = false;
    let resolve!: (result: PageTextRewriteResult) => void;
    const result = new Promise<PageTextRewriteResult>((accept) => {
      resolve = accept;
    });
    let unsubscribe = () => {};
    const finish = (outcome: PageTextRewriteResult) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(outcome);
    };
    unsubscribe = runtime.subscribe((event) => {
      if (event.requestId !== requestId || cancelled) return;
      finish(event);
    });
    const admitted = runtime
      .start({ requestId, input })
      .then((response) => {
        if (!response.ok && !cancelled) finish({ kind: "error", error: response.error });
        return response.ok;
      })
      .catch(() => {
        if (!cancelled)
          finish({
            kind: "error",
            error: { code: "generation_failed", message: "The rewrite could not start. Try again" },
          });
        return false;
      });
    let cancellation: Promise<void> | undefined;
    return {
      requestId,
      result,
      cancel() {
        if (cancellation) return cancellation;
        if (settled) return Promise.resolve();
        cancelled = true;
        finish({ kind: "cancelled" });
        // Admission must precede cancellation even when the user immediately discards.
        cancellation = admitted.then(async (accepted) => {
          if (accepted) await runtime.cancel(requestId);
        });
        return cancellation;
      },
    };
  },
});

export const pageTextRewrite = createPageTextRewrite(pageTextRewriteRuntime);
