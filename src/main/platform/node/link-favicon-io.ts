import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { z } from "zod";
import type { LinkFaviconResult } from "../../../shared/link-site";

const maxImageBytes = 64 * 1024;
const maxCacheBytes = Math.ceil(maxImageBytes / 3) * 4 + 256;
const imageTypes = new Set([
  "image/png",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const CacheEntry = z.strictObject({
  expiresAt: z.number().int().nonnegative(),
  result: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("none") }),
    z.strictObject({ status: z.literal("ready"), dataUrl: z.string() }),
  ]),
});
type CacheEntry = z.infer<typeof CacheEntry>;

const validRaster = async (mime: string, bytes: Uint8Array): Promise<boolean> => {
  if (!imageTypes.has(mime) || bytes.byteLength === 0 || bytes.byteLength > maxImageBytes) {
    return false;
  }
  const { fileTypeFromBuffer } = await import("file-type");
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined);
  return detected?.mime === (mime === "image/vnd.microsoft.icon" ? "image/x-icon" : mime);
};

async function readImage(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  try {
    const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const length = response.headers.get("content-length");
    if (
      !response.ok ||
      !mime ||
      !imageTypes.has(mime) ||
      (length !== null && Number(length) > maxImageBytes)
    ) {
      return null;
    }

    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxImageBytes) return null;
      chunks.push(chunk.value);
    }
    const image = Buffer.concat(chunks, bytes);
    if (!(await validRaster(mime, image))) return null;
    return `data:${mime};base64,${image.toString("base64")}`;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function makeLinkFaviconRequest(fetch: typeof globalThis.fetch) {
  return (host: string): Effect.Effect<LinkFaviconResult, Error> =>
    Effect.tryPromise({
      try: async (signal) => {
        const endpoint = new URL("https://t0.gstatic.com/faviconV2");
        endpoint.search = new URLSearchParams({
          client: "SOCIAL",
          type: "FAVICON",
          fallback_opts: "TYPE,SIZE,URL",
          url: `https://${host}`,
          size: "64",
          drop_404_icon: "true",
        }).toString();
        const response = await fetch(endpoint.href, {
          method: "GET",
          headers: { accept: [...imageTypes].join(", "), "user-agent": "Mozilla/5.0" },
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "error",
          signal,
        });
        const dataUrl = await readImage(response);
        return dataUrl ? { status: "ready", dataUrl } : { status: "none" };
      },
      catch: (cause) => new Error("Could not fetch website icon", { cause }),
    });
}

async function readCacheEntry(file: string): Promise<CacheEntry | null> {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.size > maxCacheBytes) return null;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(stats.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length);
    const entry = CacheEntry.parse(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
    if (entry.result.status === "none") return entry;
    const [, mime, base64] =
      /^data:([^;]+);base64,([A-Za-z0-9+/]+=*)$/u.exec(entry.result.dataUrl) ?? [];
    if (!mime || !base64) return null;
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64 || !(await validRaster(mime, bytes))) {
      return null;
    }
    return entry;
  } finally {
    await handle.close();
  }
}

export function linkFaviconDiskCache(root: string) {
  // Hostnames can exceed the filesystem's filename limit or start with a reserved Windows name.
  const fileFor = (host: string) =>
    join(root, `${createHash("sha256").update(host).digest("hex")}.json`);
  return {
    read: (host: string) =>
      Effect.promise(async () => {
        const file = fileFor(host);
        const entry = await readCacheEntry(file).catch(() => null);
        if (!entry) await rm(file, { force: true }).catch(() => undefined);
        return entry;
      }),
    write: (host: string, entry: CacheEntry) =>
      Effect.promise(async () => {
        const file = fileFor(host);
        const temporary = join(root, `${randomUUID()}.tmp`);
        try {
          await mkdir(root, { recursive: true, mode: 0o700 });
          await writeFile(temporary, JSON.stringify(entry), { flag: "wx", mode: 0o600 });
          await rename(temporary, file);
        } catch {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      }),
  };
}
