import { expect, test } from "vitest";
import type { WebContents, WebFrameMain } from "electron";
import { getFocusedFrameOwner } from "./FocusedWebContents";

test("routes commands to the focused frame instead of an inert guest sharing native focus", () => {
  const hostFrame = {} as WebFrameMain;
  const guestFrame = {} as WebFrameMain;
  let activeFrame = hostFrame;
  const host = {
    isDestroyed: () => false,
    isFocused: () => true,
    get focusedFrame() {
      return activeFrame;
    },
  } as WebContents;
  const guest = {
    isDestroyed: () => false,
    isFocused: () => true,
    get focusedFrame() {
      return activeFrame === guestFrame ? guestFrame : null;
    },
  } as WebContents;
  const native = {
    getAllWebContents: () => [guest, host],
    fromFrame: (frame: WebFrameMain) => (frame === guestFrame ? guest : host),
  };

  expect(getFocusedFrameOwner(native)).toBe(host);
  activeFrame = guestFrame;
  expect(getFocusedFrameOwner(native)).toBe(guest);
  activeFrame = hostFrame;
  expect(getFocusedFrameOwner(native)).toBe(host);
});

test("ignores closed and unfocused contents without reading their frame", () => {
  const destroyed = {
    isDestroyed: () => true,
    isFocused: () => {
      throw new Error("Object has been destroyed");
    },
  } satisfies Pick<WebContents, "isDestroyed" | "isFocused">;
  const background = {
    isDestroyed: () => false,
    isFocused: () => false,
    get focusedFrame(): WebFrameMain | null {
      throw new Error("An inactive window must not own menu focus");
    },
  } satisfies Pick<WebContents, "isDestroyed" | "isFocused" | "focusedFrame">;
  const native = {
    getAllWebContents: () => [destroyed, background] as unknown as WebContents[],
    fromFrame: () => undefined,
  };
  expect(getFocusedFrameOwner(native)).toBeNull();
});
