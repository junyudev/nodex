import { describe, expect, test } from "vite-plus/test";
import { createRequire } from "node:module";
import { posix } from "node:path";
import mimeDatabase from "mime-db/db.json";
import {
  classifyConversationMedia,
  conversationMediaBadge,
  conversationMediaCachePolicy,
  conversationMediaMimeType,
  resolveConversationMediaTarget,
  type ConversationMediaSource,
} from "./conversation-media-model";

const scope: ConversationMediaSource = {
  hostId: "remote-one",
  threadId: "thread",
  sourceIdentity: "thread:item-one",
  authority: {},
  nativeConnection: { sourceEpoch: "epoch", generation: 1 },
  isCurrent: () => true,
  isResourceCurrent: () => true,
};
const require = createRequire(import.meta.url);
const mimeTypes: { lookup: (path: string) => string | false } = require("mime-types");

describe("ordinary media locator policy", () => {
  test("uses a real Runtime source lease without inventing a native connection", () => {
    let current = true;
    const runtimeScope = {
      ...scope,
      hostId: "local",
      nativeConnection: undefined,
      executionSource: { identity: "session/thread/source", isCurrent: () => current },
      isResourceCurrent: () => current,
    };
    expect(resolveConversationMediaTarget("/workspace/image.png", runtimeScope)).toEqual({
      kind: "file",
      hostId: "local",
      path: "/workspace/image.png",
    });
    expect(resolveConversationMediaTarget("/workspace/movie.mp4", runtimeScope)).toMatchObject({
      kind: "stream",
      hostId: "local",
      path: "/workspace/movie.mp4",
    });
    current = false;
    expect(resolveConversationMediaTarget("/workspace/image.png", runtimeScope)).toEqual({
      kind: "blocked",
    });
  });
  test.each([
    ["/x.mp4", "video"],
    ["/x.wav", "audio"],
    ["/x.webm", "video"],
    ["/x.xml", "image"],
    ["/x.m4a", "audio"],
    ["/x.mp3/", "audio"],
    ["C:\\a\\x.mp3", "audio"],
    ["\\\\server\\share\\x.webm", "video"],
    ["//server/share/x.wav", "audio"],
    ["//x.mp3", "image"],
    ["https://a/x.mp3", "image"],
    ["file:///x.mp3", "image"],
    ["sandbox:/x.mp3", "image"],
    ["/x.mp3?raw", "image"],
    ["/x.mp3#L2", "image"],
    ["/x.mp3 ", "image"],
    ["/x%2Emp3", "image"],
    ["/.mp3", "image"],
    ["data:audio/mpeg;base64,AA==", "audio"],
    ["data:VIDEO/WEBM;base64,AA==", "image"],
    ["data:video/webm;base64,AA==", "video"],
  ] as const)("classifies raw %s as %s", (source, kind) => {
    expect(classifyConversationMedia(source)).toBe(kind);
  });

  test("matches the public registry's conflict priority for every extension and raw lexical boundary", () => {
    const extensions = new Set(
      Object.values(mimeDatabase).flatMap((entry) =>
        "extensions" in entry ? entry.extensions : [],
      ),
    );
    expect(extensions.size).toBe(1180);
    const lexical = [
      "",
      ".",
      "..",
      "mp3",
      ".mp3",
      "a..mp3",
      "a/b.mp3///",
      "a/.mp3",
      "a/..",
      "a.mp3/b",
      "a.mp3?x",
      "a.mp3#x",
      "C:\\dir.with.dot\\no-ext",
    ];
    for (const path of [...extensions, ...lexical]) {
      const expected = mimeTypes.lookup(path) || null;
      expect(conversationMediaMimeType(path), `${path} (${posix.extname(`x.${path}`)})`).toBe(
        expected,
      );
    }
    expect(conversationMediaMimeType("/x.wav")).toBe("audio/wave");
    expect(conversationMediaMimeType("/x.mp4")).toBe("video/mp4");
    expect(conversationMediaMimeType("/x.xml")).toBe("application/xml");
  });

  test("qualifies authored files by the actual host and decodes one URI stage", () => {
    expect(resolveConversationMediaTarget("/remote/a%2520b.png", scope)).toEqual({
      kind: "file",
      hostId: "remote-one",
      path: "/remote/a%20b.png",
    });
    expect(resolveConversationMediaTarget("/remote/literal%ZZ.png", scope)).toEqual({
      kind: "file",
      hostId: "remote-one",
      path: "/remote/literal%ZZ.png",
    });
    expect(resolveConversationMediaTarget("sandbox:/remote/a%23b.png", scope)).toEqual({
      kind: "file",
      hostId: "remote-one",
      path: "/remote/a#b.png",
    });
    expect(resolveConversationMediaTarget("file:///remote/a%20b.png", scope)).toEqual({
      kind: "file",
      hostId: "remote-one",
      path: "/remote/a b.png",
    });
    expect(resolveConversationMediaTarget("/remote/x.mp3", scope)).toEqual({
      kind: "file",
      hostId: "remote-one",
      path: "/remote/x.mp3",
    });
    expect(resolveConversationMediaTarget("/local/x.mp3", { ...scope, hostId: "local" })).toEqual({
      kind: "stream",
      hostId: "local",
      path: "/local/x.mp3",
      url: "app://fs/@fs/local/x.mp3",
    });
  });

  test.each([
    "./x.png",
    "app://fs/@fs/x.png",
    "/@fs/x.png",
    "blob:other",
    "file://server/share/x.png",
    "//server/share/x.png",
    "javascript:alert(1)",
  ])("does not turn %s into a browser-origin or local fallback read", (source) => {
    expect(resolveConversationMediaTarget(source, scope)).toEqual({ kind: "blocked" });
  });
  test("does not admit file capabilities without actual authority and physical connection identity", () => {
    expect(resolveConversationMediaTarget("/x.png", null)).toEqual({ kind: "blocked" });
    expect(resolveConversationMediaTarget("/x.png", { ...scope, authority: null })).toEqual({
      kind: "blocked",
    });
    expect(
      resolveConversationMediaTarget("/x.png", { ...scope, nativeConnection: undefined }),
    ).toEqual({ kind: "blocked" });
    expect(
      resolveConversationMediaTarget("/x.mp3", {
        ...scope,
        hostId: "local",
        isResourceCurrent: () => false,
      }),
    ).toEqual({ kind: "blocked" });
    expect(resolveConversationMediaTarget("https://a/x.png", null)).toEqual({
      kind: "url",
      url: "https://a/x.png",
    });
  });
  test("keeps ordinary cache lifetimes distinct from document previews", () => {
    expect(conversationMediaCachePolicy("image")).toEqual({ staleTime: Infinity, gcTime: 15_000 });
    expect(conversationMediaCachePolicy("audio")).toEqual({ staleTime: Infinity, gcTime: 0 });
    expect(conversationMediaCachePolicy("video")).toEqual({ staleTime: Infinity, gcTime: 0 });
  });
  test("renders only the actual priority badge URL family as a badge", () => {
    expect(conversationMediaBadge("https://img.shields.io/badge/P1-review-blue")).toBe("P1");
    expect(conversationMediaBadge("https://img.shields.io/badge/P10-green")).toBe("P10");
    expect(conversationMediaBadge("http://img.shields.io/badge/P1-review-blue")).toBeNull();
    expect(conversationMediaBadge("https://example.com/badge/P1-review-blue")).toBeNull();
  });
});
