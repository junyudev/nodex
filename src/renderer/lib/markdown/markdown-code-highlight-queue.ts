import type { HighlightResult } from "@streamdown/code";
import type { CODE_BLOCK_SYNTAX_THEME_NAME } from "../code-block-syntax-theme";

export const CODE_HIGHLIGHT_IDLE_MS = 30_000;
export const CODE_HIGHLIGHT_INTERVAL_MS = 120;
export const CODE_HIGHLIGHT_VIEWPORT_MARGIN = 600;
export const MAX_WORKER_CODE_UNITS = 256 * 1024;
export const MAX_FALLBACK_CODE_UNITS = 64 * 1024;

export interface CodeHighlightRequest {
  readonly code: string;
  readonly language: string;
  readonly theme: typeof CODE_BLOCK_SYNTAX_THEME_NAME;
  readonly incomplete: boolean;
}

export type CodeHighlightTokens = Omit<HighlightResult, "grammarState">;
export type CodeHighlightResult = CodeHighlightRequest & { readonly paint: CodeHighlightTokens };
export type CodeHighlightWorker = Pick<Worker, "addEventListener" | "postMessage" | "terminate">;

type Cancel = () => void;
export type RequestCodeHighlight = (
  input: CodeHighlightRequest,
  onResult: (result: CodeHighlightResult) => void,
  canFallback: () => boolean,
) => Cancel;
type HighlightEngine = (input: CodeHighlightRequest) => Promise<CodeHighlightTokens | null>;
type Job = {
  readonly input: CodeHighlightRequest;
  readonly canFallback: () => boolean;
  onResult: ((result: CodeHighlightResult) => void) | null;
};

/** One renderer-wide queue. A running job may populate the engine cache after its view leaves. */
export function createCodeHighlightQueue(
  createWorker: () => CodeHighlightWorker,
  loadFallback: () => Promise<HighlightEngine>,
): RequestCodeHighlight {
  const waiting = new Set<Job>();
  let active: Job | undefined;
  let worker: CodeHighlightWorker | undefined;
  let workerListeners: AbortController | undefined;
  let disabled = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let fallback: Promise<HighlightEngine> | undefined;

  function retireWorker() {
    if (!worker) return;
    workerListeners?.abort();
    worker.terminate();
    workerListeners = undefined;
    worker = undefined;
  }

  function finish(paint: CodeHighlightTokens | null) {
    const job = active;
    active = undefined;
    try {
      if (paint && job?.onResult) job.onResult({ ...job.input, paint });
    } finally {
      pump();
    }
  }

  async function runFallback(job: Job) {
    const eligible = () =>
      job.onResult && job.input.code.length <= MAX_FALLBACK_CODE_UNITS && job.canFallback();
    let paint: CodeHighlightTokens | null = null;
    // Do not recurse through a backlog of skipped or canceled jobs.
    await Promise.resolve();
    try {
      if (eligible()) {
        fallback ??= loadFallback();
        const highlight = await fallback;
        if (eligible()) paint = await highlight(job.input);
      }
    } catch {
      // Syntax paint is optional. The block already displays its complete source.
    }
    finish(paint);
  }

  function workerFailed() {
    disabled = true;
    retireWorker();
    if (active) void runFallback(active);
  }

  function pump() {
    if (active || idle !== undefined) return;
    const job = waiting.values().next().value;
    if (!job) {
      if (worker) {
        idle = setTimeout(() => {
          idle = undefined;
          retireWorker();
        }, CODE_HIGHLIGHT_IDLE_MS);
      }
      return;
    }
    waiting.delete(job);
    active = job;
    if (disabled) {
      void runFallback(job);
      return;
    }
    try {
      if (!worker) {
        worker = createWorker();
        workerListeners = new AbortController();
        const options = { signal: workerListeners.signal };
        worker.addEventListener(
          "message",
          ({ data }: MessageEvent<CodeHighlightTokens | null>) => {
            if (data === null) workerFailed();
            else finish(data);
          },
          options,
        );
        worker.addEventListener(
          "error",
          (event) => {
            event.preventDefault();
            workerFailed();
          },
          options,
        );
        worker.addEventListener("messageerror", workerFailed, options);
      }
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated worker messages use a port, not a window origin.
      worker.postMessage(job.input);
    } catch {
      workerFailed();
    }
  }

  return (input, onResult, canFallback) => {
    if (input.code.length > MAX_WORKER_CODE_UNITS) return () => {};
    if (idle !== undefined) {
      clearTimeout(idle);
      idle = undefined;
    }
    const job: Job = { input, onResult, canFallback };
    waiting.add(job);
    pump();
    return () => {
      waiting.delete(job);
      job.onResult = null;
    };
  };
}

/** Throttle starts, keeping the newest committed input for any trailing request. */
export function createCodeHighlightScheduler(
  request: RequestCodeHighlight,
  onResult: (result: CodeHighlightResult) => void,
) {
  let latest: { input: CodeHighlightRequest; canFallback: () => boolean } | undefined;
  let startedAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: Cancel | undefined;
  function start() {
    timer = undefined;
    if (!latest) return;
    startedAt = performance.now();
    cancel?.();
    cancel = request(latest.input, onResult, latest.canFallback);
  }
  return {
    update(input: CodeHighlightRequest, canFallback: () => boolean) {
      latest = { input, canFallback };
      if (timer !== undefined) return;
      const delay = CODE_HIGHLIGHT_INTERVAL_MS - (performance.now() - startedAt);
      if (delay <= 0) start();
      else timer = setTimeout(start, delay);
    },
    cancel() {
      latest = undefined;
      cancel?.();
      cancel = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      startedAt = -Infinity;
    },
  };
}
