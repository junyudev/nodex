import * as Effect from "effect/Effect";
import { Buffer } from "node:buffer";
import type { UpdateFetch } from "../../windows-update-download";

const maxBytes = 1024 * 1024;
const maxRedirects = 5;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

async function readBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<unknown> {
  const reader = body.getReader();
  const cancel = () => reader.cancel().catch(() => undefined);
  const abort = () => void cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Changelog feed exceeds its size limit.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", abort);
    await cancel();
    reader.releaseLock();
  }
}

export function makeChangelogFeedRequest(fetch: UpdateFetch) {
  return (endpoint: URL): Effect.Effect<unknown, Error> =>
    Effect.tryPromise({
      try: async (signal) => {
        let url = endpoint;
        for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
          // Electron's Response.url is unreliable, so validate the destination before each hop.
          if (
            url.origin !== endpoint.origin ||
            url.protocol !== endpoint.protocol ||
            url.username ||
            url.password
          ) {
            throw new Error("Changelog feed redirected outside its configured origin.");
          }
          const response = await fetch(url.href, {
            method: "GET",
            credentials: "omit",
            redirect: "manual",
            cache: "no-store",
            headers: { accept: "application/json" },
            signal,
          });
          if (redirectStatuses.has(response.status)) {
            await response.body?.cancel();
            const location = response.headers.get("location");
            if (!location) throw new Error("Changelog feed redirect has no destination.");
            url = new URL(location, url);
            continue;
          }
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error(`Changelog feed request failed (${response.status}).`);
          }
          return readBody(response.body, signal);
        }
        throw new Error("Changelog feed redirected too many times.");
      },
      catch: (cause) => new Error("Could not download the changelog feed.", { cause }),
    });
}
