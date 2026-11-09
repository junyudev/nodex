import { fromMarkdown } from "mdast-util-from-markdown";

type MarkdownNode = {
  readonly type: string;
  readonly url?: string;
  readonly alt?: string | null;
  readonly identifier?: string;
  readonly position?: { readonly start: { offset?: number }; readonly end: { offset?: number } };
  readonly children?: readonly MarkdownNode[];
};

/** A picture Markdown shows: its address as Markdown reads it, its alt text and where it is written. */
export interface MarkdownImage {
  /** Entities and escapes decoded, percent encoding kept, as an import records it. */
  readonly url: string;
  readonly alt: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Every picture a reply shows, in order: inline pictures and references to a definition alike.
 * Code that only mentions a picture shows none.
 */
export function markdownImages(text: string): readonly MarkdownImage[] {
  const pending: MarkdownNode[] = [fromMarkdown(text) as MarkdownNode];
  const nodes: MarkdownNode[] = [];
  const definitions = new Map<string, string>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (
      node.type === "definition" &&
      node.identifier &&
      node.url &&
      !definitions.has(node.identifier)
    )
      definitions.set(node.identifier, node.url);
    if (node.type === "image" || node.type === "imageReference") nodes.push(node);
    if (node.children) pending.push(...node.children.toReversed());
  }
  return nodes.flatMap((node) => {
    const url = node.url ?? definitions.get(node.identifier ?? "");
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return url === undefined || start === undefined || end === undefined
      ? []
      : [{ url, alt: node.alt ?? "", start, end }];
  });
}

/**
 * A reply with each picture whose address `destinations` names shown from its new address, or
 * left out where it maps to null. Every other picture and all other text stay as written.
 */
export function rebindMarkdownImages(
  text: string,
  destinations: ReadonlyMap<string, string | null>,
): string {
  if (destinations.size === 0) return text;
  let rebound = "";
  let written = 0;
  for (const image of markdownImages(text)) {
    if (!destinations.has(image.url)) continue;
    const destination = destinations.get(image.url) ?? null;
    rebound += text.slice(written, image.start);
    if (destination !== null)
      rebound += `![${image.alt.replace(/[\\[\]]/gu, "\\$&")}](<${destination}>)`;
    written = image.end;
  }
  return rebound + text.slice(written);
}

const windowsDrivePrefix = /^[a-z]:/iu;

/**
 * The pictures a reply shows from files, each address once, as written: inline pictures and
 * references alike, never one on the web or in code. `platform` is where the reply was written.
 */
export function localMarkdownImagePaths(
  text: string,
  platform: "win32" | "posix",
): readonly string[] {
  return [...new Set(markdownImages(text).map(({ url }) => url))]
    .filter((url) => url.length > 0 && !url.startsWith("#"))
    .filter((url) => platform === "win32" || !url.startsWith("//"))
    .filter(
      (url) =>
        windowsDrivePrefix.test(url) || !/^[a-z][a-z0-9+.-]*:/iu.test(url) || /^file:/iu.test(url),
    );
}
