import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AwsClient } from "aws4fetch";
import { readUnreleasedChangesWithMedia } from "../../src/shared/change-media";
import { mediaDescriptionFile, mediaKey, mediaUrl } from "../../src/shared/release-media";
import { readChangeFilesAtRef, resolveReleaseRef } from "../release/changelog";
import { readReleaseMediaAtRef, releaseMediaAttachments } from "../release/release-media";
import { encodeMedia } from "./encode";
import { isMediaPublished, referencedMediaFiles } from "./public";
import { readMediaFile, resolveMediaStore } from "./store";

const bucket = "https://3651f9ccc104912e0f466f6bb13ce230.r2.cloudflarestorage.com/nodex-media";
const cacheControl = "public, max-age=31536000, immutable";

interface MediaObject {
  readonly file: string;
  readonly data: Buffer;
  readonly contentType: string;
}

type PublishResult = { readonly file: string } & (
  | { readonly status: "skipped" }
  | { readonly status: "would-publish" | "published"; readonly urls: readonly string[] }
  | { readonly status: "missing" | "failed"; readonly error: string }
);

function mediaClient(): AwsClient {
  const { R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Use cloudflare.r2_media with notes.local/secrets/use.py to publish media.");
  }
  return new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
}

async function putMediaObject(
  client: AwsClient,
  { file, data, contentType }: MediaObject,
): Promise<void> {
  const key = mediaKey(file);
  const url = `${bucket}/${key}`;
  const options = { redirect: "error", signal: AbortSignal.timeout(60_000) } as const;
  const hasObject = async (): Promise<boolean> => {
    const response = await client.fetch(url, { ...options, method: "HEAD" });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`R2 HEAD ${key} failed (HTTP ${response.status}).`);
    const size = response.headers.get("content-length");
    if (size !== String(data.length)) {
      throw new Error(
        `R2 object ${key} already exists with size ${size ?? "unknown"}, expected ${data.length} bytes.`,
      );
    }
    return true;
  };

  if (await hasObject()) return;
  const response = await client.fetch(url, {
    ...options,
    method: "PUT",
    headers: {
      "Cache-Control": cacheControl,
      "Content-Type": contentType,
      "If-None-Match": "*",
    },
    body: new Uint8Array(data),
  });
  if (response.ok) return;
  await response.body?.cancel();
  // Another publisher may have created it between the HEAD and conditional PUT.
  if (response.status === 412 && (await hasObject())) return;
  throw new Error(`R2 PUT ${key} failed (HTTP ${response.status}).`);
}

async function publishFile(
  file: string,
  store: string,
  client: (() => AwsClient) | undefined,
): Promise<PublishResult> {
  try {
    if (await isMediaPublished(file)) return { file, status: "skipped" };

    const path = join(store, file);
    const original = readMediaFile(path);
    if (original.name !== file) throw new Error(`${path} does not match its content hash.`);

    const { description, encodings } = await encodeMedia(file, path, original.data);
    const objects: readonly MediaObject[] = [
      {
        file,
        data: original.data,
        contentType: description.type === "image" ? "image/png" : "video/mp4",
      },
      ...encodings.map(({ info, data }) => ({ file: info.file, data, contentType: "image/webp" })),
      {
        file: mediaDescriptionFile(file),
        data: Buffer.from(`${JSON.stringify(description)}\n`),
        contentType: "application/json",
      },
    ];
    const urls = objects.map((object) => mediaUrl(object.file));
    if (!client) return { file, status: "would-publish", urls };

    const r2 = client();
    for (const object of objects) await putMediaObject(r2, object);
    if (!(await isMediaPublished(file))) {
      throw new Error(`The public description of ${file} is missing or invalid after upload.`);
    }
    return { file, status: "published", urls };
  } catch (error) {
    return {
      file,
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function mediaFilesAtRef(cwd: string, ref: string): readonly string[] {
  const sha = resolveReleaseRef(cwd, ref);
  const changes = readUnreleasedChangesWithMedia(readChangeFilesAtRef(cwd, sha));
  const backfill = releaseMediaAttachments(readReleaseMediaAtRef(cwd, sha));
  return referencedMediaFiles([...changes, ...backfill]);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { report: { type: "string" }, "dry-run": { type: "boolean", default: false } },
  });
  if (positionals.length > 1 || positionals[0] === "" || values.report === "") {
    throw new Error("Usage: vp run media:publish -- [<ref>] [--report <file.json>] [--dry-run].");
  }

  const [ref = "HEAD"] = positionals;
  const cwd = process.cwd();
  const files = mediaFilesAtRef(cwd, ref);
  const dryRun = values["dry-run"];
  let client: AwsClient | undefined;
  const getClient = dryRun ? undefined : () => (client ??= mediaClient());
  const results: PublishResult[] = [];
  if (files.length > 0) {
    const store = resolveMediaStore(cwd);
    for (const file of files) results.push(await publishFile(file, store, getClient));
  }

  const content = `${JSON.stringify({ ref, dryRun, results }, null, 2)}\n`;
  if (values.report) {
    const path = resolve(cwd, values.report);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  process.stdout.write(content);
  if (results.some(({ status }) => status === "missing" || status === "failed"))
    process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
