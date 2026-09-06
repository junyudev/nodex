import { buildTopLevelRendererCsp } from "../../shared/app-renderer-policy";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright";
import { WebSocketServer } from "ws";
import { expect, test } from "vitest";

test("streams real AudioWorklet PCM from the isolated renderer directly to WebSocket and receives a final", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodex-dictation-stream-"));
  let application: ElectronApplication | null = null;
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) });
  const sockets = new WebSocketServer({ server, handleProtocols: () => "chatgpt-dictation" });
  const frames: Buffer[] = [];
  const requests: string[] = [];
  let protocols: string | undefined;
  sockets.on("connection", (socket, request) => {
    protocols = request.headers["sec-websocket-protocol"];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type: string; audio?: string };
      requests.push(message.type);
      const session = {
        session_id: "fixture-session",
        config: { provider_mode: "streaming_sse", transcript_delivery_mode: "final_only" },
      };
      if (message.type === "session.start") {
        socket.send(
          JSON.stringify({
            type: "session.started",
            sequence_no: 0,
            session: { ...session, status: "active" },
          }),
        );
        return;
      }
      if (message.type === "audio.append") {
        frames.push(Buffer.from(message.audio!, "base64"));
        return;
      }
      if (message.type !== "session.close") return;
      socket.send(
        JSON.stringify({
          type: "transcript.final",
          sequence_no: 1,
          utterance_id: "u1",
          revision: 1,
          text: "Streaming works.",
        }),
      );
      socket.send(
        JSON.stringify({
          type: "session.updated",
          sequence_no: 2,
          session: { ...session, status: "closed" },
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  try {
    await build({
      entryPoints: {
        main: path.resolve("tests/fixtures/dictation-streaming/electron-main.ts"),
        preload: path.resolve("src/preload/global-dictation.ts"),
      },
      bundle: true,
      external: ["electron"],
      platform: "node",
      format: "cjs",
      target: "node24",
      outdir: directory,
    });
    const rendererDirectory = path.join(directory, "renderer");
    await build({
      entryPoints: {
        renderer: path.resolve("tests/fixtures/dictation-streaming/renderer.ts"),
        worklet: path.resolve("src/renderer/features/dictation/dictation-pcm-worklet.ts"),
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      outdir: rendererDirectory,
      define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production" }) },
      plugins: [
        {
          name: "worklet-url",
          setup(builder) {
            builder.onResolve({ filter: /\?worker&url$/ }, () => ({
              path: "worklet",
              namespace: "fixture-worklet",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture-worklet" }, () => ({
              contents: 'export default "app://-/worklet.js";',
              loader: "js",
            }));
          },
        },
      ],
    });
    const csp = buildTopLevelRendererCsp({ mode: "production" }).replace(
      "wss://chatgpt.com",
      `wss://127.0.0.1:${address.port}`,
    );
    writeFileSync(
      path.join(rendererDirectory, "index.html"),
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><button>Stream synthetic audio</button><output></output><script type="module" src="renderer.js"></script>`,
    );
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
      ),
    );
    application = await electron.launch({
      args: [path.join(directory, "main.js")],
      env: {
        ...environment,
        NODEX_TEST_DICTATION_SOCKET_URL: `wss://127.0.0.1:${address.port}/dictation/stream`,
      },
    });
    const page = await application.firstWindow();
    await page.waitForLoadState("load");
    await page.getByRole("button", { name: "Stream synthetic audio" }).click();
    await expect.poll(() => page.locator("output").textContent(), { timeout: 12_000 }).not.toBe("");
    const result = JSON.parse((await page.locator("output").textContent())!);
    expect(result).toMatchObject({
      text: "Streaming works.",
      diagnostics: { opened: true, started: true, finalReceived: true },
    });
    expect(result.diagnostics.failureCode).toBeUndefined();
    expect(result.diagnostics.sentAudioFrames).toBe(frames.length);
    expect(frames.length).toBeGreaterThan(2);
    expect(
      frames.every((frame) => frame.length > 0 && frame.length <= 4096 && frame.length % 2 === 0),
    ).toBe(true);
    expect(frames.some((frame) => frame.some((byte) => byte !== 0))).toBe(true);
    expect(requests[0]).toBe("session.start");
    expect(requests.at(-1)).toBe("session.close");
    expect(protocols?.split(",").map((value) => value.trim())).toEqual([
      "chatgpt-dictation",
      "openai-bearer.fixture-token",
      "codex-desktop",
    ]);
  } finally {
    await application?.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
