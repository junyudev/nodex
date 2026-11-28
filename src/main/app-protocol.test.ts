import { describe, afterEach, expect, test, beforeEach } from "vite-plus/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import type { Protocol, Session } from "electron";
import {
  buildAppFilesystemUrl,
  buildAppHostAssetUrl,
  buildAppGitHubMediaUrl,
  APP_PROTOCOL_SCHEME,
} from "../shared/app-protocol";
import {
  createAppProtocolHandler,
  createOrdinaryFileResponse,
  createRangeFileResponse,
  isAllowedAppFilesystemFrame,
  parseAppFilesystemUrl,
  parseSingleByteRange,
  registerAppProtocol,
  resolveAppRequestPath,
} from "./app-protocol";
import {
  resetSafeSendWarningRateLimitForTests,
  safeBroadcastToWindows,
  safeBroadcastToPersonalWindows,
  safeSendToWebContents,
  safeSendToWindow,
  type SafeSendOptions,
} from "./ipc-safe-send";
import { shouldGrantAppRendererPermission } from "./renderer-permissions";
import { isTrustedAppRendererIpcSender } from "./app-renderer-ipc-authorization";
import { MCP_APP_SANDBOX_SCHEME } from "../shared/mcp-app/mcp-app-sandbox-contract";
import { PAGE_FILE_HTML_SCHEME } from "../shared/page-file-html";
import { registerNodexPrivilegedSchemes } from "./privileged-schemes";

