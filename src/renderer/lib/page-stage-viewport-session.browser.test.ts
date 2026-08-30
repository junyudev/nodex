import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { PageStageViewportSession } from "./page-stage-viewport-session";

const sessions: PageStageViewportSession[] = [];

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function createViewport(
  dynamicBlockHeight: number,
  options: { readonly marksPendingLayout?: boolean } = {},
) {
  const scrollElement = document.createElement("div");
  scrollElement.style.cssText = [
    "height: 240px",
    "width: 420px",
    "overflow-y: auto",
    "overflow-anchor: none",
    "position: relative",
  ].join(";");

  const body = document.createElement("div");
  body.dataset.pageStageBody = "true";
  const contentRoot = document.createElement("div");
  const dynamicBlock = document.createElement("div");
  dynamicBlock.className = "bn-block";
  dynamicBlock.dataset.id = "dynamic-block";
  if (options.marksPendingLayout !== false) {
    dynamicBlock.dataset.nfmImageLayoutStable = "false";
  }
  dynamicBlock.style.height = `${dynamicBlockHeight}px`;
  const gap = document.createElement("div");
  gap.style.height = "100px";
  const target = document.createElement("div");
  target.className = "bn-block";
  target.dataset.id = "reading-anchor";
  target.style.height = "48px";
  target.textContent = "Reading anchor";
  const tail = document.createElement("div");
  tail.style.height = "900px";

  contentRoot.append(dynamicBlock, gap, target, tail);
  body.append(contentRoot);
  scrollElement.append(body);
  document.body.append(scrollElement);
  return { scrollElement, contentRoot, dynamicBlock, target };
}

function targetViewportOffset(scrollElement: HTMLElement, target: HTMLElement): number {
  return target.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top;
}

async function captureReadingPosition(
  session: PageStageViewportSession,
  viewport: ReturnType<typeof createViewport>,
) {
  session.mount(viewport.scrollElement, viewport.contentRoot);
  viewport.scrollElement.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 80 }));
  viewport.scrollElement.scrollTop +=
    targetViewportOffset(viewport.scrollElement, viewport.target) - 80;
  viewport.scrollElement.dispatchEvent(new Event("scroll"));
  await nextFrame();
  expect(Math.abs(targetViewportOffset(viewport.scrollElement, viewport.target) - 80)).toBeLessThan(
    1,
  );
  session.unmount();
  viewport.scrollElement.remove();
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  document.body.replaceChildren();
  localStorage.clear();
});

