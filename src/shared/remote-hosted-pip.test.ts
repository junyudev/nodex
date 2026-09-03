import { describe, expect, test } from "vite-plus/test";
import {
  buildRemoteHostedPipHiddenHostLayout,
  buildRemoteHostedPipHostLayout,
  serializeRemoteHostedPipHostLayoutIdentity,
} from "./remote-hosted-pip";

describe("remote-hosted PiP layout", () => {
  test("builds the four reference anchors for an unobstructed thread host", () => {
    const layout = buildRemoteHostedPipHostLayout({
      hostRect: {
        height: 800,
        width: 1_000,
        x: 100,
        y: 50,
      },
      obstacleRects: [],
    });

    expect(layout.hostId).toBe("codex-main-thread");
    expect(layout.presentationScope).toBe("thread");
    expect(JSON.stringify(layout.anchors)).toBe(
      JSON.stringify([
        { alignment: "top-left", point: { x: 124, y: 74 } },
        { alignment: "top-right", point: { x: 1_076, y: 74 } },
        { alignment: "bottom-left", point: { x: 124, y: 826 } },
        { alignment: "bottom-right", point: { x: 1_076, y: 826 } },
      ]),
    );
  });

  test("moves bottom anchors away from footer obstacles", () => {
    const layout = buildRemoteHostedPipHostLayout({
      hostRect: {
        height: 800,
        width: 1_000,
        x: 100,
        y: 50,
      },
      obstacleRects: [
        {
          height: 120,
          width: 1_000,
          x: 100,
          y: 730,
        },
      ],
    });

    const anchors = layout.anchors ?? [];
    const bottomLeft = anchors.find((anchor) => anchor.alignment === "bottom-left");
    const bottomRight = anchors.find((anchor) => anchor.alignment === "bottom-right");

    expect(bottomLeft?.point.y ?? 0).toBe(718);
    expect(bottomRight?.point.y ?? 0).toBe(718);
  });

  test("places the top-right presentation below the available Home surface", () => {
    const layout = buildRemoteHostedPipHostLayout({
      homeSurfaceRect: {
        height: 300,
        width: 320,
        x: 740,
        y: 80,
      },
      hostRect: {
        height: 800,
        width: 1_000,
        x: 100,
        y: 50,
      },
      isCodexHomeAvailable: true,
      obstacleRects: [],
    });

    const topRight = layout.anchors?.find((anchor) => anchor.alignment === "top-right");
    expect(topRight?.point).toEqual({ x: 1_060, y: 392 });
    expect(layout.isCodexHomeAvailable).toBe(true);
  });

  test("hidden layout clears the native host without anchors", () => {
    const layout = buildRemoteHostedPipHiddenHostLayout();

    expect(layout.hostId).toBe("codex-main-thread");
    expect(layout.anchorRect === null).toBe(true);
    expect(layout.anchors === null).toBe(true);
  });

  test("layout identity ignores animation-only changes", () => {
    const layout = buildRemoteHostedPipHostLayout({
      hostRect: {
        height: 800,
        width: 1_000,
        x: 100,
        y: 50,
      },
      obstacleRects: [],
    });
    const animatedLayout = {
      ...layout,
      animated: true,
    };

    expect(serializeRemoteHostedPipHostLayoutIdentity(layout)).toBe(
      serializeRemoteHostedPipHostLayoutIdentity(animatedLayout),
    );
  });
});
