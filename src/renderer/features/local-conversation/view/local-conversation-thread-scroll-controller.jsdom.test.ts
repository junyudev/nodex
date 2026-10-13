import { describe, expect, test } from "vite-plus/test";
import {
  getThreadScrollDistanceFromBottomPx,
  isThreadScrollNearBottom,
  resolveNativeScrollTopForDistanceFromBottomPx,
  resolveThreadScrollModeForScrollEvent,
  resolveThreadScrollKeyDirection,
} from "./local-conversation-thread-scroll-controller";

function buildScrollElement(input: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => input.clientHeight,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => input.scrollHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => input.scrollTop,
  });
  return element;
}

describe("getThreadScrollDistanceFromBottomPx", () => {
  test("treats the bottom of a column-reverse scroller as zero", () => {
    expect(getThreadScrollDistanceFromBottomPx({ scrollTop: 0 })).toBe(0);
  });

  test("converts negative native scrollTop into positive distance from bottom", () => {
    expect(getThreadScrollDistanceFromBottomPx({ scrollTop: -5_365 })).toBe(5_365);
  });
});

describe("thread keyboard scroll intent", () => {
  test("recognizes viewport paging and Shift-Space directions", () => {
    const viewport = document.createElement("div");
    const up = new KeyboardEvent("keydown", { key: "PageUp" });
    viewport.dispatchEvent(up);
    const down = new KeyboardEvent("keydown", { key: " " });
    viewport.dispatchEvent(down);
    const shift = new KeyboardEvent("keydown", { key: " ", shiftKey: true });
    viewport.dispatchEvent(shift);
    expect(resolveThreadScrollKeyDirection(up, viewport)).toBe("away");
    expect(resolveThreadScrollKeyDirection(down, viewport)).toBe("toward");
    expect(resolveThreadScrollKeyDirection(shift, viewport)).toBe("away");
  });
  test("leaves editor navigation and button activation with their own control", () => {
    const viewport = document.createElement("div");
    const input = document.createElement("textarea");
    viewport.append(input);
    const button = document.createElement("button");
    viewport.append(button);
    const up = new KeyboardEvent("keydown", { key: "ArrowUp" });
    input.dispatchEvent(up);
    const space = new KeyboardEvent("keydown", { key: " " });
    button.dispatchEvent(space);
    expect(resolveThreadScrollKeyDirection(up, viewport)).toBeNull();
    expect(resolveThreadScrollKeyDirection(space, viewport)).toBeNull();
  });
  test("recognizes repeated scrolling keys while ignoring already consumed events", () => {
    const viewport = document.createElement("div");
    const repeat = new KeyboardEvent("keydown", { key: "Home", repeat: true });
    const consumed = new KeyboardEvent("keydown", { key: "End", cancelable: true });
    consumed.preventDefault();
    expect(resolveThreadScrollKeyDirection(repeat, viewport)).toBe("away");
    expect(resolveThreadScrollKeyDirection(consumed, viewport)).toBeNull();
  });
});

describe("resolveNativeScrollTopForDistanceFromBottomPx", () => {
  test("writes negative native scrollTop for older content", () => {
    const element = buildScrollElement({
      clientHeight: 500,
      scrollHeight: 8_000,
      scrollTop: 0,
    });

    expect(resolveNativeScrollTopForDistanceFromBottomPx(element, 5_365)).toBe(-5_365);
  });

  test("keeps the bottom target at native zero", () => {
    const element = buildScrollElement({
      clientHeight: 500,
      scrollHeight: 8_000,
      scrollTop: -100,
    });

    expect(resolveNativeScrollTopForDistanceFromBottomPx(element, 0)).toBe(0);
  });
});

describe("isThreadScrollNearBottom", () => {
  test("treats positions within the Codex near-bottom threshold as bottom", () => {
    expect(
      isThreadScrollNearBottom({
        scrollDistanceFromBottomPx: 12,
      }),
    ).toBe(true);
  });

  test("treats positions beyond the Codex near-bottom threshold as scrolled away", () => {
    expect(
      isThreadScrollNearBottom({
        scrollDistanceFromBottomPx: 25,
      }),
    ).toBe(false);
  });
});

describe("resolveThreadScrollModeForScrollEvent", () => {
  test("preserves programmatic find mode until the programmatic settle window expires", () => {
    expect(
      resolveThreadScrollModeForScrollEvent({
        currentMode: "programmaticFind",
        isNearBottom: false,
        nowMs: 1_000,
        userScrollGraceUntilMs: 1_500,
        programmaticScrollSettledUntilMs: 1_100,
      }),
    ).toBe("programmaticFind");
  });

  test("returns user after the programmatic find settle window expires", () => {
    expect(
      resolveThreadScrollModeForScrollEvent({
        currentMode: "programmaticFind",
        isNearBottom: false,
        nowMs: 1_200,
        userScrollGraceUntilMs: 1_500,
        programmaticScrollSettledUntilMs: 1_100,
      }),
    ).toBe("user");
  });

  test("returns stickToBottom when the scroll position reaches the bottom again", () => {
    expect(
      resolveThreadScrollModeForScrollEvent({
        currentMode: "user",
        isNearBottom: true,
        nowMs: 1_000,
        userScrollGraceUntilMs: 1_500,
        programmaticScrollSettledUntilMs: 900,
      }),
    ).toBe("stickToBottom");
  });

  test("returns user when the user recently scrolled away and programmatic scrolling has settled", () => {
    expect(
      resolveThreadScrollModeForScrollEvent({
        currentMode: "stickToBottom",
        isNearBottom: false,
        nowMs: 1_000,
        userScrollGraceUntilMs: 1_200,
        programmaticScrollSettledUntilMs: 900,
      }),
    ).toBe("user");
  });

  test("does not leave stickToBottom without a recent user interaction", () => {
    expect(
      resolveThreadScrollModeForScrollEvent({
        currentMode: "stickToBottom",
        isNearBottom: false,
        nowMs: 2_000,
        userScrollGraceUntilMs: 1_200,
        programmaticScrollSettledUntilMs: 900,
      }),
    ).toBe("stickToBottom");
  });
});
