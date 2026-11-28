import { createServer } from "node:http";
import { once } from "node:events";

export const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export async function servePreview(html: string, signal: AbortSignal): Promise<string> {
  let port = 0;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", PREVIEW_CSP);
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");

    const hosts = request.headersDistinct.host;
    const host = hosts?.[0];
    if (hosts?.length !== 1 || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
      response.writeHead(403).end();
      return;
    }
    if (request.url !== "/" || (request.method !== "GET" && request.method !== "HEAD")) {
      response.writeHead(404).end();
      return;
    }

    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(html);
  });

  const listening = once(server, "listening", { signal });
  server.listen({ host: "127.0.0.1", port: 0, signal });
  try {
    await listening;
  } catch (error) {
    server.close();
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The preview is not listening");
  }
  port = address.port;
  server.once("close", () => signal.removeEventListener("abort", closeConnections));
  const closeConnections = () => server.closeAllConnections();
  signal.addEventListener("abort", closeConnections, { once: true });
  return `http://127.0.0.1:${port}/`;
}
