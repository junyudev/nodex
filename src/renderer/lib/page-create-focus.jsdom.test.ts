import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { restorePageCreateFocus, type PageCreateOrigin } from "./page-create-focus";

const origin: PageCreateOrigin = {
  surfaceId: "surface-1",
  panelTabId: "tab-1",
  projectId: "project-1",
  databaseViewId: "view-1",
  kind: "footer",
  columnId: "triage",
};

describe("restorePageCreateFocus", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  test("focuses the created Page without moving the Board scroll position", () => {
    let runFrame: FrameRequestCallback = () => undefined;
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      runFrame = callback;
      return 1;
    });
    const surface = document.createElement("div");
    surface.dataset.boardSurfaceId = origin.surfaceId;
    surface.scrollTop = 240;
    const card = document.createElement("div");
    card.dataset.boardUuidV7 = "page-created";
    const focus = vi.spyOn(card, "focus");
    surface.append(card);
    document.body.append(surface);

    restorePageCreateFocus(origin, "page-created");
    runFrame(0);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(surface.scrollTop).toBe(240);
  });

  test("returns focus to the Project when the originating View and panel have unmounted", () => {
    let runFrame: FrameRequestCallback = () => undefined;
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      runFrame = callback;
      return 1;
    });
    const projectRoot = document.createElement("div");
    projectRoot.dataset.pageCreateProjectFocusRoot = origin.projectId;
    projectRoot.tabIndex = -1;
    const focus = vi.spyOn(projectRoot, "focus");
    document.body.append(projectRoot);

    restorePageCreateFocus(origin);
    runFrame(0);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