describe("app-protocol", () => {
  const temporaryRoots: string[] = [];

  function createFixture() {
    const rendererRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-app-protocol-"));
    temporaryRoots.push(rendererRoot);
    fs.writeFileSync(path.join(rendererRoot, "index.html"), "<!doctype html><main>Nodex</main>");
    fs.mkdirSync(path.join(rendererRoot, "assets"));
    fs.writeFileSync(path.join(rendererRoot, "assets", "main.js"), "export {};");
    return { rendererRoot };
  }

  function createTemporaryFile(name: string, contents: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-app-media-"));
    temporaryRoots.push(root);
    const filePath = path.join(root, name);
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  describe("app request path resolution", () => {
    test("resolves the renderer root, empty host, nested assets, query, and fragment", () => {
      const { rendererRoot } = createFixture();

      expect(resolveAppRequestPath("app://-/", rendererRoot)).toBe(
        path.join(rendererRoot, "index.html"),
      );
      expect(resolveAppRequestPath("app:///", rendererRoot)).toBe(
        path.join(rendererRoot, "index.html"),
      );
      expect(resolveAppRequestPath("app://-/assets/main.js?cache=1#module", rendererRoot)).toBe(
        path.join(rendererRoot, "assets", "main.js"),
      );
    });

    test.each([
      "APP://-/index.html",
      "app://foreign/index.html",
      "app://-:123/index.html",
      "app://fs/index.html",
      "app://-/../secret",
      "app://-/%2e%2e%2fsecret",
      "app://-/..%20/secret",
      "app://-/.../secret",
      "app://-/..%2e%20/secret",
      "app://-/%E0%A4%A",
    ])("rejects an invalid or traversing static URL as not resolvable: %s", (url) => {
      const { rendererRoot } = createFixture();
      expect(resolveAppRequestPath(url, rendererRoot)).toBe(null);
    });

    test("accepts absolute image, audio, video, SVG, encoded separators, and query text", () => {
      const { rendererRoot } = createFixture();
      const imagePath = createTemporaryFile(
        process.platform === "win32" ? "image #1%.png" : "image #1?.png",
        "image",
      );
      const audioPath = createTemporaryFile("sound.mp3", "audio");
      const videoPath = createTemporaryFile("movie.mp4", "video");
      const svgPath = createTemporaryFile("shape.svg", "<svg></svg>");

      for (const filePath of [imagePath, audioPath, videoPath, svgPath]) {
        expect(
          resolveAppRequestPath(`${buildAppFilesystemUrl(filePath)}?v=1#preview`, rendererRoot),
        ).toBe(path.resolve(filePath));
      }
      expect(
        resolveAppRequestPath(`app://fs/@fs${encodeURIComponent(imagePath)}`, rendererRoot),
      ).toBe(path.resolve(imagePath));
    });

    test("does not admit relative paths or non-media extensions", () => {
      const { rendererRoot } = createFixture();
      const textPath = createTemporaryFile("notes.txt", "text");
      const imagePath = createTemporaryFile("image.png", "image");
      const textAliasPath = path.join(path.dirname(imagePath), "image-alias.txt");
      fs.symlinkSync(imagePath, textAliasPath);

      expect(resolveAppRequestPath("app://fs/@fsrelative.png", rendererRoot)).toBe(null);
      expect(resolveAppRequestPath(buildAppFilesystemUrl(textPath), rendererRoot)).toBe(null);
      expect(resolveAppRequestPath(buildAppFilesystemUrl(textAliasPath), rendererRoot)).toBe(null);
    });

    test("does not add a credentials policy beyond the matching host", () => {
      const { rendererRoot } = createFixture();
      const imagePath = createTemporaryFile("image.png", "image");
      const url = buildAppFilesystemUrl(imagePath).replace("app://fs", "app://user:pass@fs");

      expect(resolveAppRequestPath(url, rendererRoot)).toBe(path.resolve(imagePath));
    });

    test("keeps static containment lexical and lets stat follow a root symlink", async () => {
      const { rendererRoot } = createFixture();
      const outsidePath = createTemporaryFile("outside.txt", "outside");
      const aliasPath = path.join(rendererRoot, "outside.txt");
      fs.symlinkSync(outsidePath, aliasPath);

      const resolved = resolveAppRequestPath("app://-/outside.txt", rendererRoot);
      expect(resolved).toBe(aliasPath);
      const response = await createOrdinaryFileResponse(resolved!);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("outside");
    });

    test("reverse-maps only app://fs media URLs", () => {
      const imagePath = createTemporaryFile("image.png", "image");
      const appUrl = buildAppFilesystemUrl(imagePath);

      expect(parseAppFilesystemUrl(appUrl)).toBe(path.resolve(imagePath));
      expect(parseAppFilesystemUrl(appUrl.replace("app:", "APP:"))).toBe(path.resolve(imagePath));
      expect(parseAppFilesystemUrl(`/@fs${imagePath}`)).toBe(null);
      expect(parseAppFilesystemUrl("data:image/png;base64,YQ==")).toBe(null);
      expect(parseAppFilesystemUrl("https://example.test/image.png")).toBe(null);
      expect(parseAppFilesystemUrl(buildAppFilesystemUrl(`${imagePath}.txt`))).toBe(null);
    });
  });

  describe("app file responses", () => {
    test("streams regular files with only length and addressed-path MIME headers", async () => {
      const targetPath = createTemporaryFile("payload.bin", "target-bytes");
      const aliasPath = path.join(path.dirname(targetPath), "alias.png");
      fs.symlinkSync(targetPath, aliasPath);

      const response = await createOrdinaryFileResponse(aliasPath);

      expect(response.status).toBe(200);
      expect(Object.fromEntries(response.headers)).toEqual({
        "content-length": "12",
        "content-type": "image/png",
      });
      await expect(response.text()).resolves.toBe("target-bytes");
    });

    test("uses application/octet-stream for an unknown static extension", async () => {
      const filePath = createTemporaryFile("bundle.unknown", "bytes");
      const response = await createOrdinaryFileResponse(filePath);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
    });

    test("returns 404 for missing and ordinary non-file paths", async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-app-directory-"));
      temporaryRoots.push(directory);
      await expect(
        createOrdinaryFileResponse(path.join(directory, "missing.png")),
      ).resolves.toMatchObject({
        status: 404,
        statusText: "Not Found",
      });
      await expect(createOrdinaryFileResponse(directory)).resolves.toMatchObject({ status: 404 });
    });

    test.each([
      ["bytes=0-3", 10, { start: 0, end: 3 }],
      ["bytes=4-", 10, { start: 4, end: 9 }],
      ["bytes=-3", 10, { start: 7, end: 9 }],
      ["bytes=0-999", 10, { start: 0, end: 9 }],
      ["bytes=-999", 10, { start: 0, end: 9 }],
      [`bytes=-${"9".repeat(400)}`, 10, { start: 0, end: 9 }],
    ])("parses the supported single range %s", (value, size, expected) => {
      expect(parseSingleByteRange(value, size)).toEqual(expected);
    });

    test.each([
      ["bytes=-0", 10],
      ["bytes=-1", 0],
      ["bytes=10-", 10],
      ["bytes=5-4", 10],
      ["bytes=0-1,3-4", 10],
      ["items=0-1", 10],
      ["bytes=-", 10],
    ])("rejects an unsupported or unsatisfiable range %s", (value, size) => {
      expect(parseSingleByteRange(value, size)).toBe(null);
    });

    test("returns whole media and exact 206/416 range responses", async () => {
      const filePath = createTemporaryFile("sound.mp3", "0123456789");

      const whole = await createRangeFileResponse(new Request("app://fs/sound"), filePath);
      expect(whole.status).toBe(200);
      expect(whole.headers.get("accept-ranges")).toBe("bytes");
      expect(whole.headers.get("content-length")).toBe("10");
      await expect(whole.text()).resolves.toBe("0123456789");

      const partial = await createRangeFileResponse(
        new Request("app://fs/sound", { headers: { Range: "bytes=2-5" } }),
        filePath,
      );
      expect(partial.status).toBe(206);
      expect(partial.statusText).toBe("Partial Content");
      expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
      expect(partial.headers.get("content-length")).toBe("4");
      await expect(partial.text()).resolves.toBe("2345");

      const invalid = await createRangeFileResponse(
        new Request("app://fs/sound", { headers: { Range: "bytes=20-30" } }),
        filePath,
      );
      expect(invalid.status).toBe(416);
      expect(invalid.statusText).toBe("Range Not Satisfiable");
      expect(invalid.headers.get("content-range")).toBe("bytes */10");

      await expect(
        createRangeFileResponse(
          new Request("app://fs/missing"),
          path.join(path.dirname(filePath), "missing.mp3"),
        ),
      ).resolves.toMatchObject({ status: 404, statusText: "Not Found" });
    });

    test("rejects non-file audio/video paths before starting a stream", async () => {
      let streamRequested = false;
      const response = await createRangeFileResponse(new Request("app://fs/sound"), "/folder.mp3", {
        stat: async () => ({
          size: 5,
          isFile: () => false,
        }),
        createStream: () => {
          streamRequested = true;
          return Readable.from([Buffer.from("audio")]);
        },
      });

      expect(streamRequested).toBe(false);
      expect(response.status).toBe(404);
    });
  });

  describe("app protocol dispatch and origin gate", () => {
    test("serves audio/video ranges through the application protocol", async () => {
      const { rendererRoot } = createFixture();
      const audioPath = createTemporaryFile("sound.mp3", "0123456789");
      const handler = createAppProtocolHandler({ rendererRoot });
      const response = await handler(
        new Request(buildAppFilesystemUrl(audioPath), { headers: { Range: "bytes=1-2" } }),
      );
      expect(response.status).toBe(206);
      await expect(response.text()).resolves.toBe("12");
    });

    test("does not reject POST before the ordinary stream responder", async () => {
      const { rendererRoot } = createFixture();
      const imagePath = createTemporaryFile("image.png", "image");
      const handler = createAppProtocolHandler({ rendererRoot });

      const response = await handler(
        new Request(buildAppFilesystemUrl(imagePath), { method: "POST" }),
      );
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("image");
    });

    test("returns 404 before dispatching when the URL cannot resolve", async () => {
      const { rendererRoot } = createFixture();
      let statCalled = false;
      const handler = createAppProtocolHandler({
        rendererRoot,
        stat: async (filePath) => {
          statCalled = true;
          return fs.promises.stat(filePath);
        },
      });

      const response = await handler(new Request("app://fs/@fsrelative.png"));
      expect(response.status).toBe(404);
      expect(statCalled).toBe(false);
    });

    test("allows only the packaged app origin or exact HTTP(S) development origin", () => {
      expect(isAllowedAppFilesystemFrame({ url: "app://-/index.html" }, null)).toBe(true);
      expect(isAllowedAppFilesystemFrame({ url: "app://fs/@fs/tmp/image.png" }, null)).toBe(false);
      expect(
        isAllowedAppFilesystemFrame(
          { url: "http://localhost:51284/thread" },
          "http://localhost:51284/",
        ),
      ).toBe(true);
      expect(
        isAllowedAppFilesystemFrame(
          { url: "http://localhost:51285/thread" },
          "http://localhost:51284/",
        ),
      ).toBe(false);
      expect(
        isAllowedAppFilesystemFrame(
          { url: "https://localhost:51284/thread" },
          "http://localhost:51284/",
        ),
      ).toBe(false);
      expect(isAllowedAppFilesystemFrame(null, "http://localhost:51284/")).toBe(false);
      expect(isAllowedAppFilesystemFrame({ url: "not a url" }, "http://localhost:51284/")).toBe(
        false,
      );
    });

    test("registers one process-default handler, re-evaluates the dev origin, and releases once", () => {
      const calls: string[] = [];
      let handlerInstalled = true;
      type GateListener = (
        details: { frame?: { url: string } | null; initiatorOrigin?: string },
        callback: (result: { cancel: boolean }) => void,
      ) => void;
      let listener: GateListener | null = null;
      let developmentRendererUrl: string | null = "http://localhost:51284";
      const appProtocol = {
        handle: (scheme: string) => {
          calls.push(`handle:${scheme}`);
          handlerInstalled = true;
        },
        isProtocolHandled: () => handlerInstalled,
        unhandle: (scheme: string) => {
          calls.push(`unhandle:${scheme}`);
          handlerInstalled = false;
        },
      } as unknown as Protocol;
      const electronSession = {
        webRequest: {
          onBeforeRequest: (...args: unknown[]) => {
            if (args.length === 1) {
              listener = null;
              calls.push("gate:remove");
              return;
            }
            listener = args[1] as typeof listener;
            calls.push(`gate:${JSON.stringify(args[0])}`);
          },
        },
      } as unknown as Session;

      const release = registerAppProtocol(electronSession, {
        rendererRoot: createFixture().rendererRoot,
        getDevelopmentRendererUrl: () => developmentRendererUrl,
        protocol: appProtocol,
      });

      expect(calls).toEqual(['gate:{"urls":["app://fs/*"]}', "unhandle:app", "handle:app"]);
      let cancellation: boolean | null = null;
      const invokeListener = listener as GateListener | null;
      invokeListener?.(
        { frame: { url: "http://localhost:51284/thread" } },
        (result: { cancel: boolean }) => {
          cancellation = result.cancel;
        },
      );
      expect(cancellation).toBe(false);
      for (const [details, expected] of [
        [{ initiatorOrigin: "http://localhost:51284", frame: null }, false],
        [{ initiatorOrigin: "http://localhost:51284", frame: { url: "about:blank" } }, false],
        [{ initiatorOrigin: "app://-", frame: { url: "https://untrusted.invalid" } }, false],
        [{ initiatorOrigin: "https://untrusted.invalid", frame: { url: "app://-" } }, true],
        [{ initiatorOrigin: "null", frame: { url: "app://-" } }, true],
        [{ frame: null }, true],
      ] as const) {
        invokeListener?.(details, (result) => {
          cancellation = result.cancel;
        });
        expect(cancellation).toBe(expected);
      }
      developmentRendererUrl = "http://localhost:51285";
      invokeListener?.(
        { frame: { url: "http://localhost:51284/thread" } },
        (result: { cancel: boolean }) => {
          cancellation = result.cancel;
        },
      );
      expect(cancellation).toBe(true);

      release();
      release();
      expect(calls.slice(-2)).toEqual(["gate:remove", "unhandle:app"]);
    });
  });

  test("host assets require an opaque Main-issued capability", async () => {
    const calls: string[] = [];
    const handler = createAppProtocolHandler({
      rendererRoot: "/renderer",
      readHostAsset: async ({ assetId }) => {
        calls.push(assetId);
        if (assetId === "authorized-image") {
          return { bytes: new TextEncoder().encode("<svg/>"), mimeType: "image/svg+xml" };
        }
        if (assetId === "authorized-text") {
          return { bytes: new TextEncoder().encode("secret"), mimeType: "text/plain" };
        }
        return null;
      },
    });
    const response = await handler(new Request(buildAppHostAssetUrl("authorized-image")));
    expect(await response.text()).toBe("<svg/>");
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    const missing = await handler(new Request(buildAppHostAssetUrl("forged")));
    expect(missing.status).toBe(404);
    const nonImage = await handler(new Request(buildAppHostAssetUrl("authorized-text")));
    expect(nonImage.status).toBe(404);
    expect(calls).toEqual(["authorized-image", "forged", "authorized-text"]);
  });

  test("GitHub media requires a capability and trusted origin and serves video byte ranges", async () => {
    const readRanges: unknown[] = [];
    const handler = createAppProtocolHandler({
      rendererRoot: "/renderer",
      getGitHubMedia: (id) => {
        if (id !== "video-capability" && id !== "invalid-type") return undefined;
        return {
          mimeType: id === "invalid-type" ? "text/html" : "video/mp4",
          size: 10,
          read: async (range) => {
            readRanges.push(range);
            const bytes = "0123456789";
            return new Response(range ? bytes.slice(range.start, range.end + 1) : bytes).body;
          },
        };
      },
    });
    const video = buildAppGitHubMediaUrl("video-capability");
    const refused = await handler(
      new Request(video, { headers: { Origin: "https://example.org" } }),
    );
    expect(refused.status).toBe(404);
    expect((await handler(new Request(buildAppGitHubMediaUrl("unknown")))).status).toBe(404);
    expect((await handler(new Request(buildAppGitHubMediaUrl("invalid-type")))).status).toBe(404);
    expect(readRanges).toEqual([]);

    const range = await handler(
      new Request(video, { headers: { Origin: "app://-", Range: "bytes=4-6" } }),
    );
    expect(range.status).toBe(206);
    expect(range.headers.get("Content-Type")).toBe("video/mp4");
    expect(range.headers.get("Content-Range")).toBe("bytes 4-6/10");
    expect(range.headers.get("Cache-Control")).toBe("no-store");
    expect(range.headers.get("Access-Control-Allow-Origin")).toBe("app://-");
    expect(await range.text()).toBe("456");
    const invalid = await handler(new Request(video, { headers: { Range: "bytes=99-" } }));
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("Content-Range")).toBe("bytes */10");
    expect(readRanges).toEqual([{ start: 4, end: 6 }]);
  });

  test("follows static symlinks and serves the addressed MIME type", async () => {
    const { rendererRoot } = createFixture();
    const target = createTemporaryFile("bytes.bin", "image bytes");
    const alias = path.join(rendererRoot, "alias.png");
    fs.symlinkSync(target, alias);
    const handler = createAppProtocolHandler({ rendererRoot });
    const response = await handler(new Request("app://-/alias.png"));
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(await response.text()).toBe("image bytes");
  });
});

