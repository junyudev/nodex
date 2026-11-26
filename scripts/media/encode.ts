import { execFileSync } from "node:child_process";
import sharp from "sharp";
import {
  parsePublishedMedia,
  type PublishedMedia,
  type PublishedMediaEncoding,
} from "../../src/shared/release-media";

interface Encoding {
  readonly data: Buffer;
  readonly info: PublishedMediaEncoding;
}

const webp = { quality: 90 };

export function imageVariantWidths(width: number): readonly number[] {
  return width < 1200 ? [width] : [width, Math.floor(width / 2)];
}

export function describeMedia(
  file: string,
  original: Pick<PublishedMedia, "width" | "height" | "bytes">,
  encodings: { variants: readonly PublishedMediaEncoding[] } | { poster: PublishedMediaEncoding },
): PublishedMedia {
  const display =
    "poster" in encodings
      ? { type: "video", variants: [], poster: encodings.poster }
      : { type: "image", variants: encodings.variants.toSorted((a, b) => b.width - a.width) };
  return parsePublishedMedia({ version: 1, ...original, ...display }, file);
}

function runVideoTool(command: "ffmpeg" | "ffprobe", args: readonly string[]): Buffer {
  try {
    return execFileSync(command, args, {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Video publishing requires ${command} on PATH.`, { cause: error });
    }
    throw error;
  }
}

function firstVideoFrame(path: string): Buffer {
  // V excludes attached cover art. Select the same real video stream when decoding the frame.
  const stream = runVideoTool("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "V:0",
    "-show_entries",
    "stream=index",
    "-of",
    "csv=p=0",
    path,
  ])
    .toString()
    .trim();
  if (!/^\d+$/u.test(stream)) throw new Error("MP4 has no video stream.");

  return runVideoTool("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-i",
    path,
    "-map",
    `0:${stream}`,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-c:v",
    "png",
    "pipe:1",
  ]);
}

export async function encodeMedia(
  file: string,
  path: string,
  original: Buffer,
): Promise<{ description: PublishedMedia; encodings: readonly Encoding[] }> {
  const hash = file.slice(0, file.lastIndexOf("."));
  const bytes = original.length;
  if (file.endsWith(".mp4")) {
    const {
      data,
      info: { width, height },
    } = await sharp(firstVideoFrame(path)).webp(webp).toBuffer({ resolveWithObject: true });
    const poster = { file: `${hash}.poster.webp`, width, height };
    return {
      description: describeMedia(file, { width, height, bytes }, { poster }),
      encodings: [{ data, info: poster }],
    };
  }

  const image = sharp(original);
  const { width, height } = await image.metadata();
  const encodings = await Promise.all(
    imageVariantWidths(width).map(async (variantWidth): Promise<Encoding> => {
      const { data, info } = await image
        .clone()
        .resize({ width: variantWidth })
        .webp(webp)
        .toBuffer({ resolveWithObject: true });
      return {
        data,
        info: { file: `${hash}.${info.width}w.webp`, width: info.width, height: info.height },
      };
    }),
  );
  const variants = encodings.map(({ info }) => info);
  return { description: describeMedia(file, { width, height, bytes }, { variants }), encodings };
}
