import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { Protocol, Session } from "electron";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { buildAppFilesystemUrl } from "../shared/app-protocol";
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
    const imagePath = createTemporaryFile("image #1?.png", "image");
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
  test("uses net.fetch(file URL) only for Windows ordinary responses", async () => {
    const { rendererRoot } = createFixture();
    const imagePath = createTemporaryFile("image.png", "image");
    const calls: string[] = [];
    const handler = createAppProtocolHandler({
      rendererRoot,
      platform: "win32",
      netFetch: async (url) => {
        calls.push(url);
        return new Response("windows");
      },
    });

    const response = await handler(new Request(buildAppFilesystemUrl(imagePath)));
    const staticResponse = await handler(new Request("app://-/assets/main.js"));
    expect(calls).toEqual([
      pathToFileURL(imagePath).toString(),
      pathToFileURL(path.join(rendererRoot, "assets", "main.js")).toString(),
    ]);
    await expect(response.text()).resolves.toBe("windows");
    await expect(staticResponse.text()).resolves.toBe("windows");
  });

  test("keeps audio/video on the range branch on Windows", async () => {
    const { rendererRoot } = createFixture();
    const audioPath = createTemporaryFile("sound.mp3", "0123456789");
    let netFetchCalled = false;
    const handler = createAppProtocolHandler({
      rendererRoot,
      platform: "win32",
      netFetch: async () => {
        netFetchCalled = true;
        return new Response();
      },
    });

    const response = await handler(
      new Request(buildAppFilesystemUrl(audioPath), { headers: { Range: "bytes=1-2" } }),
    );
    expect(netFetchCalled).toBe(false);
    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe("12");
  });

  test("does not reject POST before the ordinary stream responder", async () => {
    const { rendererRoot } = createFixture();
    const imagePath = createTemporaryFile("image.png", "image");
    const handler = createAppProtocolHandler({ rendererRoot, platform: "darwin" });

    const response = await handler(
      new Request(buildAppFilesystemUrl(imagePath), { method: "POST" }),
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("image");
  });

  test("returns 404 before dispatching when the URL cannot resolve", async () => {
    const { rendererRoot } = createFixture();
    let netFetchCalled = false;
    const handler = createAppProtocolHandler({
      rendererRoot,
      platform: "win32",
      netFetch: async () => {
        netFetchCalled = true;
        return new Response();
      },
    });

    const response = await handler(new Request("app://fs/@fsrelative.png"));
    expect(response.status).toBe(404);
    expect(netFetchCalled).toBe(false);
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
      details: { frame?: { url: string } | null },
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
