import { act, fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { KeyboardShortcutHelpDialog } from "@/components/workbench/keyboard-shortcut-help-dialog";
import { isComposerDictationShortcut } from "@/features/local-conversation/view/composer/use-composer-dictation";
import {
  createCommandKeymapState,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
import { useWorkbenchShortcuts, type WorkbenchShortcutActions } from "./use-workbench-shortcuts";
import "../globals.css";

test("pending shortcut help mounts without Node globals and adopts the loaded keymap", async () => {
  expect(typeof process).toBe("undefined");
  const props = { open: true, onOpenChange: vi.fn(), onCustomize: vi.fn() };
  const view = render(<KeyboardShortcutHelpDialog {...props} commandKeymapState={null} />);
  await view.findByRole("dialog", { name: "Keyboard shortcuts" });
  const search = view.getByRole("textbox", { name: "Search keyboard shortcuts" });
  await act(async () => {
    fireEvent.change(search, { target: { value: "Open settings" } });
  });
  expect(view.getByText("Settings")).toBeVisible();
  view.rerender(
    <KeyboardShortcutHelpDialog
      {...props}
      commandKeymapState={createCommandKeymapState({ settings: ["Ctrl+Alt+Y"] }, "linux")}
    />,
  );
  expect(await view.findByText("Ctrl+Alt+Y")).toBeVisible();
  expect(view.getByRole("textbox", { name: "Search keyboard shortcuts" })).toBe(search);
});

function MouseBindings({
  state,
  back,
  forward,
}: {
  readonly state: CommandKeymapState | null;
  readonly back: NonNullable<WorkbenchShortcutActions["navigateBack"]>;
  readonly forward: NonNullable<WorkbenchShortcutActions["navigateForward"]>;
}) {
  useWorkbenchShortcuts({
    projectOrder: [],
    switchToProjectIndex: () => {},
    commandKeymapState: state,
    navigateBack: back,
    navigateForward: forward,
  });
  return null;
}

test("pending mouse navigation uses browser-safe defaults until loaded bindings take ownership", async () => {
  expect(typeof process).toBe("undefined");
  const back = vi.fn();
  const forward = vi.fn();
  const view = render(<MouseBindings state={null} back={back} forward={forward} />);
  const dispatch = async (button: number) => {
    const event = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
    await act(async () => {
      document.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };
  expect(await dispatch(3)).toBe(true);
  expect(back).toHaveBeenCalledExactlyOnceWith("mouse_back");
  expect(await dispatch(4)).toBe(true);
  expect(forward).toHaveBeenCalledExactlyOnceWith("mouse_forward");
  view.rerender(
    <MouseBindings
      state={createCommandKeymapState({ navigateBack: [], navigateForward: [] }, "linux")}
      back={back}
      forward={forward}
    />,
  );
  expect(await dispatch(3)).toBe(false);
  expect(await dispatch(4)).toBe(false);
  view.unmount();
  expect(await dispatch(3)).toBe(false);
  expect(back).toHaveBeenCalledOnce();
  expect(forward).toHaveBeenCalledOnce();
});

test("pending composer shortcut recognition is browser-safe without acquiring microphone authority", () => {
  expect(typeof process).toBe("undefined");
  const event = new KeyboardEvent("keydown", { key: "m", ctrlKey: true });
  expect(isComposerDictationShortcut(event, undefined)).toBe(true);
  const loaded = createCommandKeymapState({ composerDictationHold: [] }, "linux");
  expect(isComposerDictationShortcut(event, loaded)).toBe(false);
});
