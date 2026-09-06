import { once } from "node:events";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { createDictationStreamingSocket } from "./dictation-streaming-electron-adapter";

it("opens a real WebSocket, negotiates the dictation protocol and exchanges messages", async () => {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    handleProtocols: () => "chatgpt-dictation",
  });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing test server address");
  let requestedProtocols: string | undefined;
  let received: string | undefined;
  server.on("connection", (client, request) => {
    requestedProtocols = request.headers["sec-websocket-protocol"];
    client.on("message", (payload) => {
      received = payload.toString();
      client.send("session accepted");
    });
  });
  // Loopback transport fixture; production connection validation requires WSS.
  const socket = createDictationStreamingSocket(`ws://127.0.0.1:${address.port}/dictation/stream`, [
    "chatgpt-dictation",
    "openai-bearer.test-token",
    "codex-desktop",
  ]);
  let unsubscribe = (): void => {};
  try {
    const response = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Local WebSocket did not respond")), 5_000);
      unsubscribe = socket.listen({
        open: () => socket.send("start dictation"),
        message: (payload) => {
          clearTimeout(timeout);
          resolve(payload);
        },
        error: () => {
          clearTimeout(timeout);
          reject(new Error("Local WebSocket failed"));
        },
        close: () => {
          clearTimeout(timeout);
          reject(new Error("Local WebSocket closed before responding"));
        },
      });
    });
    expect(response).toBe("session accepted");
    expect(received).toBe("start dictation");
    expect(socket.protocol).toBe("chatgpt-dictation");
    expect(requestedProtocols?.split(",").map((value) => value.trim())).toEqual([
      "chatgpt-dictation",
      "openai-bearer.test-token",
      "codex-desktop",
    ]);
  } finally {
    unsubscribe();
    socket.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
