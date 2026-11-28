import { expect, test, vi } from "vite-plus/test";
import {
  STABLE_RELEASE_POINTER_KEY,
  type StableReleasePointer,
} from "../../../src/shared/release-download";
import worker from "./index";

const STABLE_FEED = "/updates/stable/arm64/appcast.xml";
const NIGHTLY_FEED = "/updates/nightly/windows-x64/appcast.xml";
const APPCAST = '<?xml version="1.0" encoding="UTF-8"?>\r\n<rss>更新</rss>\r\n';
const ETAG = '"stored-md5"';
const POINTER = {
  version: 1,
  tag: "v0.5.15",
  installers: {
    macos: "Nodex-0.5.15-arm64.dmg",
    "windows-x64": "Nodex-0.5.15-windows-x64.exe",
    android: "Nodex-0.5.15-android.apk",
  },
} satisfies StableReleasePointer;

function serve(objects: Record<string, string>) {
  const entries = new Map(Object.entries(objects));
  const head = (key: string) => {
    const content = entries.get(key);
    return content === undefined
      ? null
      : { httpEtag: ETAG, size: new TextEncoder().encode(content).length };
  };

  const bucket = {
    async head(key: string) {
      return head(key);
    },
    async get(key: string) {
      const metadata = head(key);
      if (!metadata) return null;
      const response = new Response(entries.get(key));
      return { ...metadata, body: response.body, json: () => response.json() };
    },
  } as R2Bucket;

  return (path: string, init?: RequestInit) =>
    worker.fetch(new Request(`https://nodex.jyu.app${path}`, init), { RELEASES_BUCKET: bucket });
}

test.each([STABLE_FEED, NIGHTLY_FEED])("streams the unchanged appcast at %s", async (path) => {
  const fetch = serve({ [path.slice(1)]: APPCAST });
  const response = await fetch(path, { headers: { "If-None-Match": '"stale-md5"' } });

  expect(response.status).toBe(200);
  expect(response.headers.get("ETag")).toBe(ETAG);
  expect(response.headers.get("Content-Type")).toBe("application/xml");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=60, must-revalidate");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode(APPCAST));
});

test("HEAD returns appcast metadata without a body", async () => {
  const fetch = serve({ [STABLE_FEED.slice(1)]: APPCAST });
  const response = await fetch(STABLE_FEED, { method: "HEAD" });

  expect(response.status).toBe(200);
  expect(response.headers.get("ETag")).toBe(ETAG);
  expect(response.headers.get("Content-Length")).toBe(
    String(new TextEncoder().encode(APPCAST).length),
  );
  expect(response.body).toBeNull();
});

test.each([
  ["GET", ETAG],
  ["HEAD", `"old,md5", W/${ETAG}`],
  ["GET", "*"],
])("conditionally revalidates appcast %s with %s", async (method, condition) => {
  const fetch = serve({ [STABLE_FEED.slice(1)]: APPCAST });
  const response = await fetch(STABLE_FEED, { method, headers: { "If-None-Match": condition } });

  expect(response.status).toBe(304);
  expect(response.headers.get("ETag")).toBe(ETAG);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.body).toBeNull();
});

test("returns 404 for a missing appcast even with a wildcard validator", async () => {
  const response = await serve({})(STABLE_FEED, { headers: { "If-None-Match": "*" } });

  expect(response.status).toBe(404);
});

test.each([
  "/updates/stable/windows-arm64/appcast.xml",
  "/updates/preview/arm64/appcast.xml",
  "/updates/stable/arm64/appcast.xml/",
  "/updates/stable/arm64%2F..%2Fwindows-x64/appcast.xml",
  "/updates/stable/arm64/%2e%2e%2flatest%2fstable.json",
])("does not serve arbitrary bucket keys at %s", async (path) => {
  const fetch = serve({ [path.slice(1)]: APPCAST, [STABLE_RELEASE_POINTER_KEY]: "{}" });

  expect((await fetch(path)).status).toBe(404);
});

test.each([
  ["/dl/macos", "GET", "Nodex-0.5.15-arm64.dmg"],
  ["/dl/windows-x64/", "HEAD", "Nodex-0.5.15-windows-x64.exe"],
  ["/dl/android/", "GET", "Nodex-0.5.15-android.apk"],
])("redirects %s to the versioned installer", async (path, method, filename) => {
  const response = await serve({ [STABLE_RELEASE_POINTER_KEY]: JSON.stringify(POINTER) })(path, {
    method,
  });

  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe(
    `https://dl.nodex.jyu.app/releases/v0.5.15/${filename}`,
  );
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=60, must-revalidate");
  expect(response.body).toBeNull();
});

test("returns 404 for an unknown download target", async () => {
  expect((await serve({})("/dl/ios")).status).toBe(404);
});

test.each([
  ["missing", undefined],
  ["malformed JSON", "{"],
  [
    "off-site installer",
    JSON.stringify({
      ...POINTER,
      installers: { ...POINTER.installers, macos: "https://example.com/a" },
    }),
  ],
])("fails closed when the stable pointer is %s", async (_description, content) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const fetch = serve(content === undefined ? {} : { [STABLE_RELEASE_POINTER_KEY]: content });
    const response = await fetch("/dl/macos");

    expect(response.status).toBe(503);
    expect(response.headers.has("Location")).toBe(false);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(log).toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test("rejects write methods on dynamic routes", async () => {
  const response = await serve({})(STABLE_FEED, { method: "POST" });

  expect(response.status).toBe(405);
  expect(response.headers.get("Allow")).toBe("GET, HEAD");
});
