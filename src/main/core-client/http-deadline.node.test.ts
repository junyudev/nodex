/* @effect-diagnostics asyncFunction:off nodeBuiltinImport:off -- Real HTTP socket, response and connection-pool deadlines are the boundary under test. */
import { Agent, createServer, request } from "node:http";
import { once } from "node:events";
import { expect, test } from "vite-plus/test";
import { LocalHttpTransport } from "./local-http";

test("an absolute HTTP deadline bounds both a black-holed response and waiting for a pooled socket", async () => {
  let arrived = 0;
  const server = createServer((_request, response) => {
    arrived += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    if (_request.url !== "/drip") return;
    const drip = setInterval(() => response.write(" "), 10);
    response.once("close", () => clearInterval(drip));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const transport = new LocalHttpTransport("", "", {
    requestTimeoutMs: 100,
    connection: {
      request,
      maximumQueuedRequests: 32,
      options: { hostname: "127.0.0.1", port: address.port, socketPath: undefined, agent },
      credential: () => "test",
    },
  });
  const result = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);
  try {
    const controller = new AbortController();
    // Hold the only pool slot with an SSE stream; it has its own idle contract.
    const occupied = request({
      host: "127.0.0.1",
      port: address.port,
      agent,
      signal: controller.signal,
    });
    occupied.on("error", () => {});
    const opened = once(occupied, "response");
    occupied.end();
    const [response] = await opened;
    response.on("error", () => {});
    response.resume();
    transport.configureEventContract({
      transportVersion: 1,
      eventVersion: 1,
      libraryId: "library",
      storeEpoch: "epoch",
      coreGeneration: "generation",
    });
    const stream = result(transport.openEventStream(0, () => {}));
    const queued = Array.from({ length: 20 }, () =>
      result(transport.requestJson("GET", "/waiting")),
    );
    const results = await Promise.all(queued);
    expect(results).toEqual(
      Array.from({ length: 20 }, () =>
        expect.objectContaining({ kind: "timeout", code: "ETIMEDOUT" }),
      ),
    );
    expect(await stream).toMatchObject({ kind: "timeout", phase: "open" });
    expect(arrived).toBe(1);
    const overload = await Promise.all(
      Array.from({ length: 100 }, () => result(transport.requestJson("GET", "/waiting"))),
    );
    expect(
      overload.some((error) => error instanceof Error && "status" in error && error.status === 429),
    ).toBe(true);
    expect(Object.values(agent.requests).flat().length).toBeLessThanOrEqual(32);
    const freed = new Promise<void>((resolve) => occupied.once("close", resolve));
    controller.abort();
    await freed;
    await expect.poll(() => Object.values(agent.requests).flat().length).toBe(0);
    expect(await result(transport.requestJson("GET", "/blackhole"))).toMatchObject({
      kind: "timeout",
    });
    expect(await result(transport.requestJson("GET", "/drip"))).toMatchObject({ kind: "timeout" });
  } finally {
    agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
