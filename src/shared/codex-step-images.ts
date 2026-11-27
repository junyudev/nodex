import type { CodexStepImage } from "./types";

/**
 * The pictures a tool returned: those its execution owner names, which stay known while the result
 * body is withheld, or else the images in the result itself.
 */
export function projectToolResultStepImages(
  named: readonly string[] | undefined,
  inResult: readonly string[],
): CodexStepImage[] {
  return (named ?? inResult).map((source) => ({ source }));
}

/** The name of the file a picture was read from; a copy or inline bytes name no file. */
export function inspectedImageFileName(path: string): string | undefined {
  if (/^(?:data|nodex-runtime-image|https?|blob):/iu.test(path)) return undefined;
  let decoded = path;
  if (/^file:/iu.test(path)) {
    try {
      decoded = decodeURIComponent(new URL(path).pathname);
    } catch {
      return undefined;
    }
  }
  return decoded.split(/[\\/]/u).findLast((segment) => segment.length > 0) || undefined;
}

/** An inspected picture read from `source`, named by its file when it names one. */
export function inspectedStepImage(
  source: string,
  name = inspectedImageFileName(source),
): CodexStepImage {
  return name === undefined ? { source } : { source, name };
}
