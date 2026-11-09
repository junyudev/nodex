import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { spaceStorageKey } from "./renderer-space";
import {
  forgetPageStageViewportSnapshot,
  loadPageStageViewportSnapshot,
  savePageStageViewportSnapshot,
} from "./page-stage-viewport-storage";

describe("Page Stage viewport storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("keeps independent semantic snapshots for two PageTabs showing the same Page", () => {
    const documentScopeKey = "project:viewport-sessions";
    const pageId = "page-viewport-sessions";
    const firstSessionKey = "session-viewport\u0000tab-page-1";
    const secondSessionKey = "session-viewport\u0000tab-page-2";
    const firstSnapshot = {
      version: 2,
      kind: "anchor",
      blockId: "block-a",
      viewportOffsetPx: 48,
      fallbackScrollTop: 120,
    } as const;
    const secondSnapshot = {
      version: 2,
      kind: "anchor",
      blockId: "block-b",
      viewportOffsetPx: 72,
      fallbackScrollTop: 480,
    } as const;

    savePageStageViewportSnapshot(documentScopeKey, pageId, firstSnapshot, firstSessionKey);
    savePageStageViewportSnapshot(documentScopeKey, pageId, secondSnapshot, secondSessionKey);

    expect(loadPageStageViewportSnapshot(documentScopeKey, pageId, firstSessionKey)).toEqual(
      firstSnapshot,
    );
    expect(loadPageStageViewportSnapshot(documentScopeKey, pageId, secondSessionKey)).toEqual(
      secondSnapshot,
    );

    forgetPageStageViewportSnapshot(documentScopeKey, pageId, firstSessionKey);
    expect(loadPageStageViewportSnapshot(documentScopeKey, pageId, firstSessionKey)).toBeNull();
    expect(loadPageStageViewportSnapshot(documentScopeKey, pageId, secondSessionKey)).toEqual(
      secondSnapshot,
    );
  });

  test("drops the old within-Block ratio so delayed Block growth uses a stable pixel anchor", () => {
    const editorSessionKey = "legacy-ratio-session\u0000page-tab";
    localStorage.setItem(
      spaceStorageKey("nodex-page-stage-viewport-v2"),
      JSON.stringify({
        [`page-stage-session:${editorSessionKey}`]: {
          version: 2,
          kind: "anchor",
          blockId: "legacy-ratio-block",
          viewportOffsetPx: -120,
          withinBlockRatio: 0.5,
          fallbackScrollTop: 640,
        },
      }),
    );

    expect(
      loadPageStageViewportSnapshot("project:legacy-ratio", "page-legacy-ratio", editorSessionKey),
    ).toEqual({
      version: 2,
      kind: "anchor",
      blockId: "legacy-ratio-block",
      viewportOffsetPx: -120,
      fallbackScrollTop: 640,
    });
  });

  test("keeps identical PageTab positions private to their Space and Member across renderer documents", async () => {
    const editorSessionKey = "shared-editor-session";
    const coordinate = ["project:shared-project", "shared-page", editorSessionKey] as const;
    localStorage.setItem(
      "nodex-page-stage-scroll-v1",
      JSON.stringify({ [`page-stage-session:${editorSessionKey}`]: 640 }),
    );
    const openSpace = async (spaceId: string, memberId: string) => {
      vi.resetModules();
      const { bindRendererSpace } = await import("./renderer-space");
      return import("./page-stage-viewport-storage");
    };
    const first = await openSpace("space-a", "member-a");
    first.savePageStageViewportSnapshot(
      coordinate[0],
      coordinate[1],
      { version: 2, kind: "offset", scrollTop: 120 },
      coordinate[2],
    );

    const otherSpace = await openSpace("space-b", "member-a");
    expect(otherSpace.loadPageStageViewportSnapshot(...coordinate)).toBeNull();
    otherSpace.savePageStageViewportSnapshot(
      coordinate[0],
      coordinate[1],
      { version: 2, kind: "offset", scrollTop: 240 },
      coordinate[2],
    );

    const otherMember = await openSpace("space-a", "member-b");
    expect(otherMember.loadPageStageViewportSnapshot(...coordinate)).toBeNull();
    otherMember.savePageStageViewportSnapshot(
      coordinate[0],
      coordinate[1],
      { version: 2, kind: "offset", scrollTop: 360 },
      coordinate[2],
    );

    const restored = await openSpace("space-a", "member-a");
    expect(restored.loadPageStageViewportSnapshot(...coordinate)).toEqual({
      version: 2,
      kind: "offset",
      scrollTop: 120,
    });
  });
});
