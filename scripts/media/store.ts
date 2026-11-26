import { createHash } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import type { UnreleasedChange } from "../../src/shared/change-media";
import { CHANGES_README } from "../../src/shared/changelog";
import { resolveMediaStore } from "./store-path.mts";

export { resolveMediaStore };

const limits = { ".png": 8_000_000, ".mp4": 20_000_000 };
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

export function checkLocalChangeMedia(
  cwd: string,
  changes: readonly Pick<UnreleasedChange, "path" | "media">[],
): void {
  if (process.env.CI !== undefined || !changes.some(({ media }) => media.length > 0)) return;
  const store = resolveMediaStore(cwd);
  if (!statSync(store, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const { path, media } of changes) {
    for (const name of media.flatMap(({ light, dark }) => [light, dark])) {
      if (!name || lstatSync(join(store, name), { throwIfNoEntry: false })?.isFile()) continue;
      throw new Error(
        `${path} references ${name}, which is missing from ${store}. Add it with vp run media:add. See ${CHANGES_README}.`,
      );
    }
  }
}

interface MediaFile {
  readonly name: string;
  readonly data: Buffer;
}

function hasFileTypeBox(data: Buffer): boolean {
  for (let offset = 0; offset + 8 <= data.length;) {
    const remaining = data.length - offset;
    const sizeField = data.readUInt32BE(offset);
    const headerSize = sizeField === 1 ? 16 : 8;
    if (remaining < headerSize) return false;
    const size =
      sizeField === 1 ? Number(data.readBigUInt64BE(offset + 8)) : sizeField || remaining;
    if (size < headerSize || size > remaining) return false;
    if (data.toString("latin1", offset + 4, offset + 8) === "ftyp") {
      const payloadSize = size - headerSize;
      return payloadSize >= 8 && payloadSize % 4 === 0;
    }
    offset += size;
  }
  return false;
}

export function readMediaFile(path: string): MediaFile {
  const extension = extname(path).toLowerCase();
  if (extension === ".gif") {
    throw new Error(
      `${path} is a GIF. Convert it to MP4 with: ffmpeg -i input.gif -vf "scale=ceil(iw/2)*2:ceil(ih/2)*2" -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an output.mp4`,
    );
  }
  if (extension !== ".png" && extension !== ".mp4") {
    throw new Error(`${path} must be a PNG or MP4 file.`);
  }
  const maxBytes = limits[extension];
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error(`${path} must be a regular file.`);
  if (stats.size > maxBytes) throw new Error(`${path} must be at most ${maxBytes / 1_000_000} MB.`);
  const data = readFileSync(path);
  if (data.length > maxBytes)
    throw new Error(`${path} must be at most ${maxBytes / 1_000_000} MB.`);
  const valid =
    extension === ".png"
      ? data.subarray(0, pngSignature.length).equals(pngSignature)
      : hasFileTypeBox(data);
  if (!valid)
    throw new Error(`${path} must contain a valid ${extension.slice(1).toUpperCase()} header.`);
  return { name: sha256(data) + extension, data };
}

/** Publishes a complete file under its hash without replacing any existing file. */
export function storeMediaFile(store: string, { name, data }: MediaFile): string {
  mkdirSync(store, { recursive: true });
  const target = join(store, name);
  const staging = mkdtempSync(join(store, ".add-"));
  const temporary = join(staging, name);
  try {
    writeFileSync(temporary, data);
    linkSync(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = lstatSync(target);
    if (
      !existing.isFile() ||
      existing.size !== data.length ||
      sha256(readFileSync(target)) !== name.slice(0, 64)
    ) {
      throw new Error(`${target} already exists with different contents.`, { cause: error });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return target;
}
