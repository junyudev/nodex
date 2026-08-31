import http from "node:http";

const INLINE_FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E";

export interface BrowserHttpFixture {
  readonly close: () => Promise<void>;
  readonly requests: string[];
  readonly url: string;
}

/** Loopback page with an observable request ledger for Browser execution tests. */
export const startBrowserHttpFixture = async (marker: string): Promise<BrowserHttpFixture> => {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(
      `<!doctype html><html><head><title>${marker}</title><link rel="icon" href="${INLINE_FAVICON}"></head><body>${marker}</body></html>`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Browser fixture returned no port");
  }
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/browser-smoke`,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};
