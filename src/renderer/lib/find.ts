import { useEffect, useState } from "react";
import type { FindPhase, FindRequest, FindResponse } from "../../shared/find";
import { invokeRendererControl, invokeRendererQuery } from "./renderer-command";

export async function findContent(
  request: FindRequest,
  phase: FindPhase = "complete",
  signal?: AbortSignal,
  requestId = signal ? globalThis.crypto.randomUUID() : undefined,
) {
  signal?.throwIfAborted();
  const cancel = () => {
    if (requestId) void invokeRendererControl("find:cancel", requestId).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await invokeRendererQuery("find:search", request, phase, requestId);
    signal?.throwIfAborted();
    if (!result || !Array.isArray(result.hits)) throw new Error("Find returned an invalid result");
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

interface FindState {
  readonly key: string;
  readonly scopeKey: string;
  readonly query: string;
  readonly response: FindResponse | null;
  readonly pending: boolean;
}

export function useFind(
  request: FindRequest,
  { enabled = true, complete = true, refreshKey = 0 } = {},
) {
  const input = JSON.stringify({ ...request, query: request.query.trim() });
  const key = JSON.stringify([input, complete, refreshKey]);
  const scopeKey = JSON.stringify([{ ...request, query: undefined }, refreshKey]);
  const [state, setState] = useState<FindState | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const requestId = globalThis.crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const search = JSON.parse(input) as FindRequest;
    const accept = (response: FindResponse | null, pending: boolean) =>
      setState({ key, scopeKey, query: search.query, response, pending });
    const load = async () => {
      const instant = await findContent(search, "instant", controller.signal, requestId).catch(
        () => null,
      );
      if (controller.signal.aborted) return;
      const pending =
        complete &&
        (search.query.length > 0 ||
          (instant?.coverage.some(({ state }) => state === "pending") ?? false));
      accept(instant, pending);
      if (!pending) return;
      timer = setTimeout(() => {
        void findContent(search, "complete", controller.signal, requestId).then(
          (response) => {
            if (!controller.signal.aborted) accept(response, false);
          },
          () => {
            if (!controller.signal.aborted) accept(instant, false);
          },
        );
      }, 150);
    };
    void load();
    return () => {
      controller.abort();
      void invokeRendererControl("find:cancel", requestId).catch(() => undefined);
      clearTimeout(timer);
    };
  }, [input, key, enabled, complete, scopeKey]);

  const fresh = enabled && state?.key === key;
  return {
    response: fresh ? state.response : null,
    previous: enabled && !fresh && state?.scopeKey === scopeKey ? state : null,
    pending: enabled && (!fresh || state.pending),
    failed: fresh && !state.pending && !state.response,
    settled: fresh,
  };
}