describe("ipc-safe-send", () => {
  class FakeWebContents {
    id: number;
    destroyed = false;
    sendCalls: Array<{ channel: string; args: unknown[] }> = [];
    throwOnSend: unknown = null;
    url = "http://localhost:3000";

    getURL() {
      return this.url;
    }

    constructor(id: number) {
      this.id = id;
    }

    isDestroyed() {
      return this.destroyed;
    }

    send(channel: string, ...args: unknown[]) {
      if (this.throwOnSend) throw this.throwOnSend;
      this.sendCalls.push({ channel, args });
    }
  }

  class FakeWindow {
    id: number;
    destroyed = false;
    webContents: FakeWebContents;

    constructor(id: number, webContents = new FakeWebContents(id * 10)) {
      this.id = id;
      this.webContents = webContents;
    }

    isDestroyed() {
      return this.destroyed;
    }
  }

  function createLogger() {
    const debugCalls: object[] = [];
    const warnCalls: object[] = [];
    return {
      debugCalls,
      warnCalls,
      logger: {
        debug: (_message: string, fields?: object) => {
          debugCalls.push(fields ?? {});
        },
        warn: (_message: string, fields?: object) => {
          warnCalls.push(fields ?? {});
        },
      },
    };
  }

  function createOptions(
    logger: ReturnType<typeof createLogger>["logger"],
    nowMs = 1_000,
  ): SafeSendOptions {
    return {
      logger,
      nowMs: () => nowMs,
      warnRateLimitMs: 100,
    };
  }

  describe("ipc-safe-send", () => {
    beforeEach(() => {
      resetSafeSendWarningRateLimitForTests();
    });

    test("delivers personal Automation changes only to personal windows", () => {
      const personal = new FakeWindow(1);
      const team = new FakeWindow(2);
      team.webContents.url = "http://localhost:3000?spaceId=team";
      for (const channel of ["automations:changed", "automations:runs:updated"]) {
        expect(
          safeBroadcastToPersonalWindows([personal, team], channel, [
            { automationId: "same-automation" },
          ]),
        ).toBe(1);
      }
      expect(personal.webContents.sendCalls.map(({ channel }) => channel)).toEqual([
        "automations:changed",
        "automations:runs:updated",
      ]);
      expect(team.webContents.sendCalls).toEqual([]);
    });

    test("does not send to destroyed webContents", () => {
      const contents = new FakeWebContents(1);
      contents.destroyed = true;
      const logger = createLogger();

      const sent = safeSendToWebContents(
        contents,
        "project-sessions-changed",
        [{ projectId: "p1" }],
        createOptions(logger.logger),
      );

      expect(sent).toBe(false);
      expect(contents.sendCalls.length).toBe(0);
      expect(logger.debugCalls.length).toBe(1);
      expect(logger.warnCalls.length).toBe(0);
    });

    test("does not send to destroyed windows or destroyed child webContents", () => {
      const destroyedWindow = new FakeWindow(1);
      destroyedWindow.destroyed = true;
      const destroyedContentsWindow = new FakeWindow(2);
      destroyedContentsWindow.webContents.destroyed = true;
      const liveWindow = new FakeWindow(3);
      const logger = createLogger();

      const count = safeBroadcastToWindows(
        [destroyedWindow, destroyedContentsWindow, liveWindow],
        "codex:host-message",
        [{ type: "noop" }],
        createOptions(logger.logger),
      );

      expect(count).toBe(1);
      expect(destroyedWindow.webContents.sendCalls.length).toBe(0);
      expect(destroyedContentsWindow.webContents.sendCalls.length).toBe(0);
      expect(liveWindow.webContents.sendCalls.length).toBe(1);
      expect(logger.warnCalls.length).toBe(0);
    });

    test("treats disposed renderer frame errors as lifecycle races", () => {
      const contents = new FakeWebContents(4);
      contents.throwOnSend = new Error(
        "Render frame was disposed before WebFrameMain could be accessed",
      );
      const logger = createLogger();

      const sent = safeSendToWindow(
        new FakeWindow(5, contents),
        "project-sessions-changed",
        [],
        createOptions(logger.logger),
      );

      expect(sent).toBe(false);
      expect(logger.debugCalls.length).toBe(1);
      expect(logger.warnCalls.length).toBe(0);
    });

    test("rate-limits non-lifecycle send failures", () => {
      const contents = new FakeWebContents(6);
      contents.throwOnSend = new Error("Unexpected send failure");
      const logger = createLogger();

      safeSendToWebContents(contents, "codex:event", [], createOptions(logger.logger, 1_000));
      safeSendToWebContents(contents, "codex:event", [], createOptions(logger.logger, 1_050));
      safeSendToWebContents(contents, "codex:event", [], createOptions(logger.logger, 1_101));

      expect(logger.warnCalls.length).toBe(2);
      expect(logger.debugCalls.length).toBe(0);
    });
  });
});

