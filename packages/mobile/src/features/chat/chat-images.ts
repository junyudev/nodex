import type { ChatItem, FileRef } from "@nodex/mobile-protocol";

import { MARKDOWN_IMAGE } from "../../markdown/parse";
import type { GalleryImage } from "../../navigation/types";

/** The pictures among a message's or step's files. A file of unknown type is drawn from its bytes. */
export const galleryImages = (files: readonly FileRef[]): readonly GalleryImage[] =>
  files.flatMap(({ ref, name, mimeType }) =>
    mimeType === null || mimeType.startsWith("image/") ? [{ ref, name }] : [],
  );

/**
 * Whether the viewer can show a picture at this address: one its host serves, or one on the web or
 * written into the reply itself, which the phone loads as the reply does.
 */
export const isViewable = (ref: string): boolean =>
  /^(?:nodex:\/\/|https?:\/\/|data:image\/)/iu.test(ref);

const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/gu;

/** The pictures a reply shows in its text, in order. Code that only mentions one shows none. */
export const replyImages = (text: string): readonly GalleryImage[] =>
  [...text.replace(CODE, "").matchAll(MARKDOWN_IMAGE)].flatMap(([, alt, ref]) =>
    ref && isViewable(ref) ? [{ ref, name: alt?.trim() || "Picture" }] : [],
  );

const itemImages = (item: ChatItem): readonly GalleryImage[] => {
  switch (item.kind) {
    case "user":
      return galleryImages(item.files);
    case "assistant":
      return replyImages(item.text);
    case "activity":
      return galleryImages(item.images);
    default:
      return [];
  }
};

/** Every picture the phone holds of a chat, oldest first, each once: the gallery a tap opens. */
export const chatGallery = (items: readonly ChatItem[]): readonly GalleryImage[] => {
  const seen = new Set<string>();
  return items.flatMap(itemImages).filter(({ ref }) => {
    if (seen.has(ref)) return false;
    seen.add(ref);
    return true;
  });
};

/**
 * A chat's items with one read whole in its place, such as an opened step whose returned pictures
 * the transcript window leaves out. One not in the window follows it.
 */
export const withItem = (items: readonly ChatItem[], item: ChatItem): readonly ChatItem[] =>
  items.some(({ id }) => id === item.id)
    ? items.map((existing) => (existing.id === item.id ? item : existing))
    : [...items, item];

/** The gallery opened at one picture; a picture the gallery lacks opens on its own. */
export const galleryAt = (gallery: readonly GalleryImage[], image: GalleryImage) => {
  const index = gallery.findIndex(({ ref }) => ref === image.ref);
  return index < 0 ? { images: [image], index: 0 } : { images: gallery, index };
};

export const THUMBNAIL_GAP = 8;
const LARGEST_THUMBNAIL = 160;
const COLUMNS = 3;

/** Square thumbnails across a width: one picture shows large, more share up to three columns. */
export const thumbnailSize = (width: number, count: number): number => {
  const columns = Math.min(COLUMNS, Math.max(1, count));
  const fitted = Math.floor((width - THUMBNAIL_GAP * (columns - 1)) / columns);
  return Math.max(0, Math.min(LARGEST_THUMBNAIL, fitted));
};

/** Which picture the viewer shows, always one of the gallery's, and how it reads among the rest. */
export const viewerPosition = (index: number, count: number) => {
  const at = Math.min(Math.max(0, Math.round(index)), Math.max(0, count - 1));
  return { index: at, title: count > 1 ? `${at + 1} of ${count}` : "" };
};
