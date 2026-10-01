import { buildTopLevelRendererCsp } from "../../shared/app-renderer-policy";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright";
import { WebSocketServer } from "ws";
import { expect, test } from "vitest";

test.each(["complete", "incomplete", "segmented-recovery", "edge-challenge"] as const)(
  "streams real AudioWorklet PCM and accepts only complete transcripts (%s)",
  verifyStreamingCompletion,
);

async function verifyStreamingCompletion(
  completion: "complete" | "incomplete" | "segmented-recovery" | "edge-challenge",
): Promise<void> {
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
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  const uploads: Buffer[] = [];
  const uploadHeaders: IncomingHttpHeaders[] = [];
  const upgradeHeaders: IncomingHttpHeaders[] = [];
  const upgradeUrls: string[] = [];
  const server = createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (request, response) => {
      if (request.url !== "/transcribe") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (data: Buffer) => chunks.push(data));
      request.on("end", () => {
        uploads.push(Buffer.concat(chunks));
        uploadHeaders.push(request.headers);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ text: "Buffered works." }));
      });
    },
  );
  server.on("upgrade", (request) => {
    upgradeHeaders.push(request.headers);
    upgradeUrls.push(request.url!);
  });
  const sockets = new WebSocketServer({
    server,
    handleProtocols: () => "chatgpt-dictation",
    verifyClient: (_info, callback) => {
      if (completion === "edge-challenge")
        callback(false, 403, "Forbidden", { "cf-mitigated": "challenge" });
      else callback(true);
    },
  });
  const frames: Buffer[] = [];
  const requests: string[] = [];
  const segmentFrames: Buffer[][] = [];
  const sampleRates: number[] = [];
  const starts: unknown[] = [];
  sockets.on("connection", (socket) => {
    const segmentIndex = segmentFrames.length;
    const segmentAudio: Buffer[] = [];
    segmentFrames.push(segmentAudio);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        type: string;
        audio?: string;
        config?: { sample_rate_hz: number };
      };
      requests.push(message.type);
      const session = {
        session_id: "fixture-session",
        config: { provider_mode: "streaming_sse", transcript_delivery_mode: "final_only" },
      };
      if (message.type === "session.start") {
        starts.push(message);
        sampleRates[segmentIndex] = message.config!.sample_rate_hz;
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
        const frame = Buffer.from(message.audio!, "base64");
        frames.push(frame);
        segmentAudio.push(frame);
        return;
      }
      if (message.type !== "session.close") return;
      if (completion !== "segmented-recovery" || segmentIndex === 0)
        socket.send(
          JSON.stringify({
            type: "transcript.final",
            sequence_no: 1,
            utterance_id: "u1",
            revision: 1,
            text: completion === "segmented-recovery" ? "First segment." : "Streaming works.",
          }),
        );
      if (
        completion === "incomplete" ||
        (completion === "segmented-recovery" && segmentIndex === 1)
      ) {
        socket.send(JSON.stringify({ type: "speech.started", sequence_no: 2, utterance_id: "u2" }));
      }
      socket.send(
        JSON.stringify({
          type: "session.updated",
          sequence_no: 3,
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
      define: {
        "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production" }),
      },
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
    const csp = buildTopLevelRendererCsp({ mode: "production" });
    writeFileSync(
      path.join(rendererDirectory, "index.html"),
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><button data-segmented="${completion === "segmented-recovery"}" data-rejected="${completion === "edge-challenge"}">Stream synthetic audio</button><output></output><script type="module" src="renderer.js"></script>`,
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
        NODEX_TEST_DICTATION_SOCKET_URL: `wss://127.0.0.1:${address.port}/dictation/stream?dictation_surface=global`,
        NODE_EXTRA_CA_CERTS: certPath,
      },
    });
    const page = await application.firstWindow();
    await page.waitForLoadState("load");
    const bridgeResult = await page.evaluate(async () => {
      const { invoke } = Reflect.get(window, "globalDictation") as {
        invoke(channel: string): Promise<unknown>;
      };
      let forbiddenRejected = false;
      try {
        await invoke("codex:account:read");
      } catch {
        forbiddenRejected = true;
      }
      try {
        return { forbiddenRejected, state: await invoke("codex:dictation:state:read") };
      } catch (error) {
        return { forbiddenRejected, error: error instanceof Error ? error.message : "unknown" };
      }
    });
    expect(bridgeResult).toEqual({
      forbiddenRejected: true,
      state: { capabilities: { streaming: "available", sounds: true } },
    });
    expect(
      await application.evaluate(() =>
        Reflect.get(globalThis, "dictationFixtureForbiddenInvocations"),
      ),
    ).toBe(0);
    await page.getByRole("button", { name: "Stream synthetic audio" }).click();
    if (completion !== "edge-challenge") {
      await expect
        .poll(() => frames.length > 2 && frames.some((frame) => frame.some((byte) => byte !== 0)), {
          timeout: 12_000,
        })
        .toBe(true);
    }
    if (completion === "segmented-recovery") {
      await page.getByRole("button", { name: "Split synthetic audio" }).click();
      await expect
        .poll(() => segmentFrames[1]?.some((frame) => frame.some((byte) => byte !== 0)) ?? false, {
          timeout: 12_000,
        })
        .toBe(true);
    }
    await expect
      .poll(async () => Number(await page.locator("button").getAttribute("data-buffered-bytes")), {
        timeout: 12_000,
      })
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "Finish synthetic audio" }).click();
    await expect.poll(() => page.locator("output").textContent(), { timeout: 12_000 }).not.toBe("");
    const result = JSON.parse((await page.locator("output").textContent())!);
    expect(result).toMatchObject({
      text: completion === "complete" ? "Streaming works." : null,
      diagnostics: {
        attempted: true,
        opened: completion !== "edge-challenge",
        started: completion !== "edge-challenge",
        finalReceived: completion !== "edge-challenge",
        headers: {
          originator: "Codex Desktop",
          authorizationPresent: true,
          accountHeaderPresent: true,
        },
        proxyMode: "direct",
      },
    });
    expect(result.diagnostics.failureCode).toBe(
      completion === "complete"
        ? undefined
        : completion === "edge-challenge"
          ? "edge-challenge"
          : "incomplete-transcript",
    );
    if (completion === "segmented-recovery") {
      expect(result.recovered).toBe("First segment. Recovered segment.");
      expect(result.recoveryAudio).toHaveLength(1);
      expect(Buffer.from(result.recoveryAudio[0].pcm, "base64")).toEqual(
        Buffer.concat(segmentFrames[1]!),
      );
      expect(result.recoveryAudio[0]).toMatchObject({
        sampleRate: sampleRates[1],
        channels: 1,
        bitsPerSample: 16,
      });
      expect(result.updates).toContainEqual({
        text: "First segment. Recovered segment.",
        segment: { id: 1, text: "Recovered segment." },
      });
    }
    if (completion === "edge-challenge") {
      expect(result.diagnostics).toMatchObject({
        httpStatus: 403,
        edgeChallenge: "cloudflare",
        sentAudioFrames: 0,
      });
    }
    const usesBufferedFallback = completion === "incomplete" || completion === "edge-challenge";
    expect(result.fallbackText).toBe(usesBufferedFallback ? "Buffered works." : null);
    expect(uploads).toHaveLength(usesBufferedFallback ? 1 : 0);
    if (usesBufferedFallback) {
      expect(result.bufferedBytes).toBeGreaterThan(0);
      expect(uploads[0]!.length).toBeGreaterThan(result.bufferedBytes);
      expect(uploadHeaders[0]).toMatchObject({
        authorization: "Bearer fixture-token",
        originator: "Codex Desktop",
      });
      expect(uploadHeaders[0]!["content-type"]).toMatch(/^multipart\/form-data; boundary=/u);
    }
    expect(result.diagnostics.sentAudioFrames).toBe(frames.length);
    expect(frames.length).toBe(
      completion === "edge-challenge" ? 0 : result.diagnostics.sentAudioFrames,
    );
    expect(
      frames.every((frame) => frame.length > 0 && frame.length <= 4096 && frame.length % 2 === 0),
    ).toBe(true);
    expect(frames.some((frame) => frame.some((byte) => byte !== 0))).toBe(
      completion !== "edge-challenge",
    );
    if (completion !== "edge-challenge") {
      expect(requests[0]).toBe("session.start");
      expect(requests.at(-1)).toBe("session.close");
      expect(starts[0]).toMatchObject({
        config: {
          input_audio_format: "pcm16",
          sample_rate_hz: sampleRates[0],
          provider_mode: "streaming_sse",
          transcript_delivery_mode: "segment",
        },
      });
    }
    expect(upgradeHeaders).toHaveLength(completion === "segmented-recovery" ? 2 : 1);
    expect(
      await application.evaluate(() => Reflect.get(globalThis, "dictationFixturePortCount")),
    ).toBe(upgradeHeaders.length);
    expect(
      await application.evaluate(() => Reflect.get(globalThis, "dictationFixtureCapabilityReads")),
    ).toBe(2);
    for (const headers of upgradeHeaders) {
      expect(headers).toMatchObject({
        authorization: "Bearer fixture-token",
        "chatgpt-account-id": "fixture-account",
        originator: "Codex Desktop",
        "user-agent": "Codex Desktop/fixture (Mac OS; arm64)",
        "accept-language": "en-SG",
      });
      expect(headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim())).toEqual([
        "chatgpt-dictation",
        "codex-desktop",
      ]);
      expect(headers.origin).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
    }
    expect(upgradeUrls.every((url) => url === "/dictation/stream?dictation_surface=global")).toBe(
      true,
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain("fixture-token");
    expect(JSON.stringify(result.diagnostics)).not.toContain("fixture-account");
  } finally {
    await application?.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}
