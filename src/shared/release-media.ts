/**
 * Where a change's published screenshots and clips live, and how each one is described.
 *
 * - Change files reference media by the SHA-256 of its bytes (`<hex>.png` or `<hex>.mp4`), so a
 *   published name never changes meaning and every object can be cached forever.
 * - Publishing uploads the original, display encodings derived from it, and finally a small JSON
 *   description. The description is written last, so its presence means the media is complete.
 */

export const MEDIA_ORIGIN = "https://media.nodex.jyu.app";
const MEDIA_PREFIX = "sha256";
const invalidCaption = /[`*[\]\r\n\u0085\u2028\u2029]|<[^>]*>/u;

export function isMediaCaption(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^.{1,120}$/u.test(value) &&
    value.trim() === value &&
    !invalidCaption.test(value)
  );
}

/** A change file's media reference: a lowercase SHA-256 followed by `.png` or `.mp4`. */
export const MEDIA_FILE = /^(?<hash>[0-9a-f]{64})\.(?<extension>png|mp4)$/u;
const DERIVED_FILE = /^[0-9a-f]{64}\.(?:\d+w|poster)\.webp$/u;

export interface PublishedMediaEncoding {
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

export interface PublishedMedia {
  readonly version: 1;
  readonly type: "image" | "video";
  /** The original's size in pixels. Screenshots are captured at 2x. */
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** WebP encodings of an image, widest first, named `<hex>.<width>w.webp`. Empty for a video. */
  readonly variants: readonly PublishedMediaEncoding[];
  /** A video's first frame as `<hex>.poster.webp`. Absent for an image. */
  readonly poster?: PublishedMediaEncoding;
}

/** The public URL of a published object: an original, an encoding or a description. */
export const mediaUrl = (file: string): string => `${MEDIA_ORIGIN}/${MEDIA_PREFIX}/${file}`;

/** The object key of a published file inside the media bucket. */
export const mediaKey = (file: string): string => `${MEDIA_PREFIX}/${file}`;

/** The description published for a media reference. */
export function mediaDescriptionFile(reference: string): string {
  const match = MEDIA_FILE.exec(reference);
  if (!match) throw new Error(`${reference} is not a media reference.`);
  return `${match.groups!.hash}.json`;
}

const isSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

function readEncoding(value: unknown, hash: string, where: string): PublishedMediaEncoding {
  const { file, width, height } = (value ?? {}) as Record<string, unknown>;
  if (
    typeof file !== "string" ||
    !DERIVED_FILE.test(file) ||
    !file.startsWith(hash) ||
    !isSize(width) ||
    !isSize(height)
  ) {
    throw new Error(`${where} needs a derived file of the same media with whole-pixel size.`);
  }
  return { file, width, height };
}

/** Reads the description published for `reference`, rejecting anything this build cannot show. */
export function parsePublishedMedia(value: unknown, reference: string): PublishedMedia {
  const match = MEDIA_FILE.exec(reference);
  if (!match) throw new Error(`${reference} is not a media reference.`);
  const hash = match.groups!.hash;
  const where = `The description of ${reference}`;
  const record = (value ?? {}) as Record<string, unknown>;
  const type = match.groups!.extension === "png" ? "image" : "video";
  if (record.version !== 1 || record.type !== type) {
    throw new Error(`${where} must be version 1 and describe an ${type}.`);
  }
  if (!isSize(record.width) || !isSize(record.height) || !isSize(record.bytes)) {
    throw new Error(`${where} needs whole-pixel width and height and a byte size.`);
  }
  if (!Array.isArray(record.variants)) throw new Error(`${where} needs a variants list.`);
  const variants = record.variants.map((variant, index) =>
    readEncoding(variant, hash, `${where} variant ${index}`),
  );
  if ((type === "image") !== variants.length > 0) {
    throw new Error(`${where} lists display encodings for images only, at least one each.`);
  }
  const poster =
    record.poster === undefined ? undefined : readEncoding(record.poster, hash, `${where} poster`);
  if ((type === "video") !== (poster !== undefined)) {
    throw new Error(`${where} has a poster exactly when it describes a video.`);
  }
  return {
    version: 1,
    type,
    width: record.width,
    height: record.height,
    bytes: record.bytes,
    variants,
    ...(poster ? { poster } : {}),
  };
}