describe("app renderer permissions", () => {
  test("allows clipboard writes only from a top-level app window", () => {
    expect(
      shouldGrantAppRendererPermission({
        permission: "clipboard-sanitized-write",
        webContentsType: "window",
        isMainFrame: true,
      }),
    ).toBe(true);
    expect(
      shouldGrantAppRendererPermission({
        permission: "clipboard-sanitized-write",
        webContentsType: "window",
        isMainFrame: false,
      }),
    ).toBe(false);
    expect(
      shouldGrantAppRendererPermission({
        permission: "clipboard-sanitized-write",
        webContentsType: "webview",
        isMainFrame: true,
      }),
    ).toBe(false);
  });

  test("allows microphone access only from an owned top-level app renderer", () => {
    expect(
      shouldGrantAppRendererPermission({
        permission: "media",
        webContentsType: "window",
        isMainFrame: true,
        hasOwnerWindow: true,
        requestingOrigin: "app://-",
        requestedMediaTypes: ["audio"],
      }),
    ).toBe(true);
  });

  test("allows microphone access only from the exact configured development origin", () => {
    const request = {
      developmentOrigin: "http://localhost:51284",
      hasOwnerWindow: true,
      isMainFrame: true,
      permission: "media",
      requestedMediaTypes: ["audio"],
      webContentsType: "window",
    } as const;

    expect(
      shouldGrantAppRendererPermission({
        ...request,
        requestingOrigin: "http://localhost:51284/thread/1",
      }),
    ).toBe(true);
    expect(
      shouldGrantAppRendererPermission({
        ...request,
        requestingOrigin: "http://localhost:51285/thread/1",
      }),
    ).toBe(false);
  });

  test.each([
    { label: "camera", requestedMediaTypes: ["video"] },
    { label: "audio and camera", requestedMediaTypes: ["audio", "video"] },
    { label: "unknown media", requestedMediaTypes: ["unknown"] },
    { label: "missing media details", requestedMediaTypes: undefined },
  ])("rejects $label media access", ({ requestedMediaTypes }) => {
    expect(
      shouldGrantAppRendererPermission({
        permission: "media",
        webContentsType: "window",
        isMainFrame: true,
        hasOwnerWindow: true,
        requestingOrigin: "app://-",
        requestedMediaTypes,
      }),
    ).toBe(false);
  });

  test.each([
    { label: "subframe", isMainFrame: false },
    { label: "guest", webContentsType: "webview" },
    { label: "unowned window", hasOwnerWindow: false },
    { label: "cross-origin window", requestingOrigin: "https://example.com" },
  ])("rejects microphone access from a $label", (overrides) => {
    expect(
      shouldGrantAppRendererPermission({
        permission: "media",
        webContentsType: "window",
        isMainFrame: true,
        hasOwnerWindow: true,
        requestingOrigin: "app://-",
        requestedMediaTypes: ["audio"],
        ...overrides,
      }),
    ).toBe(false);
  });

  test("rejects unrelated permissions", () => {
    expect(
      shouldGrantAppRendererPermission({
        permission: "geolocation",
        webContentsType: "window",
        isMainFrame: true,
      }),
    ).toBe(false);
  });
});

