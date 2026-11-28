import {
  parseStableReleasePointer,
  releaseDownloadUrl,
  STABLE_DOWNLOAD_TARGETS,
  STABLE_RELEASE_POINTER_KEY,
  type StableDownloadTarget,
} from "../../../src/shared/release-download";

interface Env {
  readonly RELEASES_BUCKET: R2Bucket;
}

const APPCAST_PATH = /^\/updates\/(?:stable|nightly)\/(?:arm64|windows-x64)\/appcast\.xml$/u;
const DOWNLOAD_PATH = /^\/dl\/([^/]+)\/?$/u;
const REVALIDATE_SOON = "public, max-age=60, must-revalidate";
const SITE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const textError = (
  request: Request,
  status: number,
  body: string,
  headers?: Record<string, string>,
) =>
  new Response(request.method === "HEAD" ? null : body, {
    status,
    headers: {
      ...SITE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });

function matchesETag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  // GET and HEAD use weak comparison. An opaque entity tag can itself contain commas.
  return (
    ifNoneMatch.trim() === "*" ||
    (ifNoneMatch.match(/(?:W\/)?"[^"]*"/gu)?.some((tag) => tag.replace(/^W\//u, "") === etag) ??
      false)
  );
}

async function serveAppcast(request: Request, bucket: R2Bucket, key: string): Promise<Response> {
  const isHead = request.method === "HEAD";
  const contents = isHead ? null : await bucket.get(key);
  const object = isHead ? await bucket.head(key) : contents;
  if (!object) return textError(request, 404, "Not Found");

  const body = contents?.body ?? null;
  const headers = {
    ...SITE_HEADERS,
    "Content-Type": "application/xml",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": REVALIDATE_SOON,
    ETag: object.httpEtag,
  };
  if (matchesETag(request.headers.get("If-None-Match"), object.httpEtag)) {
    await body?.cancel();
    return new Response(null, { status: 304, headers });
  }

  return new Response(body, {
    headers: { ...headers, "Content-Length": String(object.size) },
  });
}

async function redirectToInstaller(
  request: Request,
  bucket: R2Bucket,
  target: StableDownloadTarget,
): Promise<Response> {
  try {
    const object = await bucket.get(STABLE_RELEASE_POINTER_KEY);
    if (!object) throw new Error("Stable release pointer is missing.");

    const pointer = parseStableReleasePointer(await object.json());
    return new Response(null, {
      status: 302,
      headers: {
        ...SITE_HEADERS,
        "Cache-Control": REVALIDATE_SOON,
        Location: releaseDownloadUrl(pointer.tag, pointer.installers[target]),
      },
    });
  } catch (error) {
    console.error("Could not resolve the stable installer.", error);
    return textError(request, 503, "Installer temporarily unavailable");
  }
}

export default {
  async fetch(request: Request, { RELEASES_BUCKET }: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textError(request, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
    }

    const path = new URL(request.url).pathname;
    if (APPCAST_PATH.test(path)) return serveAppcast(request, RELEASES_BUCKET, path.slice(1));

    const target = DOWNLOAD_PATH.exec(path)?.[1];
    const installer = STABLE_DOWNLOAD_TARGETS.find((candidate) => candidate === target);
    if (installer) return redirectToInstaller(request, RELEASES_BUCKET, installer);

    return textError(request, 404, "Not Found");
  },
} satisfies ExportedHandler<Env>;
