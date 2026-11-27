import type { ChatItem, FileRef } from "@nodex/mobile-protocol";
import { describe, expect, it } from "vitest";

import {
  chatGallery,
  galleryAt,
  galleryImages,
  replyImages,
  viewerPosition,
  withItem,
  workImagePreview,
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

  it("lands on an existing picture as a swipe settles", () => {
    expect(viewerPosition(7, 3).index).toBe(2);
    expect(viewerPosition(-1, 3).index).toBe(0);
    expect(viewerPosition(1.6, 3).index).toBe(2);
  });

  it("previews up to three work pictures, with the rest reachable in the same gallery", () => {
    const sequence = ["a", "b", "c", "d", "e"].map((ref) => ({ ref, name: ref.toUpperCase() }));
    expect(workImagePreview([])).toEqual({ thumbnails: [], remaining: 0 });
    expect(workImagePreview(sequence.slice(0, 3))).toEqual({
      thumbnails: sequence.slice(0, 3),
      remaining: 0,
    });
    const { thumbnails, remaining } = workImagePreview(sequence);
    expect(thumbnails).toEqual(sequence.slice(0, 3));
    expect(remaining).toBe(2);
    expect(galleryAt(sequence, thumbnails[2]!)).toEqual({ images: sequence, index: 2 });
  });
});

const at = "2026-11-08T00:00:00.000Z";
const user = (id: string, files: FileRef[]): ChatItem => ({
  kind: "user",
  id,
  messageId: null,
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
