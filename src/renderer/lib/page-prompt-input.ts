import type { CodexPromptInput } from "./types";
import { FILE_SOURCE_PREFIX, parseFileSource } from "../../shared/file-resources";
import type { ContentAccessContext } from "../../shared/content-access-context";
import { readFileBytes } from "./api";
import { readBlobAsDataUrl } from "./assets";

/** Freeze Page image bytes while the source Page still authorizes them, before starting or queuing a Turn. */
export async function materializePagePromptInput(
  accessContext: ContentAccessContext,
  pageId: string,
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
    if (!fileId) throw new Error("Page image has an invalid File reference");
    let source = sources.get(fileId);
    if (!source) {
      const file = await readFileBytes(accessContext, {
        fileId,
        source: { kind: "page", page_id: pageId },
      });
      if (!file.mimeType.startsWith("image/")) throw new Error("Page image File is not an image");
      source = await readBlobAsDataUrl(
        new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }),
      );
      sources.set(fileId, source);
    }
    images.push({ ...image, source });
  }
  return { ...input, images };
}
