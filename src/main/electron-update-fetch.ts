import { Readable } from "node:stream";
import { net } from "electron";
import type { UpdateFetch } from "./windows-update-download";

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Electron's net.fetch cancels a manual redirect instead of returning it, which broke every
 * download from GitHub Releases. This port answers manual redirects the way WHATWG fetch does,
 * so `fetchUpdate` validates each hop, and keeps Chromium's network stack and system proxy.
 */
export const electronUpdateFetch: UpdateFetch = (url, init) =>
  new Promise((resolve, reject) => {
    const signal = init.signal ?? undefined;
    const request = net.request({
      url,
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      useSessionCookies: false,
      bypassCustomProtocolHandlers: true,
    });
    request.setHeader("Cache-Control", "no-store");
    const abort = () => {
      request.abort();
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    const release = () => signal?.removeEventListener("abort", abort);
    request.on("redirect", (status, _method, location) => {
      release();
      request.abort();
      resolve(new Response(null, { status, headers: { location } }));
    });
    request.on("response", (response) => {
      response.once("end", release);
      response.once("error", release);
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const item of [value].flat()) headers.append(name, item);
      }
      const body = NULL_BODY_STATUSES.has(response.statusCode)
        ? null
        : (Readable.toWeb(response as unknown as Readable) as ReadableStream<Uint8Array>);
      resolve(new Response(body, { status: response.statusCode, headers }));
    });
    request.on("error", (error) => {
      release();
      reject(error);
    });
    request.end();
  });
