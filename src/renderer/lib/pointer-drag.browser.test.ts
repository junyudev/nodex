import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import "@/globals.css";
import {
  POINTER_DRAG_ROOT_ATTRIBUTE,
  startPointerDrag,
  type PointerDrag,
  type PointerDragEnd,
} from "./pointer-drag";

const POINTER_ID = 1;

function pointer(
  type: string,
  target: EventTarget,
  init: PointerEventInit & { readonly clientX: number },
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      isPrimary: true,
      pointerId: POINTER_ID,
      pointerType: "mouse",
      clientY: 10,
      ...init,
    }),
  );
}

function mountHandle() {
  const host = document.createElement("div");
  host.style.cssText = "position: fixed; inset: 0; display: flex;";
  const handle = document.createElement("div");
  handle.style.cssText = "width: 8px; cursor: col-resize;";
  const guestFrame = document.createElement("div");
  guestFrame.style.cssText = "position: relative; flex: 1;";
  const guest = document.createElement("iframe");
  guest.style.cssText = "position: absolute; inset: 0; width: 100%; height: 100%; border: 0;";
  guestFrame.append(guest);
  host.append(handle, guestFrame);
  document.body.append(host);

  const moves: number[] = [];
  const ends: PointerDragEnd[] = [];
  let drag: PointerDrag | null = null;
  handle.addEventListener("pointerdown", (event) => {
    drag = startPointerDrag(event, {
      onMove: (move) => moves.push(move.clientX),
      onEnd: (end) => ends.push(end),
    });
  });
  const press = (init: PointerEventInit = {}) =>
    pointer("pointerdown", handle, { button: 0, buttons: 1, clientX: 4, ...init });
  return { host, handle, guest, guestFrame, moves, ends, press, drag: () => drag };
}

let mounted: ReturnType<typeof mountHandle> | null = null;
function setup() {
  mounted = mountHandle();
  return mounted;
}

afterEach(() => {
  mounted?.drag()?.dispose();
  mounted?.host.remove();
  mounted = null;
});

describe("startPointerDrag", () => {
  // Each release lands at x=40 after the last move to x=120; the drag must stop following the
  // pointer and commit where the handle was last shown.
  test.each([
    ["a seen release", "pointerup", { button: 0, buttons: 0 }],
    // The button came up over a guest page; the next event arrives without it.
    ["a release seen only through the next move", "pointermove", { buttons: 0 }],
    ["a release seen only through the next press", "pointerdown", { button: 0, buttons: 1 }],
  ] as const)("%s ends the drag where the handle last was", (_name, type, init) => {
    const { moves, ends, press } = setup();
    press();
    pointer("pointermove", document.body, { buttons: 1, clientX: 120 });
    pointer(type, document.body, { ...init, clientX: 40 });
    pointer("pointermove", document.body, { buttons: 1, clientX: 20 });

    expect(moves).toEqual([120]);
    expect(ends).toEqual(["release"]);
    expect(document.documentElement.hasAttribute(POINTER_DRAG_ROOT_ATTRIBUTE)).toBe(false);
  });

  test("reports cancellation and disposal, and ignores other pointers and buttons", () => {
    const { moves, ends, press, drag } = setup();
    press({ button: 2, buttons: 2 });
    expect(drag()).toBeNull();

    press();
    pointer("pointermove", document.body, { buttons: 1, clientX: 60, pointerId: 2 });
    pointer("pointerup", document.body, { button: 0, clientX: 60, pointerId: 2 });
    pointer("pointercancel", document.body, { clientX: 60 });
    press();
    drag()?.dispose();
    drag()?.dispose();

    expect(moves).toEqual([]);
    expect(ends).toEqual(["cancel", "dispose"]);
  });

  test("keeps guest pages from taking the pointer and shows the handle's cursor while it lasts", () => {
    const { guest, guestFrame, press } = setup();
    const rect = guest.getBoundingClientRect();
    const hit = () =>
      document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(hit()).toBe(guest);

    press();
    expect(hit()).toBe(guestFrame);
    expect(getComputedStyle(document.documentElement).cursor).toBe("col-resize");
    expect(getComputedStyle(document.documentElement).userSelect).toBe("none");

    pointer("pointerup", document.body, { button: 0, clientX: 4 });
    expect(hit()).toBe(guest);
    expect(getComputedStyle(document.documentElement).cursor).toBe("auto");
  });

  test("keeps the document held until every overlapping drag ends", () => {
    const first = setup();
    const second = mountHandle();
    try {
      const onEnd = vi.fn();
      second.handle.addEventListener("pointerdown", (event) => {
        startPointerDrag(event, { onMove: () => undefined, onEnd });
      });
      first.press();
      pointer("pointerdown", second.handle, {
        button: 0,
        buttons: 1,
        clientX: 4,
        pointerId: 2,
      });
      pointer("pointerup", document.body, { button: 0, clientX: 4 });
      expect(document.documentElement.hasAttribute(POINTER_DRAG_ROOT_ATTRIBUTE)).toBe(true);

      pointer("pointerup", document.body, { button: 0, clientX: 4, pointerId: 2 });
      expect(onEnd).toHaveBeenCalledExactlyOnceWith("release");
      expect(document.documentElement.hasAttribute(POINTER_DRAG_ROOT_ATTRIBUTE)).toBe(false);
    } finally {
      second.host.remove();
    }
  });
});
