import type { CodexPromptInput } from "./types";
import { FILE_SOURCE_PREFIX, parseFileSource } from "../../shared/file-resources";
import {
  libraryContentRoute,
  type ContentRoutingContext,
} from "../../shared/content-routing-context";
import type { LibraryFileReadSource } from "../../shared/library-files";
import { readFileBytes } from "./api";
import { readBlobAsDataUrl, readManagedImageDataUrl } from "./assets";
import { parseAssetSource } from "../../shared/assets";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";

/**
 * Freeze a message's Library image bytes while its reader still authorizes them, before starting
 * or queuing a Turn: a Page's images with that Page's access, written text's with the Library's.
 */
export async function materializePromptFileImages(
  routingContext: ContentRoutingContext,
  readSource: LibraryFileReadSource,
  input: CodexPromptInput | undefined,
): Promise<CodexPromptInput | undefined> {
  if (!input?.images?.some((image) => image.source.startsWith(FILE_SOURCE_PREFIX))) return input;
  const sources = new Map<string, string>();
  const images = [];
  // Read sequentially and reuse duplicate occurrences to bound outstanding File reads.
  for (const image of input.images) {
    if (!image.source.startsWith(FILE_SOURCE_PREFIX)) {
      images.push(image);
      continue;
    }
    const fileId = parseFileSource(image.source);
    if (!fileId) throw new Error("An image has an invalid File reference");
    let source = sources.get(fileId);
    if (!source) {
      const file = await readFileBytes(routingContext, { fileId, source: readSource });
      if (!file.mimeType.startsWith("image/")) throw new Error("An image's File is not an image");
      source = await readBlobAsDataUrl(
        new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }),
      );
      sources.set(fileId, source);
    }
    images.push({ ...image, source });
  }
  return { ...input, images };
}

/**
 * Freeze the images a message's text holds before it reaches a chat on `hostId`. Text written to
 * an Agent belongs to no Page, so its Library images read with the Library's access. A managed
 * asset lives in this computer's Profile, so a chat on another host receives its bytes.
 */
export async function materializeWrittenImages(
  input: CodexPromptInput | undefined,
  hostId: string | null,
): Promise<CodexPromptInput | undefined> {
  const withFiles = await materializePromptFileImages(
    libraryContentRoute,
    { kind: "direct" },
    input,
  );
  if (hostId === DEFAULT_CODEX_HOST_ID || !withFiles?.images?.some(isManaged)) return withFiles;
  const images = [];
  for (const image of withFiles.images)
    images.push(
      isManaged(image) ? { ...image, source: await readManagedImageDataUrl(image.source) } : image,
    );
  return { ...withFiles, images };
}

const isManaged = (image: { readonly source: string }) => parseAssetSource(image.source) !== null;
