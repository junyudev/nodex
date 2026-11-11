// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import { Readable } from "node:stream";

/**
 * Send an MCP request to the Runtime without fetch's inactivity timeout.
 * Long tool calls can leave both the response headers and SSE body idle.
 */
export function requestAcpMcp(url: string, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const send = endpoint.protocol === "https:" ? NodeHttps.request : NodeHttp.request;
    const body = init?.body;
    if (body != null && typeof body !== "string") {
      reject(new TypeError("ACP MCP request body must be a string."));
      return;
    }
    const request = send(
      endpoint,
      {
        method: init?.method ?? "POST",
        headers: Object.fromEntries(new Headers(init?.headers)),
        signal: init?.signal ?? undefined,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 500;
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
        }
        const hasBody = status !== 204 && status !== 205 && status !== 304;
        if (!hasBody) incoming.resume();
        // Node and the DOM declarations describe the same WHATWG byte stream here.
        const responseBody = hasBody
          ? (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>)
          : null;
        resolve(new Response(responseBody, { status, headers }));
      },
    );
    request.once("error", reject);
    request.end(body ?? undefined);
  });
}
