import type { UnreleasedChange } from "../../src/shared/change-media";
import {
  mediaDescriptionFile,
  mediaUrl,
  parsePublishedMedia,
} from "../../src/shared/release-media";

export function referencedMediaFiles(changes: readonly UnreleasedChange[]): readonly string[] {
  const files = new Set<string>();
  for (const { media } of changes) {
    for (const { light, dark } of media) {
      if (light) files.add(light);
      if (dark) files.add(dark);
    }
  }
  return [...files];
}

/** A valid public description is the marker that all objects for this reference were published. */
export async function isMediaPublished(file: string): Promise<boolean> {
  const url = mediaUrl(mediaDescriptionFile(file));
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) return false;
    throw new Error(`Could not check ${url} (HTTP ${response.status}).`);
  }
  const content = await response.text();
  try {
    parsePublishedMedia(JSON.parse(content), file);
    return true;
  } catch {
    return false;
  }
}
