import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { expect, test } from "vite-plus/test";
import { isolatedElectronArguments } from "../../scripts/isolated-run/electron-arguments";
import { APP_RENDERER_URL, buildTopLevelRendererCsp } from "../shared/app-renderer-policy";
import { buildAppFilesystemUrl } from "../shared/app-protocol";

function wave(): Buffer {
  const bytes = Buffer.alloc(44 + 48_000 * 60 * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48_000, 24);
  bytes.writeUInt32LE(96_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

test("decodes, plays and seeks local audio/video from packaged and Vite origins", async () => {
  const evidence: unknown[] = [];
  const root = mkdtempSync(path.join(tmpdir(), "nodex-media-playback-"));
  let application: ElectronApplication | null = null;
  let vite: ViteDevServer | null = null;
  try {
    await build({
      bundle: true,
      entryPoints: { main: path.resolve("tests/fixtures/app-renderer-protocol/electron-main.ts") },
      external: ["electron"],
      format: "cjs",
      outdir: root,
      platform: "node",
      target: "node24",
    });
    const rendererRoot = path.join(root, "renderer");
    mkdirSync(rendererRoot);
    const names = ["vp9-opus.webm", "vp8-vorbis.webm", "h264-aac.mp4", "pcm.wav"];
    for (const name of names.slice(0, 3))
      copyFileSync(path.resolve("tests/fixtures/workspace-media", name), path.join(root, name));
    writeFileSync(path.join(root, "pcm.wav"), wave());
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
      ),
    );

    for (const mode of ["production", "development"] as const) {
      writeFileSync(
        path.join(rendererRoot, "index.html"),
        `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${buildTopLevelRendererCsp({ mode })}"><title>Nodex media</title></head><body></body></html>`,
      );
      let rendererUrl = APP_RENDERER_URL;
      if (mode === "development") {
        vite = await createServer({
          configFile: false,
          root: rendererRoot,
          logLevel: "silent",
          server: { host: "localhost", port: 0 },
        });
        await vite.listen();
        const address = vite.httpServer?.address();
        if (!address || typeof address === "string") throw new Error("Vite did not bind a port");
        rendererUrl = `http://localhost:${address.port}/`;
      }
      application = await electron.launch({
        args: [
          path.join(root, "main.js"),
          `--user-data-dir=${path.join(root, mode)}`,
          ...isolatedElectronArguments(),
        ],
        env: {
          ...environment,
          NODEX_TEST_SLOW_MEDIA: "1",
          NODEX_TEST_RENDERER_URL: mode === "development" ? rendererUrl : "",
        },
      });
      const page = await application.firstWindow();
      await expect.poll(() => page.url()).toBe(rendererUrl);
      const mediaRanges: { source: string; range: string; status: number }[] = [];
      page.on("response", (response) => {
        const request = response.request();
        if (request.resourceType() !== "media") return;
        mediaRanges.push({
          source: request.url(),
          range: request.headers().range ?? "",
          status: response.status(),
        });
      });
      for (const name of names) {
        const source = buildAppFilesystemUrl(path.join(root, name));
        const result = await page.evaluate(
          async ({ source, audio, midByte }) => {
            const media = document.createElement(audio ? "audio" : "video");
            media.preload = "metadata";
            media.muted = true;
            document.body.append(media);
            const event = (name: string) =>
              new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                  clearTimeout(timer);
                  media.removeEventListener(name, loaded);
                  media.removeEventListener("error", failed);
                };
                const loaded = () => {
                  cleanup();
                  resolve();
                };
                const failed = () => {
                  cleanup();
                  reject(new Error(`${name}: ${media.error?.message}`));
                };
                const timer = setTimeout(() => {
                  cleanup();
                  reject(
                    new Error(
                      `${name} timed out: ready=${media.readyState}, network=${media.networkState}, error=${media.error?.message}`,
                    ),
                  );
                }, 8_000);
                media.addEventListener(name, loaded, { once: true });
                media.addEventListener("error", failed, { once: true });
              });
            try {
              const loaded = event("loadedmetadata");
              media.src = source;
              await loaded;
              const duration = media.duration;
              await media.play();
              while (media.currentTime < 0.1) await event("timeupdate");
              media.pause();
              const bufferedEnd =
                media.buffered.length > 0 ? media.buffered.end(media.buffered.length - 1) : 0;
              const seeked = event("seeked");
              media.currentTime = duration * 0.6;
              await seeked;
              const response = await fetch(source, {
                headers: { Range: `bytes=${midByte}-${midByte + 1023}` },
              });
              const rangeLength = (await response.arrayBuffer()).byteLength;
              return {
                duration,
                currentTime: media.currentTime,
                bufferedEndBeforeSeek: bufferedEnd,
                rangeStatus: response.status,
                rangeLength,
              };
            } finally {
              media.remove();
              media.removeAttribute("src");
              media.load();
            }
          },
          {
            source,
            audio: name.endsWith(".wav"),
            midByte: Math.floor(statSync(path.join(root, name)).size / 2),
          },
        );
        expect(result.duration, `${mode}: ${name}`).toBeGreaterThan(5);
        expect(result.currentTime).toBeCloseTo(result.duration * 0.6, 1);
        expect(result.rangeStatus).toBe(206);
        expect(result.rangeLength).toBe(1024);
        if (name.endsWith(".wav")) {
          expect(result.bufferedEndBeforeSeek).toBeLessThan(result.duration * 0.6);
          expect(
            mediaRanges.some(
              (request) =>
                request.source === source &&
                request.status === 206 &&
                /^bytes=[1-9]\d*-/u.test(request.range),
            ),
          ).toBe(true);
        }
        evidence.push({
          mode,
          name,
          ...result,
          mediaRequests: mediaRanges.filter((request) => request.source === source),
        });
      }
      await application.close();
      application = null;
      if (vite) await vite.close();
      vite = null;
    }
    if (process.env.NODEX_MEDIA_EVIDENCE_PATH)
      writeFileSync(process.env.NODEX_MEDIA_EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
  } finally {
    if (application) await application.close();
    if (vite) await vite.close();
    rmSync(root, { force: true, recursive: true });
  }
}, 60_000);
