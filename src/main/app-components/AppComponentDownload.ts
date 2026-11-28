/* @effect-diagnostics asyncFunction:off -- Node download and filesystem adapter. */
import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { APP_COMPONENT_MANIFEST_MAX_BYTES } from "../../shared/app-component-manifest";

import type { AppComponentFailureReason } from "../../shared/app-components";
import { sha256File } from "../platform/node/pinned-tar-archive";
import type { AppComponentArchive } from "./AppComponentCatalog";

export type ComponentFetch = (url: string, init: RequestInit) => Promise<Response>;

export class AppComponentInstallError extends Error {
  constructor(
    readonly reason: AppComponentFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export async function fetchComponentResource(
  url: string,
  fetch: ComponentFetch,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new AppComponentInstallError("integrity", "Component downloads require HTTPS.");
    }
    const response = await fetch(url, {
      signal,
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Component redirect has no destination.");
      url = new URL(location, url).href;
      continue;
    }
    return response;
  }
  throw new Error("Component download redirected too many times.");
}

export async function componentPartialSize(file: string): Promise<number> {
  const stats = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats) return 0;
  if (stats.isFile() && stats.nlink === 1) return stats.size;
  throw new AppComponentInstallError("integrity", "Component download path is invalid.");
}

/** Retain interrupted transfers. Remove any file whose bytes fail verification. */
export async function downloadComponentArchive(input: {
  readonly archive: AppComponentArchive;
  readonly file: string;
  readonly fetch: ComponentFetch;
  readonly signal: AbortSignal;
  readonly onProgress: (received: number) => void;
}): Promise<void> {
  const { archive, file, signal, onProgress } = input;
  let response: Response | undefined;
  try {
    const offset = await componentPartialSize(file);
    if (offset > archive.size) {
      throw new AppComponentInstallError(
        "integrity",
        "Component download exceeds its locked size.",
      );
    }
    let received = offset;
    onProgress(received);
    if (offset < archive.size) {
      response = await fetchComponentResource(
        archive.url,
        input.fetch,
        {
          "Accept-Encoding": "identity",
          ...(offset ? { Range: `bytes=${offset}-` } : {}),
        },
        signal,
      );
      if (response.status !== 200 && response.status !== 206) {
        throw new Error(`Component download returned HTTP ${response.status}.`);
      }
      if (response.status === 200) received = 0;
      if (
        (response.status === 206 &&
          (!offset ||
            response.headers.get("content-range") !==
              `bytes ${offset}-${archive.size - 1}/${archive.size}`)) ||
        (response.headers.has("content-length") &&
          response.headers.get("content-length") !== String(archive.size - received))
      ) {
        throw new AppComponentInstallError(
          "integrity",
          "Component response size does not match its lock.",
        );
      }
      if (!response.body) throw new Error("Component download returned no data.");
      if (received !== offset) onProgress(received);
      let lastReport = performance.now();
      const flags =
        constants.O_WRONLY |
        constants.O_CREAT |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW) |
        (received ? constants.O_APPEND : constants.O_TRUNC);
      const output = await open(file, flags, 0o600);
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > archive.size) {
              callback(
                new AppComponentInstallError(
                  "integrity",
                  "Component download exceeds its locked size.",
                ),
              );
              return;
            }
            const now = performance.now();
            if (now - lastReport >= 150 || received === archive.size) {
              lastReport = now;
              onProgress(received);
            }
            callback(null, chunk);
          },
        }),
        output.createWriteStream(),
        { signal },
      ).finally(() => output.close());
    }
    if (
      received !== archive.size ||
      (await componentPartialSize(file)) !== archive.size ||
      (await sha256File(file, signal)) !== archive.sha256
    ) {
      throw new AppComponentInstallError(
        "integrity",
        "Component download does not match its release lock.",
      );
    }
  } catch (error) {
    if (error instanceof AppComponentInstallError && error.reason === "integrity") {
      await rm(file, { force: true, recursive: true });
      throw error;
    }
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOSPC") {
      throw new AppComponentInstallError(
        "disk-space",
        "There is not enough space to install this component.",
      );
    }
    if (
      ["EACCES", "EPERM", "EIO", "EROFS", "ELOOP", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException | null)?.code ?? "",
      )
    ) {
      throw new AppComponentInstallError(
        "unknown",
        "Nodex could not save the component download.",
        { cause: error },
      );
    }
    throw new AppComponentInstallError("network", "The component download was interrupted.", {
      cause: error,
    });
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}

/** Limit decoded response bytes even when a redirect or server omits Content-Length. */
export async function fetchComponentManifest(
  url: string,
  fetch: ComponentFetch,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetchComponentResource(url, fetch, { Accept: "application/json" }, signal);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Component manifest returned no data.");
  try {
    if (!response.ok) throw new Error(`Component manifest returned HTTP ${response.status}.`);
    if (Number(response.headers.get("content-length")) > APP_COMPONENT_MANIFEST_MAX_BYTES)
      throw new Error("Component manifest is too large.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > APP_COMPONENT_MANIFEST_MAX_BYTES)
        throw new Error("Component manifest is too large.");
      if (value.byteLength > 0) chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)),
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}
