import { describe, expect, test } from "bun:test";
import { distanceFromBottom, shouldAutoScrollThread, shouldShowThreadCatchUpControl } from "./thread-auto-scroll";

describe("thread-auto-scroll", () => {
  test("auto-scrolls when near bottom", () => {
    expect(
      shouldAutoScrollThread({
        position: {
          scrollHeight: 1_000,
          scrollTop: 420,
          clientHeight: 500,
        },
      }),
    ).toBeTrue();
  });

  test("auto-scrolls when exactly on near-bottom threshold", () => {
    expect(
      shouldAutoScrollThread({
        position: {
          scrollHeight: 1_000,
          scrollTop: 380,
          clientHeight: 500,
        },
      }),
    ).toBeTrue();
  });

  test("does not auto-scroll when far from bottom", () => {
    expect(
      shouldAutoScrollThread({
        position: {
          scrollHeight: 2_000,
          scrollTop: 800,
          clientHeight: 500,
        },
      }),
    ).toBeFalse();
  });

  test("distance from bottom never returns negative values", () => {
    expect(
      distanceFromBottom({
        scrollHeight: 1_000,
        scrollTop: 980,
        clientHeight: 200,
      }),
    ).toBe(0);
  });

  test("shows catch-up control when thread has messages and user is reading above latest", () => {
    expect(
      shouldShowThreadCatchUpControl({
        hasThread: true,
        hasItems: true,
        isFollowingLatest: false,
      }),
    ).toBeTrue();
  });

  test("hides catch-up control while following latest", () => {
    expect(
      shouldShowThreadCatchUpControl({
        hasThread: true,
        hasItems: true,
        isFollowingLatest: true,
      }),
    ).toBeFalse();
  });

  test("hides catch-up control without thread messages", () => {
    expect(
      shouldShowThreadCatchUpControl({
        hasThread: true,
        hasItems: false,
        isFollowingLatest: false,
      }),
    ).toBeFalse();
  });
});