describe("Page Stage viewport continuity in Chromium", () => {
  test("keeps a semantic block at the same viewport position through delayed image layout", async () => {
    const session = new PageStageViewportSession({
      documentScopeKey: "project:viewport-browser",
      pageId: "page-viewport-browser",
      editorSessionKey: "surface-semantic-anchor",
    });
    sessions.push(session);
    await captureReadingPosition(session, createViewport(800));

    const restored = createViewport(80);
    session.mount(restored.scrollElement, restored.contentRoot);
    await nextFrame();
    expect(
      Math.abs(targetViewportOffset(restored.scrollElement, restored.target) - 80),
    ).toBeLessThan(2);

    restored.dynamicBlock.style.height = "800px";
    restored.dynamicBlock.dataset.nfmImageLayoutStable = "true";

    await waitFor(() => {
      expect(
        Math.abs(targetViewportOffset(restored.scrollElement, restored.target) - 80),
      ).toBeLessThan(2);
    });
  });

  test("stops compensating as soon as the user takes over scrolling", async () => {
    const session = new PageStageViewportSession({
      documentScopeKey: "project:viewport-user-intent",
      pageId: "page-viewport-user-intent",
      editorSessionKey: "surface-user-intent",
    });
    sessions.push(session);
    await captureReadingPosition(session, createViewport(800));

    const restored = createViewport(80);
    session.mount(restored.scrollElement, restored.contentRoot);
    await nextFrame();
    restored.scrollElement.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 12 }));
    restored.dynamicBlock.style.height = "800px";
    restored.dynamicBlock.dataset.nfmImageLayoutStable = "true";
    await nextFrame();
    await nextFrame();

    expect(targetViewportOffset(restored.scrollElement, restored.target)).toBeGreaterThan(700);
  });

  test("does not overwrite the last observed viewport after teardown collapses the DOM", async () => {
    const session = new PageStageViewportSession({
      documentScopeKey: "project:viewport-teardown",
      pageId: "page-viewport-teardown",
      editorSessionKey: "surface-teardown",
    });
    sessions.push(session);
    const source = createViewport(800);
    session.mount(source.scrollElement, source.contentRoot);
    source.scrollElement.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 80 }));
    source.scrollElement.scrollTop +=
      targetViewportOffset(source.scrollElement, source.target) - 80;
    source.scrollElement.dispatchEvent(new Event("scroll"));
    await nextFrame();

    source.contentRoot.replaceChildren();
    source.scrollElement.scrollTop = 0;
    session.unmount();
    source.scrollElement.remove();

    const restored = createViewport(800);
    session.mount(restored.scrollElement, restored.contentRoot);
    await nextFrame();
    expect(
      Math.abs(targetViewportOffset(restored.scrollElement, restored.target) - 80),
    ).toBeLessThan(2);
  });

  test("compensates delayed layout from any Block type, not only images", async () => {
    const session = new PageStageViewportSession({
      documentScopeKey: "project:viewport-generic-layout",
      pageId: "page-viewport-generic-layout",
      editorSessionKey: "surface-generic-layout",
    });
    sessions.push(session);
    await captureReadingPosition(session, createViewport(800, { marksPendingLayout: false }));

    const restored = createViewport(80, { marksPendingLayout: false });
    session.mount(restored.scrollElement, restored.contentRoot);
    await new Promise((resolve) => setTimeout(resolve, 180));
    restored.dynamicBlock.style.height = "800px";

    await waitFor(() => {
      expect(
        Math.abs(targetViewportOffset(restored.scrollElement, restored.target) - 80),
      ).toBeLessThan(2);
    });
  });

  test("reanchors later layout changes after user scrolling settles", async () => {
    const session = new PageStageViewportSession({
      documentScopeKey: "project:viewport-reanchor",
      pageId: "page-viewport-reanchor",
      editorSessionKey: "surface-reanchor",
    });
    sessions.push(session);
    await captureReadingPosition(session, createViewport(800));

    const restored = createViewport(80, { marksPendingLayout: false });
    session.mount(restored.scrollElement, restored.contentRoot);
    await nextFrame();
    restored.scrollElement.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 40 }));
    restored.scrollElement.scrollTop += 40;
    restored.scrollElement.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const settledOffset = targetViewportOffset(restored.scrollElement, restored.target);

    restored.dynamicBlock.style.height = "800px";
    await waitFor(() => {
      expect(
        Math.abs(targetViewportOffset(restored.scrollElement, restored.target) - settledOffset),
      ).toBeLessThan(2);
    });
  });

  test("lets an explicit in-app jump replace the restored anchor", async () => {
    const session = new PageStageViewportSession({
      documentScopeKey: "project:viewport-navigation",
      pageId: "page-viewport-navigation",
      editorSessionKey: "surface-navigation",
    });
    sessions.push(session);
    await captureReadingPosition(session, createViewport(800));

    const restored = createViewport(80, { marksPendingLayout: false });
    session.mount(restored.scrollElement, restored.contentRoot);
    await nextFrame();
    restored.scrollElement.scrollTop += 40;
    session.adoptCurrentViewport();
    const adoptedOffset = targetViewportOffset(restored.scrollElement, restored.target);

    restored.dynamicBlock.style.height = "800px";
    await waitFor(() => {
      expect(
        Math.abs(targetViewportOffset(restored.scrollElement, restored.target) - adoptedOffset),
      ).toBeLessThan(2);
    });
  });

  test("ignores a stale DOM lease after a replacement EditorView mounts", async () => {
    const session = new PageStageViewportSession({
      documentScopeKey: "project:viewport-lease",
      pageId: "page-viewport-lease",
      editorSessionKey: "surface-lease",
    });
    sessions.push(session);
    const first = createViewport(800);
    const staleLease = session.mount(first.scrollElement, first.contentRoot);
    first.scrollElement.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 80 }));
    first.scrollElement.scrollTop += targetViewportOffset(first.scrollElement, first.target) - 80;
    first.scrollElement.dispatchEvent(new Event("scroll"));
    await nextFrame();

    const replacement = createViewport(80, { marksPendingLayout: false });
    session.mount(replacement.scrollElement, replacement.contentRoot);
    await nextFrame();
    staleLease.release();
    replacement.dynamicBlock.style.height = "800px";

    await waitFor(() => {
      expect(
        Math.abs(targetViewportOffset(replacement.scrollElement, replacement.target) - 80),
      ).toBeLessThan(2);
    });
  });
});
