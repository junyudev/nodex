import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { DOMParser } from "@xmldom/xmldom";
import type { AwsClient } from "aws4fetch";
import { createR2Client, r2BucketUrl } from "./r2-client";

const RELEASE_BUCKET = r2BucketUrl("nodex-releases");
const S3_ATTEMPTS = 3;
/** R2 verifies each upload against its SHA-256; recording it lets a retry prove an existing object. */
const SHA256_METADATA = "x-amz-meta-sha256";

export const sha256Bytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

interface ObjectIdentity {
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType: string;
}

export interface MutableObject {
  readonly bytes: Uint8Array;
  readonly etag: string;
}

const objectHeaders = ({ bytes, sha256, contentType }: ObjectIdentity): Record<string, string> => ({
  "Content-Length": String(bytes),
  "Content-Type": contentType,
  "x-amz-content-sha256": sha256,
});

function matchingSize(response: Response, bytes: number, label: string): void {
  const size = response.headers.get("content-length");
  if (size !== String(bytes)) {
    throw new Error(`${label} has size ${size ?? "unknown"}, expected ${bytes} bytes.`);
  }
}

async function requireSuccess(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel();
  throw new Error(`${label} returned HTTP ${response.status}.`);
}

export class ReleaseBucket {
  constructor(
    private readonly client: AwsClient,
    private readonly fetchRequest: typeof fetch = fetch,
  ) {}

  private async request(
    url: string,
    init: RequestInit = {},
    timeoutMs = 30_000,
  ): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      const request = await this.client.sign(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      try {
        const response = await this.fetchRequest(request);
        if (response.status < 500 || attempt === S3_ATTEMPTS) return response;
        await response.body?.cancel();
      } catch (error) {
        if (attempt === S3_ATTEMPTS) throw error;
      }
      await wait(250 * attempt);
    }
  }

  /** An immutable object that exists must be the expected bytes: same size and recorded digest. */
  private async matchingObject(key: string, { bytes, sha256 }: ObjectIdentity): Promise<boolean> {
    // Cloudflare compresses text objects for clients that accept it, which drops Content-Length.
    const response = await this.request(`${RELEASE_BUCKET}/${key}`, {
      method: "HEAD",
      headers: { "Accept-Encoding": "identity" },
    });
    if (response.status === 404) return false;
    await requireSuccess(response, `R2 HEAD ${key}`);
    matchingSize(response, bytes, `R2 object ${key}`);
    const recorded = response.headers.get(SHA256_METADATA);
    if (recorded !== sha256) {
      throw new Error(`R2 object ${key} has digest ${recorded ?? "unknown"}, expected ${sha256}.`);
    }
    return true;
  }

  async putImmutableFile(
    key: string,
    filePath: string,
    identity: ObjectIdentity,
  ): Promise<"uploaded" | "skipped"> {
    if (await this.matchingObject(key, identity)) return "skipped";

    // A file-backed Blob streams through fetch and can be read again for each retry.
    const body = await openAsBlob(filePath);
    if (body.size !== identity.bytes) throw new Error(`Release asset ${filePath} changed size.`);
    const response = await this.request(
      `${RELEASE_BUCKET}/${key}`,
      {
        method: "PUT",
        headers: {
          ...objectHeaders(identity),
          "Cache-Control": "public, max-age=31536000, immutable",
          "If-None-Match": "*",
          [SHA256_METADATA]: identity.sha256,
        },
        body,
      },
      10 * 60_000,
    );
    if (response.status === 412) {
      await response.body?.cancel();
      if (await this.matchingObject(key, identity)) return "skipped";
    }
    await requireSuccess(response, `R2 PUT ${key}`);
    await response.body?.cancel();
    return "uploaded";
  }

  async getMutable(key: string): Promise<MutableObject | null> {
    const response = await this.request(`${RELEASE_BUCKET}/${key}`);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    await requireSuccess(response, `R2 GET ${key}`);
    const etag = response.headers.get("etag");
    if (!etag) {
      await response.body?.cancel();
      throw new Error(`R2 GET ${key} did not return an ETag.`);
    }
    return { bytes: new Uint8Array(await response.arrayBuffer()), etag };
  }

  /** Commit only against the same object inspected by the caller's forward-only guard. */
  async putMutable(
    key: string,
    body: Uint8Array<ArrayBuffer>,
    contentType: string,
    existing: MutableObject | null,
  ): Promise<void> {
    const response = await this.request(`${RELEASE_BUCKET}/${key}`, {
      method: "PUT",
      headers: {
        ...objectHeaders({ bytes: body.byteLength, sha256: sha256Bytes(body), contentType }),
        "Cache-Control": "no-cache",
        ...(existing ? { "If-Match": existing.etag } : { "If-None-Match": "*" }),
      },
      body,
    });
    if (response.status === 412) {
      await response.body?.cancel();
      const current = await this.getMutable(key);
      if (current && Buffer.from(current.bytes).equals(body)) return;
      throw new Error(
        `R2 object ${key} changed during publication. Rerun publication to recheck it.`,
      );
    }
    await requireSuccess(response, `R2 PUT ${key}`);
    await response.body?.cancel();
  }

  async listKeys(prefix: string): Promise<readonly string[]> {
    const url = new URL(RELEASE_BUCKET);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    const keys: string[] = [];
    const tokens = new Set<string>();
    for (;;) {
      const response = await this.request(url.href);
      await requireSuccess(response, `R2 list ${prefix}`);
      const document = new DOMParser().parseFromString(await response.text(), "application/xml");
      const root = document.documentElement;
      if (root?.localName !== "ListBucketResult") throw new Error("Invalid R2 list response.");
      for (const element of Array.from(root.getElementsByTagName("Key"))) {
        const key = element.textContent;
        if (!key?.startsWith(prefix)) throw new Error("R2 list returned an unexpected key.");
        keys.push(key);
      }
      const truncated = root.getElementsByTagName("IsTruncated").item(0)?.textContent;
      if (truncated === "false") return keys;
      const token = root.getElementsByTagName("NextContinuationToken").item(0)?.textContent;
      if (truncated !== "true" || !token || tokens.has(token)) {
        throw new Error("R2 list did not return a new continuation token.");
      }
      tokens.add(token);
      url.searchParams.set("continuation-token", token);
    }
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.request(`${RELEASE_BUCKET}/${key}`, { method: "DELETE" });
    await requireSuccess(response, `R2 DELETE ${key}`);
    await response.body?.cancel();
  }
}

export function openReleaseBucket(): ReleaseBucket {
  return new ReleaseBucket(
    createR2Client("Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY for the Nodex release bucket."),
  );
}

export async function verifyPublicReleaseObject(
  url: string,
  bytes: number,
  fetchRequest: typeof fetch = fetch,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetchRequest(url, {
        method: "HEAD",
        redirect: "error",
        headers: { "Accept-Encoding": "identity" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 200)
        throw new Error(`Public HEAD ${url} returned HTTP ${response.status}.`);
      matchingSize(response, bytes, url);
      return;
    } catch (error) {
      if (attempt === 4) throw error;
    }
    await wait(1_000);
  }
}
