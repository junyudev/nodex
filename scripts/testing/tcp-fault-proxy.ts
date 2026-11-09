import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";

/** Opaque TCP forwarding: the client still authenticates the host's original TLS certificate.
 * Pausing a direction uses socket backpressure rather than an unbounded byte queue.
 * Tests synchronize faults with committed Core state, never packet timing or sleeps.
 */
export const createTcpFaultProxy = async (targetUrl: string) => {
  let target = new URL(targetUrl);
  const pairs = new Map<Socket, Socket>();
  let online = true;
  let responsesPaused = false;
  let requestsPaused = false;
  let accepted = 0;
  let requestBytes = 0;
  let pauseAt = Infinity;
  const server = createServer((client) => {
    accepted += 1;
    if (!online) {
      client.destroy();
      return;
    }
    const upstream = connect({ host: target.hostname, port: Number(target.port || 443) });
    pairs.set(client, upstream);
    const close = () => {
      pairs.delete(client);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
    client.pipe(upstream);
    client.on("data", (chunk: Buffer) => {
      requestBytes += chunk.byteLength;
      if (requestBytes < pauseAt) return;
      requestsPaused = true;
      for (const peer of pairs.keys()) peer.pause();
    });
    upstream.pipe(client);
    if (responsesPaused) upstream.pause();
    if (requestsPaused) client.pause();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy address");
  const disconnect = () => {
    for (const [client, upstream] of pairs) {
      client.destroy();
      upstream.destroy();
    }
  };
  return {
    url: `https://127.0.0.1:${address.port}`,
    get accepted() {
      return accepted;
    },
    get requestsPaused() {
      return requestsPaused;
    },
    pauseRequestsAfter(bytes: number) {
      pauseAt = requestBytes + bytes;
    },
    get connections() {
      return pairs.size;
    },
    disconnect,
    setTarget(url: string) {
      target = new URL(url);
    },
    setOnline(value: boolean) {
      online = value;
      if (!value) disconnect();
    },
    pauseResponses(value: boolean) {
      responsesPaused = value;
      for (const upstream of pairs.values()) {
        if (value) upstream.pause();
        else upstream.resume();
      }
    },
    pauseRequests(value: boolean) {
      requestsPaused = value;
      pauseAt = Infinity;
      for (const client of pairs.keys()) {
        if (value) client.pause();
        else client.resume();
      }
    },
    async close() {
      disconnect();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};
