import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { APP_RENDERER_URL, buildTopLevelRendererCsp } from "../shared/app-renderer-policy";
import { buildAppFilesystemPath, buildAppFilesystemUrl } from "../shared/app-protocol";

const temporaryDirectories: string[] = [];

function createSilentWaveBuffer(): Buffer {
  const sampleCount = 800;
  const buffer = Buffer.alloc(44 + sampleCount, 128);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8_000, 24);
  buffer.writeUInt32LE(8_000, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(sampleCount, 40);
  return buffer;
}

async function readImageInRenderer(page: import("playwright").Page, source: string) {
  return await page.evaluate(async (url) => {
    const response = await fetch(url);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const dimensions = [bitmap.width, bitmap.height];
    bitmap.close();
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d")!.drawImage(image, 0, 0);
    return {
      status: response.status,
      mimeType: blob.type,
      dimensions,
      canExport: canvas.toDataURL().startsWith("data:image/png;base64,"),
    };
  }, source);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("production app renderer origin", () => {
  test("loads a secure renderer with local image, symlink, and media resources", async () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), "nodex-app-origin-integration-"));
    temporaryDirectories.push(outputDirectory);
    await build({
      bundle: true,
      entryPoints: {
        main: path.resolve("tests/fixtures/app-renderer-protocol/electron-main.ts"),
      },
      external: ["electron"],
      format: "cjs",
      outdir: outputDirectory,
      platform: "node",
      target: "node24",
    });
    const rendererDirectory = path.join(outputDirectory, "renderer");
    mkdirSync(rendererDirectory);
    const imagePath = path.join(outputDirectory, "image 空格 #?.png");
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    writeFileSync(imagePath, imageBytes);
    const audioPath = path.join(outputDirectory, "sample.wav");
    writeFileSync(audioPath, createSilentWaveBuffer());
    const outsideStaticPath = path.join(outputDirectory, "outside.png");
    writeFileSync(outsideStaticPath, imageBytes);
    symlinkSync(outsideStaticPath, path.join(rendererDirectory, "outside.png"));
    const imageUrl = buildAppFilesystemUrl(imagePath);
    const audioUrl = buildAppFilesystemUrl(audioPath);
    writeFileSync(
      path.join(rendererDirectory, "index.html"),
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${buildTopLevelRendererCsp({ mode: "production" })}"><title>Nodex secure origin</title></head><body><img id="local-image" src="${imageUrl}" alt="local"><img id="static-symlink" src="app://-/outside.png" alt="symlink"><audio id="local-audio" src="${audioUrl}" preload="metadata"></audio></body></html>`,
    );

    const childEnvironment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) childEnvironment[name] = value;
    }
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
    let application: ElectronApplication | null = null;
    try {
      application = await electron.launch({
        args: [path.join(outputDirectory, "main.js")],
        env: childEnvironment,
      });
      const page = await application.firstWindow();
      await expect.poll(() => page.url()).toBe(APP_RENDERER_URL);
      await expect(
        page.evaluate(() => ({
          origin: location.origin,
          randomUuidType: typeof crypto.randomUUID,
          secure: isSecureContext,
          subtleType: typeof crypto.subtle,
        })),
      ).resolves.toEqual({
        origin: "app://-",
        randomUuidType: "function",
        secure: true,
        subtleType: "object",
      });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const image = document.querySelector("#local-image");
            return image instanceof HTMLImageElement && image.complete && image.naturalWidth;
          }),
        )
        .toBe(1);
      await expect(page.locator("#local-image").getAttribute("src")).resolves.toBe(imageUrl);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const image = document.querySelector("#static-symlink");
            return image instanceof HTMLImageElement && image.complete && image.naturalWidth;
          }),
        )
        .toBe(1);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const audio = document.querySelector("#local-audio");
            return audio instanceof HTMLAudioElement ? audio.readyState : 0;
          }),
        )
        .toBeGreaterThanOrEqual(1);
      await expect(readImageInRenderer(page, imageUrl)).resolves.toEqual({
        status: 200,
        mimeType: "image/png",
        dimensions: [1, 1],
        canExport: true,
      });
      await expect(
        page.evaluate(async (url) => {
          const response = await fetch(url, { headers: { Range: "bytes=0-3" } });
          return { status: response.status, text: await response.text() };
        }, audioUrl),
      ).resolves.toEqual({ status: 206, text: "RIFF" });
      await page.goto("data:text/html,<title>Untrusted origin</title>");
      await expect(
        page.evaluate(async (url) => {
          try {
            await fetch(url);
            return true;
          } catch {
            return false;
          }
        }, imageUrl),
      ).resolves.toBe(false);
    } finally {
      if (application) await application.close();
    }
  }, 30_000);

  test.runIf(process.platform === "win32")(
    "serves static and filesystem images through the native Windows response path",
    async () => {
      const outputDirectory = mkdtempSync(
        path.join(tmpdir(), "nodex-app-windows-origin-integration-"),
      );
      temporaryDirectories.push(outputDirectory);
      await build({
        bundle: true,
        entryPoints: {
          main: path.resolve("tests/fixtures/app-renderer-protocol/electron-main.ts"),
        },
        external: ["electron"],
        format: "cjs",
        outdir: outputDirectory,
        platform: "node",
        target: "node24",
      });
      const rendererDirectory = path.join(outputDirectory, "renderer");
      mkdirSync(rendererDirectory);
      const imageBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      const localImagePath = path.join(outputDirectory, "Windows image 空格 #?.png");
      writeFileSync(localImagePath, imageBytes);
      writeFileSync(path.join(rendererDirectory, "static.png"), imageBytes);
      writeFileSync(
        path.join(rendererDirectory, "index.html"),
        `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${buildTopLevelRendererCsp({ mode: "production" })}"></head><body><img id="filesystem-image" src="${buildAppFilesystemUrl(localImagePath)}" alt="filesystem"><img id="static-image" src="app://-/static.png" alt="static"></body></html>`,
      );

      const childEnvironment: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined) childEnvironment[name] = value;
      }
      delete childEnvironment.ELECTRON_RUN_AS_NODE;
      let application: ElectronApplication | null = null;
      try {
        application = await electron.launch({
          args: [path.join(outputDirectory, "main.js")],
          env: childEnvironment,
        });
        const page = await application.firstWindow();
        await expect
          .poll(() =>
            page.evaluate(() =>
              ["filesystem-image", "static-image"].map((id) => {
                const image = document.querySelector(`#${id}`);
                return image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0;
              }),
            ),
          )
          .toEqual([1, 1]);
      } finally {
        if (application) await application.close();
      }
    },
    30_000,
  );
});

