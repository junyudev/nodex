import { describe, expect, test } from "vite-plus/test";
import { resolvePageDeepLinkPasteIntent } from "./page-reference-paste";

const base = {
  plainText: "nodex://pages/page-1",
  hasStructuredClipboard: false,
  hasFiles: false,
  hasTextSelection: false,
  currentBlockType: "paragraph",
  currentBlockIsEmpty: false,
} as const;

describe("resolvePageDeepLinkPasteIntent", () => {
  test("only converts qualified links from the current Space into relative references", () => {
    expect(
      resolvePageDeepLinkPasteIntent({
        ...base,
        plainText: `${base.plainText}?spaceId=test-space`,
      }),
    ).toEqual({ kind: "mention", pageId: "page-1" });
    expect(
      resolvePageDeepLinkPasteIntent({
        ...base,
        plainText: `${base.plainText}?spaceId=another-space`,
      }),
    ).toBeNull();
  });
  test("maps one canonical Page deeplink by editor context", () => {
    expect(resolvePageDeepLinkPasteIntent({ ...base, hasTextSelection: true })).toEqual({
      kind: "link",
      href: base.plainText,
      pageId: "page-1",
    });
    expect(resolvePageDeepLinkPasteIntent(base)).toEqual({
      kind: "mention",
      pageId: "page-1",
    });
    expect(resolvePageDeepLinkPasteIntent({ ...base, currentBlockIsEmpty: true })).toEqual({
      kind: "reference_block",
      pageId: "page-1",
    });
  });

  test("keeps code, rich clipboard, files, and non-canonical text literal", () => {
    expect(
      resolvePageDeepLinkPasteIntent({
        ...base,
        currentBlockType: "codeBlock",
      }),
    ).toBeNull();
    expect(
      resolvePageDeepLinkPasteIntent({
        ...base,
        hasStructuredClipboard: true,
      }),
    ).toBeNull();
    expect(resolvePageDeepLinkPasteIntent({ ...base, hasFiles: true })).toBeNull();
    expect(
      resolvePageDeepLinkPasteIntent({
        ...base,
        plainText: " nodex://pages/page-1",
      }),
    ).toBeNull();
    expect(
      resolvePageDeepLinkPasteIntent({
        ...base,
        plainText: "nodex:/pages/page-1",
      }),
    ).toBeNull();
  });
});
