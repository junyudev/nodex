import { beforeEach, describe, expect, test } from "vite-plus/test";
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

  test("loads a v1 pixel position as the v2 fallback for a legacy PageTab", () => {
    const documentScopeKey = "project:legacy-viewport";
    const pageId = "page-legacy-viewport";
    const editorSessionKey = "legacy-session\u0000page-tab";
    localStorage.setItem(
      "nodex-page-stage-scroll-v1",
      JSON.stringify({ [`page-stage-session:${editorSessionKey}`]: 640 }),
    );

    expect(loadPageStageViewportSnapshot(documentScopeKey, pageId, editorSessionKey)).toEqual({
      version: 2,
      kind: "offset",
      scrollTop: 640,
    });
  });

  test("migrates the former Project-scoped key when no editor session exists", () => {
    localStorage.setItem(
      "nodex-page-stage-scroll-v1",
      JSON.stringify({ "page-stage:legacy-project:legacy-page": 320 }),
    );

    expect(loadPageStageViewportSnapshot("project:legacy-project", "legacy-page")).toEqual({
      version: 2,
      kind: "offset",
      scrollTop: 320,
    });
  });

  test("drops the old within-Block ratio so delayed Block growth uses a stable pixel anchor", () => {
    const editorSessionKey = "legacy-ratio-session\u0000page-tab";
    localStorage.setItem(
      "nodex-page-stage-viewport-v2",
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
});