describe("development HTTP renderer origin", () => {
  test("loads local media through both app://fs and Vite /@fs", async () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), "nodex-app-dev-origin-integration-"));
    temporaryDirectories.push(outputDirectory);
    await build({
      bundle: true,
      entryPoints: {
        main: path.resolve("tests/fixtures/app-renderer-protocol/electron-main.ts"),
      },
      external: ["electron"],
      format: "cjs",
      outdir: outputDirectory,
      platform: "node",
      target: "node24",
    });
    const rendererDirectory = path.join(outputDirectory, "renderer");
    mkdirSync(rendererDirectory);
    const imagePath = path.join(outputDirectory, "development image.png");
    writeFileSync(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    writeFileSync(
      path.join(rendererDirectory, "index.html"),
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${buildTopLevelRendererCsp({ mode: "development" })}"></head><body><img id="app-source" src="${buildAppFilesystemUrl(imagePath)}" alt="app"><img id="vite-source" src="${buildAppFilesystemPath(imagePath)}" alt="vite"></body></html>`,
    );

    let developmentServer: ViteDevServer | null = null;
    let application: ElectronApplication | null = null;
    try {
      developmentServer = await createServer({
        root: rendererDirectory,
        logLevel: "silent",
        server: {
          host: "127.0.0.1",
          port: 0,
          fs: { strict: false },
        },
      });
      await developmentServer.listen();
      const address = developmentServer.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("Vite did not bind a port");
      const developmentRendererUrl = `http://127.0.0.1:${address.port}/`;
      const childEnvironment: Record<string, string> = {
        NODEX_TEST_RENDERER_URL: developmentRendererUrl,
      };
      for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined) childEnvironment[name] = value;
      }
      delete childEnvironment.ELECTRON_RUN_AS_NODE;
      application = await electron.launch({
        args: [path.join(outputDirectory, "main.js")],
        env: childEnvironment,
      });
      const page = await application.firstWindow();
      await expect.poll(() => page.url()).toBe(developmentRendererUrl);
      await expect
        .poll(() =>
          page.evaluate(() =>
            ["app-source", "vite-source"].map((id) => {
              const image = document.querySelector(`#${id}`);
              return image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0;
            }),
          ),
        )
        .toEqual([1, 1]);
      await expect(readImageInRenderer(page, buildAppFilesystemUrl(imagePath))).resolves.toEqual({
        status: 200,
        mimeType: "image/png",
        dimensions: [1, 1],
        canExport: true,
      });
    } finally {
      if (application) await application.close();
      if (developmentServer) await developmentServer.close();
    }
  }, 30_000);
});
