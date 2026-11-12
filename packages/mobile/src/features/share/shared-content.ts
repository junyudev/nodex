/** One item another app handed over, as the system describes it. */
export interface SharedItem {
  /** The words, the link, or where the file is. */
  readonly value: string;
  readonly shareType: "text" | "url" | "audio" | "image" | "video" | "file";
  readonly mimeType?: string;
}

/** A shared picture before the phone has read it. */
export interface SharedImage {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
}

export interface SharedContent {
  /** Shared words and links, one to a line, in the order they were shared. */
  readonly text: string;
  readonly images: readonly SharedImage[];
  /** Items an Inbox message cannot carry, such as a document or a video. */
  readonly unsupported: number;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

/** The file's own name when its address ends in one; some systems address a picture by number. */
function imageName(uri: string, mimeType: string, index: number): string {
  const last = uri.split(/[?#]/u, 1)[0]?.split("/").pop() ?? "";
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    /* Keep the encoded name. */
  }
  if (/^[^/\\]+\.[a-z0-9]{1,10}$/iu.test(name)) return name;
  const extension = Object.hasOwn(EXTENSIONS, mimeType) ? EXTENSIONS[mimeType] : "jpg";
  return `shared-photo-${index + 1}.${extension}`;
}

/** Sorts what was shared into what an Inbox message carries: words, links and pictures. */
export function readSharedContent(items: readonly SharedItem[]): SharedContent {
  const lines: string[] = [];
  const images: SharedImage[] = [];
  let unsupported = 0;
  for (const item of items) {
    const mimeType = item.mimeType?.trim().toLowerCase() ?? "";
    if (item.shareType === "text" || item.shareType === "url") {
      const line = item.value.trim();
      // A page is often shared as both its link and its link as text.
      if (line && !lines.includes(line)) lines.push(line);
    } else if (item.value && (item.shareType === "image" || mimeType.startsWith("image/"))) {
      const type = mimeType.startsWith("image/") ? mimeType : "image/jpeg";
      images.push({
        uri: item.value,
        name: imageName(item.value, type, images.length),
        mimeType: type,
      });
    } else unsupported++;
  }
  return { text: lines.join("\n"), images, unsupported };
}

/** Shared words go after what the person had already written, never over it. */
export const appendSharedText = (draft: string, shared: string): string =>
  [draft.trimEnd(), shared].filter(Boolean).join("\n");
