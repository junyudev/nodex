import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vite-plus/test";
import { describeWorkspaceFileBytes } from "./workspace-file-content";

describe("workspace content sniffing", () => {
  test.each([
    ["vp9-opus.webm", "video", "video/webm"],
    ["vp8-vorbis.webm", "video", "video/webm"],
    ["h264-aac.mp4", "video", "video/mp4"],
  ])("identifies %s from a bounded sample", async (name, contentKind, mimeType) => {
    const bytes = await readFile(`tests/fixtures/workspace-media/${name}`);
    expect(await describeWorkspaceFileBytes(bytes.subarray(0, 4096))).toEqual({
      contentKind,
      mimeType,
    });
  });

  test.each([
    [Buffer.from(""), { contentKind: "text" }],
    [Buffer.from("hello\n\tworld"), { contentKind: "text" }],
    [Buffer.from([7, 8, 9, 10, 11, 12, 13, 14]), { contentKind: "text" }],
    [Buffer.from("many printable characters followed by\u0001"), { contentKind: "binary" }],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), { contentKind: "binary" }],
    [
      Buffer.from(" \n<SVG viewBox='0 0 1 1'/>"),
      { contentKind: "image", mimeType: "image/svg+xml" },
    ],
    [
      Buffer.from("<?xml version='1.0'?><SVG/>"),
      { contentKind: "image", mimeType: "image/svg+xml" },
    ],
    [Buffer.from("%PDF-1.7\n"), { contentKind: "pdf", mimeType: "application/pdf" }],
    [Buffer.from("{\\rtf1 text}"), { contentKind: "text", mimeType: "application/rtf" }],
    [
      Buffer.from([0x50, 0x4b, 5, 6, ...new Array<number>(18).fill(0)]),
      { contentKind: "archive", mimeType: "application/zip" },
    ],
    [Buffer.from("RIFF0000WAVE"), { contentKind: "audio", mimeType: "audio/wav" }],
  ])("classifies sample %# without relying on an extension", async (bytes, expected) => {
    expect(await describeWorkspaceFileBytes(bytes)).toEqual(expected);
  });
});
