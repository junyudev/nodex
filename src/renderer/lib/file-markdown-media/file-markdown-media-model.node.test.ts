import { describe, expect, test } from "vite-plus/test";
import {
  decodeFileMarkdownImageBytes,
  parseFileMarkdownImageSrcSet,
  resolveFileMarkdownImageSource,
} from "./file-markdown-media-model";

const scope = { hostId: "remote-ssh-discovered:win", sourceFilePath: "C:/repo/docs/README.md" };

describe("file Markdown image identity", () => {
  test("bounds decoded bytes even when metadata was unknown, and rejects invalid data", () => {
    expect(decodeFileMarkdownImageBytes("eHl6", 3)).toEqual(new Uint8Array([120, 121, 122]));
    expect(decodeFileMarkdownImageBytes("eHl6", 2)).toBeNull();
    expect(decodeFileMarkdownImageBytes("eHl6eA==", 3)).toBeNull();
    expect(decodeFileMarkdownImageBytes("invalid!", 10)).toBeNull();
  });
  test.each([
    ["./images/chart.png", "C:/repo/docs/images/chart.png"],
    ["../chart.png", "C:/repo/chart.png"],
    ["C:\\images\\chart.png", "C:/images/chart.png"],
    ["/images/chart.png", "/images/chart.png"],
    ["./chart%20name.png%20", "C:/repo/docs/chart name.png "],
    ["./chart.png ", "C:/repo/docs/chart.png "],
    ["./chart%23one.png#crop", "C:/repo/docs/chart#one.png"],
    ["file:///C:/images/chart.png", "C:/images/chart.png"],
  ])("resolves %s through its source host without rewriting the filename", (source, path) => {
    expect(resolveFileMarkdownImageSource(source, scope)).toEqual({
      kind: "file",
      hostId: scope.hostId,
      path,
    });
  });

  test.each([
    "app://fs/@fs/tmp/chart.png",
    "file://server/share/chart.png",
    "/@fs/tmp/chart.png",
    "%2F@fs/tmp/chart.png",
    "blob:app://-/private",
    "//local/chart.png",
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "/bad%00.png",
  ])("rejects authored transport %s", (source) => {
    expect(resolveFileMarkdownImageSource(source, scope)).toEqual({ kind: "blocked" });
  });

  test("preserves explicit network and inline image sources", () => {
    for (const source of [
      "https://example.com/chart.png",
      "http://example.com/chart.png",
      "data:image/png;base64,aW1hZ2U=",
    ])
      expect(resolveFileMarkdownImageSource(source, scope)).toEqual({ kind: "url", url: source });
  });

  test("preserves the drive root when resolving beside a root-level document", () => {
    expect(
      resolveFileMarkdownImageSource("chart.png", { ...scope, sourceFilePath: "C:/README.md" }),
    ).toEqual({ kind: "file", hostId: scope.hostId, path: "C:/chart.png" });
  });

  test("uses URL/descriptor tokenization rather than splitting data-image commas", () => {
    expect(
      parseFileMarkdownImageSrcSet(
        "data:image/png;base64,aW1hZ2U= 1x, ./chart.png 2x, ../wide.png 800w",
      ),
    ).toEqual([
      { source: "data:image/png;base64,aW1hZ2U=", descriptor: "1x" },
      { source: "./chart.png", descriptor: "2x" },
      { source: "../wide.png", descriptor: "800w" },
    ]);
    expect(
      parseFileMarkdownImageSrcSet(
        "invalid.png 1x 2x, good.png 2x, invalid.png 0w, valid.png 800w 600h",
      ),
    ).toEqual([
      { source: "good.png", descriptor: "2x" },
      { source: "valid.png", descriptor: "800w 600h" },
    ]);
  });
});
