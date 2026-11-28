import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { ElectronApplication, Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { APP_RENDERER_URL, buildTopLevelRendererCsp } from "../shared/app-renderer-policy";
import {
  buildAppFilesystemPath,
  buildAppFilesystemUrl,
  buildAppGitHubMediaUrl,
  buildEnvironmentAwareFilesystemUrl,
} from "../shared/app-protocol";
import { launchTestElectron } from "../../scripts/testing/launch-electron";
import type { ProtocolImageFixtureControl } from "../../tests/fixtures/app-renderer-protocol/electron-main";

const temporaryDirectories: string[] = [];
const IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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

async function readImageInRenderer(page: Page, source: string) {
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

// A zero naturalWidth can mean an authorized response is still arriving. Native
// decode completion distinguishes that pending state from an actual image error.
async function readLoadedImageDimensions(page: Page, ids: readonly string[]) {
  await page.waitForLoadState("domcontentloaded");
  return await page.evaluate(async (imageIds) => {
    return await Promise.all(
      imageIds.map(async (id) => {
        const image = document.getElementById(id);
        if (!(image instanceof HTMLImageElement)) throw new Error(`Missing fixture image ${id}`);
        try {
          await image.decode();
        } catch (cause) {
          throw new Error(`Image ${id} (${image.currentSrc}) could not decode`, { cause });
        }
        return image.naturalWidth;
      }),
    );
  }, ids);
}

/** Builds the protocol fixture's Main into a fresh directory with an empty renderer root. */
async function buildProtocolFixture(prefix: string) {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), prefix));
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
  return { outputDirectory, rendererDirectory };
}

function electronEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  delete environment.ELECTRON_RUN_AS_NODE;
  return { ...environment, ...overrides };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("production app renderer origin", () => {
  test("loads a secure renderer with local image, symlink, and media resources", async () => {
    const { outputDirectory, rendererDirectory } = await buildProtocolFixture(
      "nodex-app-origin-integration-",
    );
    const imagePath = path.join(
      outputDirectory,
      process.platform === "win32" ? "image 空格 #%.png" : "image 空格 #?.png",
    );
    writeFileSync(imagePath, IMAGE_BYTES);
    const audioPath = path.join(outputDirectory, "sample.wav");
    writeFileSync(audioPath, createSilentWaveBuffer());
    const outsideStaticPath = path.join(outputDirectory, "outside.png");
    writeFileSync(outsideStaticPath, IMAGE_BYTES);
    symlinkSync(outsideStaticPath, path.join(rendererDirectory, "outside.png"));
    const imageUrl = buildAppFilesystemUrl(imagePath);
    const audioUrl = buildAppFilesystemUrl(audioPath);
    writeFileSync(
      path.join(rendererDirectory, "index.html"),
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${buildTopLevelRendererCsp({ mode: "production" })}"><title>Nodex secure origin</title></head><body><img id="local-image" src="${imageUrl}" alt="local"><img id="static-symlink" src="app://-/outside.png" alt="symlink"><audio id="local-audio" src="${audioUrl}" preload="metadata"></audio></body></html>`,
    );

    const childEnvironment = electronEnvironment();
    let application: ElectronApplication | null = null;
    try {
      application = await launchTestElectron({
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
      await expect(
        readLoadedImageDimensions(page, ["local-image", "static-symlink"]),
      ).resolves.toEqual([1, 1]);
      await expect(page.locator("#local-image").getAttribute("src")).resolves.toBe(imageUrl);
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

  test("plays GitHub media through an app filesystem capability", async () => {
    const { outputDirectory, rendererDirectory } = await buildProtocolFixture(
      "nodex-github-media-integration-",
    );
    const url = buildAppGitHubMediaUrl("fixture-video");
    writeFileSync(
      path.join(rendererDirectory, "index.html"),
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="${buildTopLevelRendererCsp({ mode: "production" })}"><video src="${url}" muted controls></video>`,
    );
    const application = await launchTestElectron({
      args: [path.join(outputDirectory, "main.js")],
      env: electronEnvironment({
        NODEX_TEST_GITHUB_MEDIA_VIDEO: path.resolve(
          "tests/fixtures/workspace-media/vp8-vorbis.webm",
        ),
      }),
    });
    try {
      const page = await application.firstWindow();
      const video = page.locator("video");
      await expect
        .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState))
        .toBeGreaterThanOrEqual(1);
      await video.evaluate(async (el: HTMLVideoElement) => {
        await el.play();
        el.pause();
        const sought = new Promise<void>((resolve) => {
          el.addEventListener("seeked", () => resolve(), { once: true });
        });
        el.currentTime = el.duration / 2;
        await sought;
      });
      expect(await video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(0);
      const partial = await page.evaluate(async (src) => {
        const response = await fetch(src, { headers: { Range: "bytes=10-19" } });
        return { status: response.status, length: (await response.arrayBuffer()).byteLength };
      }, url);
      expect(partial).toEqual({ status: 206, length: 10 });
      await page.goto("data:text/html,<title>Untrusted origin</title>");
      const untrusted = await page.evaluate(async (src) => {
        try {
          return (await fetch(src)).ok;
        } catch {
          return false;
        }
      }, url);
      expect(untrusted).toBe(false);
    } finally {
      await application.close();
    }
  });

  test("compiles the renderer's scripts from V8's code cache once they have run", async () => {
    const { outputDirectory, rendererDirectory } = await buildProtocolFixture(
      "nodex-app-code-cache-integration-",
    );
    const functions = Array.from(
      { length: 2_000 },
      (_, index) => `export function f${index}(value) { return value * ${index} + ${index % 7}; }`,
    );
    writeFileSync(
      path.join(rendererDirectory, "app.js"),
      `${functions.join("\n")}\ndocument.body.dataset.ran = String(f1999(2));\n`,
    );
    writeFileSync(
      path.join(rendererDirectory, "index.html"),
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${buildTopLevelRendererCsp({ mode: "production" })}"><script type="module" src="app://-/app.js"></script></head><body></body></html>`,
    );
    let application: ElectronApplication | null = null;
    try {
      application = await launchTestElectron({
        args: [path.join(outputDirectory, "main.js")],
        env: electronEnvironment(),
      });
      const page = await application.firstWindow();
      // V8 caches a script's compilation once it has run before, so the third load consumes it.
      for (let load = 1; load <= 3; load += 1) {
        await expect.poll(() => page.evaluate(() => document.body.dataset.ran)).toBe("4002");
        if (load < 3) await page.reload();
      }
      const userData = await application.evaluate(({ app }) => app.getPath("userData"));
      const cacheEntries = () => {
        try {
          return readdirSync(path.join(userData, "Code Cache", "js")).filter((name) =>
            name.endsWith("_0"),
          ).length;
        } catch {
          return 0;
        }
      };
      await expect.poll(cacheEntries).toBeGreaterThan(0);
    } finally {
      if (application) await application.close();
    }
  }, 30_000);

  test.runIf(process.platform === "win32")(
    "serves static and filesystem images from native Windows paths",
    async () => {
      const { outputDirectory, rendererDirectory } = await buildProtocolFixture(
        "nodex-app-windows-origin-integration-",
      );
      const localImagePath = path.join(outputDirectory, "Windows image 空格 #%.png");
      writeFileSync(localImagePath, IMAGE_BYTES);
      writeFileSync(path.join(rendererDirectory, "static.png"), IMAGE_BYTES);
      writeFileSync(
        path.join(rendererDirectory, "index.html"),
        `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${buildTopLevelRendererCsp({ mode: "production" })}"></head><body><img id="filesystem-image" src="${buildAppFilesystemUrl(localImagePath)}" alt="filesystem"><img id="static-image" src="app://-/static.png" alt="static"></body></html>`,
      );

      const childEnvironment = electronEnvironment();
      let application: ElectronApplication | null = null;
      try {
        application = await launchTestElectron({
          args: [path.join(outputDirectory, "main.js")],
          env: childEnvironment,
        });
        const page = await application.firstWindow();
        await expect(
          readLoadedImageDimensions(page, ["filesystem-image", "static-image"]),
        ).resolves.toEqual([1, 1]);
      } finally {
        if (application) await application.close();
      }
    },
    30_000,
  );
});

describe("development HTTP renderer origin", () => {
  test("loads local media through both app://fs and Vite /@fs", async () => {
    const { outputDirectory, rendererDirectory } = await buildProtocolFixture(
      "nodex-app-dev-origin-integration-",
    );
    const imagePath = path.join(outputDirectory, "development image.png");
    writeFileSync(imagePath, IMAGE_BYTES);
    // Vite serves /@fs on its process drive; native Windows resources use app://fs across drives.
    let viteImagePath = imagePath;
    if (process.platform === "win32") {
      const generated = path.resolve(".generated");
      mkdirSync(generated, { recursive: true });
      const viteFiles = mkdtempSync(path.join(generated, "app-origin-vite-"));
      temporaryDirectories.push(viteFiles);
      viteImagePath = path.join(viteFiles, "vite image.png");
      writeFileSync(viteImagePath, IMAGE_BYTES);
    }
    const brokenImagePath = path.join(outputDirectory, "broken.png");
    writeFileSync(brokenImagePath, "not image data");
    writeFileSync(
      path.join(rendererDirectory, "index.html"),
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${buildTopLevelRendererCsp({ mode: "development" })}"></head><body><img id="app-source" src="${buildAppFilesystemUrl(imagePath)}" alt="app"><img id="vite-source" src="${buildAppFilesystemPath(viteImagePath)}" alt="vite"><img id="native-source" src="${buildEnvironmentAwareFilesystemUrl(imagePath, "http:")}" alt="native"></body></html>`,
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
      const childEnvironment = electronEnvironment();
      childEnvironment.NODEX_TEST_RENDERER_URL = developmentRendererUrl;
      childEnvironment.NODEX_TEST_HOLD_PROTOCOL_IMAGES = "1";
      application = await launchTestElectron({
        args: [path.join(outputDirectory, "main.js")],
        env: childEnvironment,
      });
      const page = await application.firstWindow();
      await expect.poll(() => page.url()).toBe(developmentRendererUrl);
      const imagesReady = readLoadedImageDimensions(page, [
        "app-source",
        "vite-source",
        "native-source",
      ]);
      let readiness = "pending";
      void imagesReady.then(
        () => {
          readiness = "fulfilled";
        },
        () => {
          readiness = "rejected";
        },
      );
      await Promise.race([
        application.evaluate(async () => {
          const control = Reflect.get(
            globalThis,
            "nodexProtocolImages",
          ) as ProtocolImageFixtureControl;
          await control.requested;
        }),
        imagesReady,
      ]);
      await expect(readLoadedImageDimensions(page, ["vite-source"])).resolves.toEqual([1]);
      await expect(
        page.evaluate(() => {
          const image = document.querySelector<HTMLImageElement>("#app-source")!;
          return { complete: image.complete, width: image.naturalWidth };
        }),
      ).resolves.toEqual({ complete: false, width: 0 });
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      expect(readiness).toBe("pending");
      await application.evaluate(() => {
        const control = Reflect.get(
          globalThis,
          "nodexProtocolImages",
        ) as ProtocolImageFixtureControl;
        control.release();
      });
      await expect(imagesReady).resolves.toEqual([1, 1, 1]);
      await expect(readImageInRenderer(page, buildAppFilesystemUrl(imagePath))).resolves.toEqual({
        status: 200,
        mimeType: "image/png",
        dimensions: [1, 1],
        canExport: true,
      });
      await page.evaluate((url) => {
        const image = document.createElement("img");
        image.id = "broken-source";
        image.src = url;
        document.body.append(image);
      }, buildAppFilesystemUrl(brokenImagePath));
      await expect(readLoadedImageDimensions(page, ["broken-source"])).rejects.toThrow();
    } catch (cause) {
      const diagnostics = await application?.evaluate(() => {
        const control = Reflect.get(
          globalThis,
          "nodexProtocolImages",
        ) as ProtocolImageFixtureControl;
        return {
          failures: control.failures,
          consoleErrors: control.consoleErrors,
          fileReads: control.fileReads,
        };
      });
      throw new Error(`Development media failed: ${JSON.stringify(diagnostics)}`, { cause });
    } finally {
      if (application) await application.close();
      if (developmentServer) await developmentServer.close();
    }
  }, 30_000);
});
