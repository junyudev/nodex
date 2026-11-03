import { createPublicKey, verify } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_INSTALLER_BYTES, type WindowsUpdateItem } from "./windows-update-appcast";

export type UpdateFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Manual redirects prevent HTTPS downgrade even though Electron Response.url is unreliable. */
export async function fetchUpdate(
  url: string,
  fetch: UpdateFetch,
  signal: AbortSignal,
): Promise<Response> {
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("App updates require HTTPS.");
    }
    const response = await fetch(url, {
      signal,
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("App update redirect has no destination.");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`App update request failed (${response.status}).`);
    }
    return response;
  }
  throw new Error("App update request redirected too many times.");
}

export async function readBoundedAppcast(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes).toString("utf8");
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Appcast exceeds its size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Ed25519 authenticates the exact bytes, not a prehash; Node requires a bounded one-shot buffer. */
export async function verifyWindowsInstaller(
  file: string,
  item: WindowsUpdateItem,
  publicKey: string,
): Promise<void> {
  const metadata = await lstat(file);
  if (
    !metadata.isFile() ||
    metadata.size !== item.expectedBytes ||
    metadata.size > MAX_INSTALLER_BYTES
  ) {
    throw new Error("Downloaded installer length does not match the appcast.");
  }
  const bytes = await readFile(file);
  if (bytes.length !== item.expectedBytes) throw new Error("Downloaded installer length changed.");
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey, "base64").toString("base64url") },
    format: "jwk",
  });
  const valid = await new Promise<boolean>((resolve, reject) =>
    verify(null, bytes, key, Buffer.from(item.signature, "base64"), (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
  if (!valid) throw new Error("Downloaded installer signature is invalid.");
}

export async function downloadWindowsInstaller(options: {
  readonly response: Response;
  readonly item: WindowsUpdateItem;
  readonly publicKey: string;
  readonly preparedPath: string;
  readonly signal: AbortSignal;
  readonly onProgress: (receivedBytes: number) => void;
}): Promise<void> {
  const { response, item, publicKey, preparedPath, signal, onProgress } = options;
  const temporary = `${preparedPath}.download`;
  let received = 0;
  try {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && contentLength !== String(item.expectedBytes)) {
      await response.body?.cancel();
      throw new Error("Installer response length does not match the appcast.");
    }
    await pipeline(
      Readable.fromWeb(response.body! as import("node:stream/web").ReadableStream),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > item.expectedBytes || received > MAX_INSTALLER_BYTES) {
            callback(new Error("Installer exceeds its expected length."));
            return;
          }
          onProgress(received);
          callback(null, chunk);
        },
      }),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (received !== item.expectedBytes) throw new Error("Installer download was truncated.");
    await verifyWindowsInstaller(temporary, item, publicKey);
    signal.throwIfAborted();
    await rename(temporary, preparedPath);
    signal.throwIfAborted();
  } catch (error) {
    await rm(temporary, { force: true });
    await rm(preparedPath, { force: true });
    throw error;
  }
}

/** Only the updater's generated names are owned here. Never trust persisted readiness. */
export async function cleanupWindowsUpdates(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!/^prepared-[a-f0-9-]+\.exe(?:\.download)?$/u.test(entry.name)) continue;
    await rm(join(directory, entry.name), { force: true });
  }
}
