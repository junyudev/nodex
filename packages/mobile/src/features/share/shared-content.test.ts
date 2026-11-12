import { expect, it } from "vitest";

import { appendSharedText, readSharedContent } from "./shared-content";

it("keeps shared words and links in order and drops repeats", () => {
  expect(
    readSharedContent([
      { value: " A page worth reading ", shareType: "text", mimeType: "text/plain" },
      { value: "https://example.com/a", shareType: "url", mimeType: "text/html" },
      { value: "https://example.com/a", shareType: "text", mimeType: "text/plain" },
      { value: "   ", shareType: "text" },
    ]),
  ).toEqual({
    text: "A page worth reading\nhttps://example.com/a",
    images: [],
    unsupported: 0,
  });
});

it("names a picture after its file, or by position when its address has no name", () => {
  expect(
    readSharedContent([
      {
        value: "file:///group/IMG%200042.HEIC?token=1",
        shareType: "image",
        mimeType: "image/heic",
      },
      { value: "content://media/external/images/media/731", shareType: "image", mimeType: "" },
      { value: "content://provider/items/9", shareType: "file", mimeType: "IMAGE/PNG" },
    ]).images,
  ).toEqual([
    { uri: "file:///group/IMG%200042.HEIC?token=1", name: "IMG 0042.HEIC", mimeType: "image/heic" },
    {
      uri: "content://media/external/images/media/731",
      name: "shared-photo-2.jpg",
      mimeType: "image/jpeg",
    },
    { uri: "content://provider/items/9", name: "shared-photo-3.png", mimeType: "image/png" },
  ]);
});

it("counts what an Inbox message cannot carry instead of attaching it", () => {
  expect(
    readSharedContent([
      { value: "file:///group/report.pdf", shareType: "file", mimeType: "application/pdf" },
      { value: "file:///group/clip.mov", shareType: "video", mimeType: "video/quicktime" },
      { value: "", shareType: "image", mimeType: "image/png" },
      { value: "Note", shareType: "text" },
    ]),
  ).toEqual({ text: "Note", images: [], unsupported: 3 });
});

it("adds shared words after a draft without replacing it", () => {
  expect(appendSharedText("", "https://example.com")).toBe("https://example.com");
  expect(appendSharedText("Read later\n", "https://example.com")).toBe(
    "Read later\nhttps://example.com",
  );
  expect(appendSharedText("Read later", "")).toBe("Read later");
});
