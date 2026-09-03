import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  AvatarOverlayRendererCommand,
  AvatarOverlayRendererEvent,
} from "../../../shared/avatar-overlay";
import {
  DEFAULT_AVATAR_OVERLAY_LAYOUT,
  resolveAvatarOverlayStackReserve,
  resolveAvatarOverlayTrayPosition,
} from "./avatar-overlay-geometry";
import { AvatarOverlayRoot } from "./avatar-overlay-page";

const originalRect = HTMLElement.prototype.getBoundingClientRect;

function domRect(input: {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}): DOMRect {
  return {
    bottom: input.top + input.height,
    height: input.height,
    left: input.left,
    right: input.left + input.width,
    top: input.top,
    width: input.width,
    x: input.left,
    y: input.top,
    toJSON: () => input,
  };
}

describe("avatar overlay geometry", () => {
  test("reserves the native PiP stack only while the avatar is its active host", () => {
    expect(
      resolveAvatarOverlayStackReserve(DEFAULT_AVATAR_OVERLAY_LAYOUT, {
        currentHostID: "main-window",
        stackDisplayHeight: 180,
      }),
    ).toBe(0);
    expect(
      resolveAvatarOverlayStackReserve(DEFAULT_AVATAR_OVERLAY_LAYOUT, {
        currentHostID: "avatar-overlay",
        stackDisplayHeight: 180,
      }),
    ).toBe(180);

    const unreserved = resolveAvatarOverlayTrayPosition(DEFAULT_AVATAR_OVERLAY_LAYOUT, {
      currentHostID: null,
      stackDisplayHeight: 0,
    });
    const reserved = resolveAvatarOverlayTrayPosition(DEFAULT_AVATAR_OVERLAY_LAYOUT, {
      currentHostID: "avatar-overlay",
      stackDisplayHeight: 40,
    });
    expect(reserved.top).toBeLessThan(unreserved.top);
  });
});

describe("AvatarOverlayRoot", () => {
  let commands: Array<(command: AvatarOverlayRendererCommand) => void>;
  let events: AvatarOverlayRendererEvent[];
  let bridgeDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    commands = [];
    events = [];
    bridgeDescriptor = Object.getOwnPropertyDescriptor(window, "avatarOverlay");
    Object.defineProperty(window, "avatarOverlay", {
      configurable: true,
      value: {
        onCommand: (callback: (command: AvatarOverlayRendererCommand) => void) => {
          commands.push(callback);
          return () => {
            commands = commands.filter((candidate) => candidate !== callback);
          };
        },
        sendEvent: async (event: AvatarOverlayRendererEvent) => {
          events.push(event);
          return true;
        },
      },
    });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        if (this.dataset.avatarOverlayHitRegion === "mascot") {
          return domRect({ height: 121, left: 248, top: 175, width: 112 });
        }
        if (this.dataset.avatarOverlayHitRegion === "notification-tray") {
          return domRect({ height: 58, left: 176, top: 105, width: 184 });
        }
        if (this.dataset.avatarOverlaySize === "mascot") {
          return domRect({ height: 121, left: 248, top: 175, width: 112 });
        }
        if (this.dataset.avatarOverlaySize === "notification-tray") {
          return domRect({ height: 58, left: 176, top: 105, width: 184 });
        }
        return domRect({ height: 320, left: 0, top: 0, width: 384 });
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: originalRect,
    });
    if (bridgeDescriptor) Object.defineProperty(window, "avatarOverlay", bridgeDescriptor);
    else Reflect.deleteProperty(window, "avatarOverlay");
  });

  test("announces readiness and publishes measured native geometry", async () => {
    const { container } = render(<AvatarOverlayRoot />);

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "ready")).toBe(true);
      expect(events.some((event) => event.type === "element-size-changed")).toBe(true);
      expect(events.some((event) => event.type === "pointer-regions-changed")).toBe(true);
    });
    expect(container.querySelector("[data-avatar-overlay-content-frame='true']")).not.toBeNull();
    expect(container.querySelector("[data-avatar-mascot='true']")).not.toBeNull();
    expect(
      container.querySelector("[data-avatar-overlay-native-glass-group='pet-controls']"),
    ).not.toBeNull();
  });

  test("projects native layout and computer-use cursor commands into the overlay", async () => {
    const { container } = render(<AvatarOverlayRoot />);
    await vi.waitFor(() => expect(commands).toHaveLength(1));

    act(() => {
      commands[0]?.({
        isVisible: true,
        layout: {
          mascot: { height: 121, width: 112, x: 32, y: 240 },
          placement: "top-start",
          stackDisplayHeight: 90,
          viewport: { height: 600, width: 384 },
        },
        type: "layout-changed",
      });
      commands[0]?.({
        state: { currentHostID: "avatar-overlay", stackDisplayHeight: 90 },
        type: "native-layout-state-changed",
      });
      commands[0]?.({ point: { x: 80, y: 120 }, type: "computer-use-cursor-changed" });
    });

    const mascot = screen.getByRole("button", { hidden: true, name: "Nodex desktop pet" });
    expect(mascot.style.left).toBe("32px");
    expect(mascot.style.top).toBe("240px");
    expect(
      container.querySelector("[data-avatar-overlay-computer-use-cursor='true']"),
    ).not.toBeNull();

    fireEvent.mouseEnter(mascot);
    fireEvent.click(await screen.findByRole("button", { name: "Hide desktop pet" }));
    fireEvent.click(screen.getByRole("button", { name: "Close desktop pet" }));
    expect(events.some((event) => event.type === "hide")).toBe(true);
    expect(events.some((event) => event.type === "close")).toBe(true);
  });

  test("uses the target drag threshold before publishing movement", async () => {
    render(<AvatarOverlayRoot />);
    const mascot = screen.getByRole("button", { hidden: true, name: "Nodex desktop pet" });

    fireEvent.pointerDown(mascot, {
      button: 0,
      clientX: 40,
      clientY: 250,
      pointerId: 3,
      screenX: 400,
      screenY: 700,
    });
    fireEvent.pointerMove(mascot, {
      pointerId: 3,
      screenX: 402,
      screenY: 701,
    });
    expect(events.filter((event) => event.type === "drag-move")).toHaveLength(0);

    fireEvent.pointerMove(mascot, {
      pointerId: 3,
      screenX: 405,
      screenY: 701,
    });
    fireEvent.pointerUp(mascot, {
      pointerId: 3,
      screenX: 405,
      screenY: 701,
    });

    expect(events.filter((event) => event.type === "drag-start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "drag-move")).toHaveLength(1);
    expect(events.filter((event) => event.type === "drag-end")).toHaveLength(1);
  });
});