describe("isTrustedAppRendererIpcSender", () => {
  test("accepts only the top-level frame of an owned app window", () => {
    expect(
      isTrustedAppRendererIpcSender({
        hasOwnerWindow: true,
        senderType: "window",
        senderUrl: "app://-/index.html",
        isMainFrame: true,
      }),
    ).toBe(true);
  });

  test.each([
    {
      hasOwnerWindow: false,
      senderType: "window",
      senderUrl: "app://-/index.html",
      isMainFrame: true,
    },
    {
      hasOwnerWindow: true,
      senderType: "webview",
      senderUrl: "app://-/index.html",
      isMainFrame: true,
    },
    {
      hasOwnerWindow: true,
      senderType: "window",
      senderUrl: "app://-/index.html",
      isMainFrame: false,
    },
    {
      hasOwnerWindow: true,
      senderType: "window",
      senderUrl: "app:///index.html",
      isMainFrame: true,
    },
    {
      hasOwnerWindow: true,
      senderType: "window",
      senderUrl: "https://example.com/",
      isMainFrame: true,
    },
  ])("rejects an untrusted sender: %o", (facts) => {
    expect(isTrustedAppRendererIpcSender(facts)).toBe(false);
  });

  test("accepts only the exact configured development origin", () => {
    expect(
      isTrustedAppRendererIpcSender({
        developmentOrigin: "http://localhost:51284",
        hasOwnerWindow: true,
        senderType: "window",
        senderUrl: "http://localhost:51284/thread/1",
        isMainFrame: true,
      }),
    ).toBe(true);
    expect(
      isTrustedAppRendererIpcSender({
        developmentOrigin: "http://localhost:51284",
        hasOwnerWindow: true,
        senderType: "window",
        senderUrl: "http://localhost:51285/thread/1",
        isMainFrame: true,
      }),
    ).toBe(false);
  });
});

describe("privileged application schemes", () => {
  test("registers app with the exact renderer and media privileges before readiness", () => {
    let registered: Electron.CustomScheme[] = [];
    registerNodexPrivilegedSchemes((schemes) => {
      registered = schemes;
    });

    expect(registered.find((entry) => entry.scheme === APP_PROTOCOL_SCHEME)).toEqual({
      scheme: "app",
      privileges: {
        codeCache: true,
        corsEnabled: true,
        secure: true,
        standard: true,
        stream: true,
        supportFetchAPI: true,
      },
    });
    expect(registered.find((entry) => entry.scheme === PAGE_FILE_HTML_SCHEME)).toEqual({
      scheme: PAGE_FILE_HTML_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    });
    expect(registered.map((entry) => entry.scheme)).toEqual([
      PAGE_FILE_HTML_SCHEME,
      APP_PROTOCOL_SCHEME,
      MCP_APP_SANDBOX_SCHEME,
    ]);
  });
});
