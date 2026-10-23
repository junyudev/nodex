import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { render } from "@/test/dom";
import { ComposerContextControls } from "./composer-context-controls";

const MOUSE = {
  button: 0,
  buttons: 1,
  pointerId: 7,
  pointerType: "mouse",
  clientX: 80,
  clientY: 10,
};

function setGeometry(scroller: HTMLElement, overflow = true) {
  Object.defineProperties(scroller, {
    clientWidth: { configurable: true, value: 100 },
    scrollWidth: { configurable: true, value: overflow ? 300 : 100 },
  });
  let captured = false;
  const setPointerCapture = vi.fn(() => {
    captured = true;
  });
  Object.assign(scroller, {
    setPointerCapture,
    releasePointerCapture: () => {
      captured = false;
    },
    hasPointerCapture: () => captured,
  });
  return { setPointerCapture };
}

function setupMenu() {
  const select = vi.fn();
  const view = render(
    <ComposerContextControls>
      <NodexDropdownMenu triggerButton={<button type="button">Project</button>}>
        <NodexDropdownItem onSelect={select}>Another project</NodexDropdownItem>
      </NodexDropdownMenu>
    </ComposerContextControls>,
  );
  const trigger = view.getByRole("button", { name: "Project" });
  const scroller = view.getByRole("group", { name: "Composer utility bar" });
  const capture = setGeometry(scroller);
  return { view, trigger, scroller, select, ...capture };
}

describe("Composer context control scrolling", () => {
  test.each([1, 2])(
    "scrolls at window zoom %s without opening a menu, then allows a normal click and popup interaction",
    async (zoom) => {
      const { view, trigger, scroller, select, setPointerCapture } = setupMenu();
      scroller.style.setProperty("--codex-window-zoom", String(zoom));
      try {
        await act(async () => {
          fireEvent.pointerDown(trigger, MOUSE);
          fireEvent.mouseDown(trigger, MOUSE);
          fireEvent.pointerMove(trigger, { ...MOUSE, clientX: 40 });
          await Promise.resolve();
        });
        expect(scroller.scrollLeft).toBe(40 / zoom);
        expect(setPointerCapture).toHaveBeenCalledWith(7);
        expect(view.queryByRole("menu")).toBeNull();
      } finally {
        await act(async () => {
          fireEvent.pointerUp(scroller, { ...MOUSE, buttons: 0, clientX: 40 });
          fireEvent.click(trigger, { detail: 1 });
          await Promise.resolve();
        });
      }
      expect(view.queryByRole("menu")).toBeNull();

      await act(async () => {
        fireEvent.pointerDown(trigger, MOUSE);
        fireEvent.mouseDown(trigger, MOUSE);
        fireEvent.pointerMove(trigger, { ...MOUSE, clientX: 76 });
        fireEvent.pointerUp(trigger, { ...MOUSE, buttons: 0, clientX: 76 });
        fireEvent.mouseUp(trigger, MOUSE);
        fireEvent.click(trigger, { detail: 1 });
        await Promise.resolve();
      });
      const item = await view.findByRole("menuitem", { name: "Another project" });
      await act(async () => {
        fireEvent.pointerDown(item, MOUSE);
        fireEvent.mouseDown(item, MOUSE);
        fireEvent.pointerUp(item, { ...MOUSE, buttons: 0 });
        fireEvent.mouseUp(item, MOUSE);
        fireEvent.click(item, { detail: 1 });
        await Promise.resolve();
      });
      expect(select).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
    },
  );

  test.each([
    { name: "controls fit", overflow: false, pointer: MOUSE },
    { name: "touch scroll", overflow: true, pointer: { ...MOUSE, pointerType: "touch" } },
    { name: "modified click", overflow: true, pointer: { ...MOUSE, metaKey: true } },
  ])("leaves $name to the original control", async ({ overflow, pointer }) => {
    const press = vi.fn();
    const click = vi.fn();
    const view = render(
      <ComposerContextControls>
        <button type="button" onPointerDown={press} onClick={click}>
          Control
        </button>
      </ComposerContextControls>,
    );
    const scroller = view.getByRole("group", { name: "Composer utility bar" });
    const { setPointerCapture } = setGeometry(scroller, overflow);
    const control = view.getByRole("button", { name: "Control" });
    await act(async () => {
      fireEvent.pointerDown(control, pointer);
      fireEvent.pointerMove(control, { ...pointer, clientX: 40 });
      fireEvent.pointerUp(control, { ...pointer, buttons: 0, clientX: 40 });
      fireEvent.click(control, { detail: 1 });
      await Promise.resolve();
    });
    expect(press).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(scroller.scrollLeft).toBe(0);
  });

  test("cancels an unfinished press without opening a menu and retains keyboard activation", async () => {
    const { view, trigger } = setupMenu();
    await act(async () => {
      fireEvent.pointerDown(trigger, MOUSE);
      fireEvent.pointerCancel(trigger, { ...MOUSE, buttons: 0 });
      await Promise.resolve();
    });
    expect(view.queryByRole("menu")).toBeNull();
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter" });
      fireEvent.click(trigger, { detail: 0 });
      fireEvent.keyUp(trigger, { key: "Enter" });
      await Promise.resolve();
    });
    expect(await view.findByRole("menuitem", { name: "Another project" })).toBeTruthy();
  });
});
