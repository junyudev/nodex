import { describe, expect, test } from "vite-plus/test";
import vectors from "../../tests/fixtures/nodex-deeplinks.json";
import {
  buildPageDeepLink,
  buildSessionDeepLink,
  buildViewDeepLink,
  isDeepLinkOpenPayload,
  parsePageDeepLink,
  parseSessionDeepLink,
  parseViewDeepLink,
} from "./nodex-deeplink";

describe("Nodex deep-link conformance", () => {
  test.each(vectors.valid)(
    "builds and parses $kind vector $canonical",
    ({ accepted, canonical, id, kind }) => {
      const build =
        kind === "page"
          ? () => buildPageDeepLink({ pageId: id })
          : kind === "session"
            ? () => buildSessionDeepLink({ sessionId: id })
            : () => buildViewDeepLink({ viewId: id });
      const parse =
        kind === "page"
          ? (value: string) => parsePageDeepLink(value)?.pageId ?? null
          : kind === "session"
            ? (value: string) => parseSessionDeepLink(value)?.sessionId ?? null
            : (value: string) => parseViewDeepLink(value)?.viewId ?? null;

      expect(build()).toBe(canonical);
      for (const value of accepted) {
        expect(parse(value)).toBe(id);
      }
    },
  );

  test.each(vectors.invalid)("rejects $value", ({ value }) => {
    expect(parsePageDeepLink(value)).toBe(null);
    expect(parseSessionDeepLink(value)).toBe(null);
    expect(parseViewDeepLink(value)).toBe(null);
  });
});

test("retains a Space coordinate and refuses ambiguous or empty qualifiers", () => {
  const target = { pageId: "same-page", spaceId: "team-a" };
  expect(parsePageDeepLink(buildPageDeepLink(target))).toEqual(target);
  expect(parsePageDeepLink("nodex://pages/same-page?spaceId=")).toBeNull();
  expect(parsePageDeepLink("nodex://pages/same-page?spaceId=team-a&spaceId=team-b")).toBeNull();
});

test("keeps the Block fragment separate from the Page and Space coordinates", () => {
  expect(parsePageDeepLink("nodex://pages/page-1#block-1")).toEqual({
    pageId: "page-1",
    blockId: "block-1",
  });
  const target = { pageId: "page-1", spaceId: "team-a", blockId: "block /#?" };
  const url = buildPageDeepLink(target);
  expect(url).toBe("nodex://pages/page-1?spaceId=team-a#block%20%2F%23%3F");
  expect(parsePageDeepLink(url)).toEqual(target);
});

test.each(["", " block", "block ", "é".repeat(257)])(
  "rejects a Block ID that is empty, untrimmed, or over 512 bytes (%#)",
  (blockId) => {
    expect(() => buildPageDeepLink({ pageId: "page-1", blockId })).toThrow(TypeError);
    expect(parsePageDeepLink(`nodex://pages/page-1#${encodeURIComponent(blockId)}`)).toBeNull();
  },
);

test("accepts a 512-byte Block ID and rejects malformed fragment escapes", () => {
  const target = { pageId: "page-1", blockId: "é".repeat(256) };
  expect(parsePageDeepLink(buildPageDeepLink(target))).toEqual(target);
  expect(parsePageDeepLink("nodex://pages/page-1#%ZZ")).toBeNull();
});

test("validates Space-qualified IPC payloads for projectless Pages and Views", () => {
  const location = { spaceId: "team-a", projectId: null };
  const page = { ...location, pageId: "page-1", blockId: "block-1" };
  const view = { ...location, viewId: "view-1" };
  expect(isDeepLinkOpenPayload("deeplink:open-page", page)).toBe(true);
  expect(isDeepLinkOpenPayload("deeplink:open-view", view)).toBe(true);
  expect(isDeepLinkOpenPayload("deeplink:open-page", { ...page, blockId: " " })).toBe(false);
  expect(isDeepLinkOpenPayload("deeplink:open-view", { ...view, projectId: undefined })).toBe(
    false,
  );
  expect(isDeepLinkOpenPayload("deeplink:open-view", { ...view, spaceId: undefined })).toBe(false);
});
