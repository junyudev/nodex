import type { ChatItem, FileRef } from "@nodex/mobile-protocol";
import { describe, expect, it } from "vitest";

import {
  chatGallery,
  galleryAt,
  galleryImages,
  replyImages,
  thumbnailSize,
  viewerPosition,
  withItem,
} from "./chat-images";

const file = (ref: string, mimeType: string | null): FileRef => ({
  ref,
  name: `${ref}.bin`,
  mimeType,
  size: null,
});

describe("chat pictures", () => {
  it("draws pictures and leaves other files out, in their order", () => {
    expect(
      galleryImages([
        file("screenshot", "image/png"),
        file("report", "application/pdf"),
        file("returned", null),
        file("photo", "image/jpeg"),
      ]),
    ).toEqual([
      { ref: "screenshot", name: "screenshot.bin" },
      { ref: "returned", name: "returned.bin" },
      { ref: "photo", name: "photo.bin" },
    ]);
  });

  it("shows one picture large and more in up to three columns that fit the width", () => {
    expect(thumbnailSize(358, 1)).toBe(160);
    expect(thumbnailSize(358, 2)).toBe(160);
    expect(thumbnailSize(358, 3)).toBe(114);
    expect(thumbnailSize(358, 8)).toBe(114);
    // Three columns and their gaps never overflow the row.
    expect(3 * thumbnailSize(300, 5) + 2 * 8).toBeLessThanOrEqual(300);
    expect(thumbnailSize(0, 0)).toBe(0);
  });

  it("opens the viewer on a picture the gallery has, counting only when there are several", () => {
    expect(viewerPosition(1, 3)).toEqual({ index: 1, title: "2 of 3" });
    expect(viewerPosition(7, 3)).toEqual({ index: 2, title: "3 of 3" });
    expect(viewerPosition(-1, 3)).toEqual({ index: 0, title: "1 of 3" });
    // A swipe settles between pages before it lands on one.
    expect(viewerPosition(1.6, 3).index).toBe(2);
    expect(viewerPosition(0, 1)).toEqual({ index: 0, title: "" });
  });
});

const at = "2026-11-08T00:00:00.000Z";
const user = (id: string, files: FileRef[]): ChatItem => ({
  kind: "user",
  id,
  at,
  text: "",
  files,
  unavailableImages: [],
  queued: false,
});
const reply = (id: string, text: string): ChatItem => ({
  kind: "assistant",
  id,
  at,
  text,
  streaming: false,
  truncated: false,
  unavailableImages: [],
});
const step = (id: string, images: FileRef[]): ChatItem => ({
  kind: "activity",
  id,
  at,
  category: "tool",
  title: "Take a screenshot",
  detail: null,
  status: "done",
  output: null,
  outputTruncated: false,
  images,
  unavailableImages: [],
});

describe("a chat's gallery", () => {
  it("finds the pictures a reply shows, and not those its code or links only mention", () => {
    expect(
      replyImages(
        [
          "Here is the page: ![Landing hero](nodex://chat-attachments/hero)",
          '![](<https://example.test/a.png> "The title")',
          "A [link](https://example.test/b.png) and `![code](nodex://chat-attachments/code)`",
          "```\n![fenced](nodex://chat-attachments/fenced)\n```",
          "![script](javascript:alert(1)) ![inline](data:image/png;base64,iVBORw0KGgo=)",
        ].join("\n"),
      ),
    ).toEqual([
      { ref: "nodex://chat-attachments/hero", name: "Landing hero" },
      { ref: "https://example.test/a.png", name: "Picture" },
      { ref: "data:image/png;base64,iVBORw0KGgo=", name: "inline" },
    ]);
  });

  it("holds every picture of the chat once, oldest first, whichever item shows it", () => {
    const items = [
      user("u", [file("nodex://files/photo", "image/jpeg"), file("notes", "text/plain")]),
      step("s", [file("nodex://chat-attachments/viewed", "image/png")]),
      reply(
        "r",
        "![Chart](nodex://chat-attachments/chart) ![again](nodex://chat-attachments/viewed) ![](notes)",
      ),
    ];
    expect(chatGallery(items).map(({ ref }) => ref)).toEqual([
      "nodex://files/photo",
      "nodex://chat-attachments/viewed",
      "nodex://chat-attachments/chart",
    ]);
  });

  it("reads an opened step whole in its place, or after the window when it is older", () => {
    const window = [user("u", []), step("s", []), reply("r", "Done")];
    const opened = step("s", [file("nodex://chat-attachments/screenshot", "image/png")]);
    expect(withItem(window, opened).map(({ id }) => id)).toEqual(["u", "s", "r"]);
    expect(chatGallery(withItem(window, opened)).map(({ ref }) => ref)).toEqual([
      "nodex://chat-attachments/screenshot",
    ]);
    expect(withItem(window, step("older", [])).map(({ id }) => id)).toEqual([
      "u",
      "s",
      "r",
      "older",
    ]);
  });

  it("opens the gallery at the tapped picture, or that picture alone when it holds none", () => {
    const gallery = [
      { ref: "a", name: "A" },
      { ref: "b", name: "B" },
    ];
    expect(galleryAt(gallery, { ref: "b", name: "B" })).toEqual({ images: gallery, index: 1 });
    expect(galleryAt(gallery, { ref: "c", name: "C" })).toEqual({
      images: [{ ref: "c", name: "C" }],
      index: 0,
    });
  });
});
