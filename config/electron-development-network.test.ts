import { once } from "node:events";
import { createServer as createTcpServer, Server } from "node:net";
import { createServer } from "vite";
import WebSocket from "ws";
import { expect, test, vi } from "vite-plus/test";
import electronConfig from "./electron.vite.config";

test("renderer startup, port probes and HMR listen only on loopback", async () => {
  const reservation = createTcpServer();
  reservation.listen(0, "localhost");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing reserved TCP port");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const bindings: string[] = [];
  const listen = Server.prototype.listen;
  const spy = vi.spyOn(Server.prototype, "listen").mockImplementation(function (
    this: Server,
    ...args: Parameters<Server["listen"]>
  ) {
    this.prependOnceListener("listening", () => {
      const address = this.address();
      if (address && typeof address !== "string") bindings.push(address.address);
    });
    return listen.apply(this, args);
  });
  const renderer = (await electronConfig({ command: "serve", mode: "development" })).renderer;
  const server = await createServer({
    ...renderer,
    configFile: false,
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...renderer?.server, port: address.port, watch: null },
  });
  let socket: WebSocket | undefined;
  try {
    await server.listen();
    expect((await fetch(`http://localhost:${address.port}/@vite/client`)).ok).toBe(true);
    socket = new WebSocket(
      `ws://localhost:${address.port}/?token=${server.config.webSocketToken}`,
      "vite-hmr",
    );
    await once(socket, "open");
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.filter((address) => !["127.0.0.1", "::1"].includes(address))).toEqual([]);
  } finally {
    socket?.terminate();
    await server.close();
    spy.mockRestore();
  }
});
