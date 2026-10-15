import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as BoundedQueue from "@t3tools/shared/BoundedQueue";

/** Counts an entire SSE event, including data split across lines and chunks. */
export const makeFrameGuard = (label: string, maxBytes = BoundedQueue.MAX_PROMPT_BYTES) => {
  let bytes = 0;
  let lineHasContent = false;
  let pendingCarriageReturn = false;
  return (chunk: Uint8Array): void => {
    BoundedQueue.assertFrameSize(chunk.byteLength, label, maxBytes);
    let frames = 0;
    for (const byte of chunk) {
      // CRLF is one line terminator, including when split across chunks.
      if (pendingCarriageReturn && byte === 10) {
        pendingCarriageReturn = false;
        if (bytes !== 0) {
          bytes++;
          BoundedQueue.assertFrameSize(bytes, label, maxBytes);
        }
        continue;
      }
      pendingCarriageReturn = false;
      bytes++;
      BoundedQueue.assertFrameSize(bytes, label, maxBytes);
      if (byte === 10 || byte === 13) {
        if (!lineHasContent) {
          bytes = 0;
          frames++;
          if (frames > BoundedQueue.DEFAULT_MAX_ITEMS) {
            throw new BoundedQueue.BufferOverflow({
              label,
              maxItems: BoundedQueue.DEFAULT_MAX_ITEMS,
              maxBytes,
            });
          }
        }
        lineHasContent = false;
        pendingCarriageReturn = byte === 13;
        continue;
      }
      lineHasContent = true;
    }
  };
};

/** Guards the SDK's SSE parser before it can retain an unfinished native frame. */
export const boundResponse = (
  response: Response,
  maxBytes = BoundedQueue.MAX_PROMPT_BYTES,
): Response => {
  if (
    response.body === null ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    return response;
  const reader = response.body.getReader();
  const guard = makeFrameGuard("OpenCode SSE frame", maxBytes);
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            reader.releaseLock();
            controller.close();
            return;
          }
          guard(next.value);
          controller.enqueue(next.value);
        } catch (cause) {
          // Notify the consumer before transport cleanup, so cancel/retirement
          // cannot wait behind a failed reader's native output.
          controller.error(cause);
          try {
            await reader.cancel(cause);
          } finally {
            reader.releaseLock();
          }
        }
      },
      cancel: (reason) => reader.cancel(reason).finally(() => reader.releaseLock()),
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
};

export const sdkFetch: typeof globalThis.fetch = async (input, init) => {
  const request = input instanceof Request && init === undefined ? input : new Request(input, init);
  // Preserve the pinned SDK's native fetch setting for long-lived subscriptions.
  (request as Request & { timeout: boolean }).timeout = false;
  return boundResponse(await globalThis.fetch(request));
};

/** Overflow retires this subscription rather than entering the SDK network-retry loop. */
export const subscribeEvents = (client: OpencodeClient, signal: AbortSignal) =>
  client.event.subscribe(undefined, {
    signal,
    onSseError: (cause) => {
      if (BoundedQueue.isOverflow(cause)) throw cause;
    },
  });
