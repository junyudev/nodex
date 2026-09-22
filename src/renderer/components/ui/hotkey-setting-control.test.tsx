import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useState } from "react";
import { HotkeySettingControl, bareModifierIdentity } from "./hotkey-setting-control";
import type { RuntimePlatform } from "../../../shared/command-keybindings";

function pendingCapture() {
  let resolve!: (value: string | null) => void;
  const promise = new Promise<string | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function renderCapture(
  onCapture: (accelerator: string) => void,
  allowsBareModifiers = true,
  captureBareModifierHotkey?: (
    signal: AbortSignal,
    allowsBareModifiers: boolean,
  ) => Promise<string | null>,
  platform: RuntimePlatform = "macOS",
  closeOnCapture = true,
) {
  function Recorder() {
    const [isCapturing, setIsCapturing] = useState(true);
    return (
      <HotkeySettingControl
        accelerator="Ctrl+Space"
        acceleratorLabel="⌃Space"
        allowsBareModifiers={allowsBareModifiers}
        captureAriaLabel="Toggle dictation hotkey capture"
        captureBareModifierHotkey={captureBareModifierHotkey}
        hotkeyName="Toggle dictation hotkey"
        isCapturing={isCapturing}
        onCancelCapture={() => undefined}
        onCapture={(accelerator) => {
          onCapture(accelerator);
          if (closeOnCapture) setIsCapturing(false);
        }}
        onClear={() => undefined}
        onStartCapture={() => undefined}
        platform={platform}
      />
    );
  }
  render(<Recorder />);
  const input = screen.getByRole("textbox", { name: "Toggle dictation hotkey capture" });
  await act(async () => {
    await Promise.resolve();
  });
  return input;
}

async function keyEvent(input: HTMLElement, phase: "keyDown" | "keyUp", event: KeyboardEventInit) {
  await act(async () => {
    fireEvent[phase](input, event);
    await Promise.resolve();
  });
}

describe("HotkeySettingControl", () => {
  test("keeps a modifier key pending so Ctrl+Y is captured as one chord", async () => {
    const onCapture = vi.fn();
    const input = await renderCapture(onCapture);

    await keyEvent(input, "keyDown", {
      altKey: false,
      code: "ControlLeft",
      ctrlKey: true,
      key: "Control",
      location: 1,
      metaKey: false,
      shiftKey: false,
    });
    expect(onCapture).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("Press shortcut");

    await keyEvent(input, "keyDown", {
      altKey: false,
      code: "KeyY",
      ctrlKey: true,
      key: "y",
      location: 0,
      metaKey: false,
      shiftKey: false,
    });

    expect(onCapture).toHaveBeenCalledOnce();
    expect(onCapture).toHaveBeenCalledWith("Ctrl+Y");
  });

  test("uses the physical layout key when Option changes KeyboardEvent.key", async () => {
    const onCapture = vi.fn();
    const input = await renderCapture(onCapture);

    await keyEvent(input, "keyDown", {
      altKey: true,
      code: "AltLeft",
      key: "Alt",
      location: 1,
    });
    expect(onCapture).not.toHaveBeenCalled();
    await keyEvent(input, "keyDown", {
      altKey: true,
      code: "KeyY",
      key: "¥",
      location: 0,
    });

    expect(onCapture).toHaveBeenCalledWith("Alt+Y");
  });

  test("ignores unsupported values from the native bare capture boundary", async () => {
    const captureBareModifierHotkey = vi.fn().mockResolvedValue("Ctrl");
    const onCapture = vi.fn();
    const input = await renderCapture(onCapture, true, captureBareModifierHotkey);

    await keyEvent(input, "keyDown", {
      code: "ControlLeft",
      ctrlKey: true,
      key: "Control",
      location: 1,
    });

    await waitFor(() => expect(captureBareModifierHotkey).toHaveBeenCalledOnce());
    await act(async () => {
      await Promise.resolve();
    });
    expect(onCapture).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("Press shortcut");

    await keyEvent(input, "keyDown", {
      code: "KeyY",
      ctrlKey: true,
      key: "y",
      location: 0,
    });
    expect(onCapture).toHaveBeenCalledWith("Ctrl+Y");
  });

  test("accepts Fn from the native bare capture boundary", async () => {
    const captureBareModifierHotkey = vi.fn().mockResolvedValue("Fn");
    const onCapture = vi.fn();

    await renderCapture(onCapture, true, captureBareModifierHotkey);

    await waitFor(() => expect(onCapture).toHaveBeenCalledWith("Fn"));
  });

  test("keeps modifiers pending for ordinary shortcuts that disallow modifier-only bindings", async () => {
    const onCapture = vi.fn();
    const input = await renderCapture(onCapture, false);

    await keyEvent(input, "keyDown", {
      code: "ControlLeft",
      ctrlKey: true,
      key: "Control",
      location: 1,
    });
    await keyEvent(input, "keyDown", {
      code: "ShiftLeft",
      ctrlKey: true,
      key: "Shift",
      location: 1,
      shiftKey: true,
    });
    expect(onCapture).not.toHaveBeenCalled();

    await keyEvent(input, "keyDown", {
      code: "KeyY",
      ctrlKey: true,
      key: "y",
      shiftKey: true,
    });
    expect(onCapture).toHaveBeenCalledWith("Ctrl+Shift+Y");
  });

  test("commits a bare left modifier only when the matching key is released", async () => {
    const onCapture = vi.fn();
    const input = await renderCapture(onCapture);

    await keyEvent(input, "keyDown", {
      ctrlKey: true,
      key: "Control",
      location: 1,
    });
    expect(onCapture).not.toHaveBeenCalled();

    await keyEvent(input, "keyUp", {
      ctrlKey: false,
      key: "Control",
      location: 1,
    });
    expect(onCapture).toHaveBeenCalledWith("LeftControl");
  });

  test.each([
    ["Alt", "DoubleOption"],
    ["Meta", "DoubleCommand"],
    ["Shift", "DoubleShift"],
  ] as const)("captures both %s keys as %s", async (key, accelerator) => {
    const onCapture = vi.fn();
    const input = await renderCapture(onCapture);
    const modifierState =
      key === "Alt" ? { altKey: true } : key === "Meta" ? { metaKey: true } : { shiftKey: true };

    await keyEvent(input, "keyDown", { ...modifierState, key, location: 1 });
    await keyEvent(input, "keyDown", { ...modifierState, key, location: 2 });
    await keyEvent(input, "keyUp", { ...modifierState, key, location: 1 });

    expect(onCapture).toHaveBeenCalledOnce();
    expect(onCapture).toHaveBeenCalledWith(accelerator);
  });

  test("preserves modifier side and rejects right Control as a bare shortcut", () => {
    expect(
      bareModifierIdentity(
        {
          altKey: true,
          ctrlKey: false,
          key: "Alt",
          location: 2,
          metaKey: false,
          shiftKey: false,
        },
        "pressed",
      ),
    ).toBe("RightOption");
    expect(
      bareModifierIdentity(
        {
          altKey: false,
          ctrlKey: true,
          key: "Control",
          location: 2,
          metaKey: false,
          shiftKey: false,
        },
        "pressed",
      ),
    ).toBeNull();
  });
});

describe("modifier-family capture", () => {
  test.each([
    [
      [
        ["Control", 1],
        ["Alt", 2],
      ],
      "Ctrl+Alt",
    ],
    [
      [
        ["Control", 2],
        ["Shift", 1],
      ],
      "Ctrl+Shift",
    ],
    [
      [
        ["Meta", 2],
        ["Shift", 2],
      ],
      "Command+Shift",
    ],
    [
      [
        ["Alt", 1],
        ["Alt", 2],
        ["Control", 1],
      ],
      "Ctrl+Alt",
    ],
    [
      [
        ["Shift", 1],
        ["Meta", 1],
        ["Control", 2],
      ],
      "Ctrl+Command+Shift",
    ],
    [
      [
        ["Fn", 0],
        ["Shift", 2],
      ],
      "Shift+Fn",
    ],
  ] as const)("collapses physical keys %j into %s on the first release", async (keys, expected) => {
    const onCapture = vi.fn();
    const input = await renderCapture(onCapture);
    for (const [key, location] of keys) await keyEvent(input, "keyDown", { key, location });
    expect(onCapture).not.toHaveBeenCalled();
    const [key, location] = keys[0];
    await keyEvent(input, "keyUp", { key, location });
    expect(onCapture).toHaveBeenCalledExactlyOnceWith(expected);
    for (const [key, location] of keys.slice(1)) await keyEvent(input, "keyUp", { key, location });
    expect(onCapture).toHaveBeenCalledOnce();
  });

  test("keeps modifier families pending when they become an ordinary key chord", async () => {
    const onCapture = vi.fn();
    const input = await renderCapture(onCapture);
    await keyEvent(input, "keyDown", { key: "Control", location: 1, ctrlKey: true });
    await keyEvent(input, "keyDown", { key: "Alt", location: 1, ctrlKey: true, altKey: true });
    await keyEvent(input, "keyDown", { key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    await keyEvent(input, "keyUp", { key: "Alt", location: 1, ctrlKey: true });
    expect(onCapture).toHaveBeenCalledExactlyOnceWith("Ctrl+Alt+K");
  });

  test.each(["Shift+Fn", "Ctrl+Command+Alt+Shift+Fn", "DoubleOption", "RightCommand"])(
    "accepts authoritative native %s without a DOM modifier racing it",
    async (hotkey) => {
      const native = pendingCapture();
      const onCapture = vi.fn();
      const input = await renderCapture(onCapture, true, () => native.promise);
      // Fn can be invisible to the DOM. Releasing Control must not capture LeftControl.
      await keyEvent(input, "keyDown", { key: "Control", location: 1, ctrlKey: true });
      await keyEvent(input, "keyUp", { key: "Control", location: 1 });
      expect(onCapture).not.toHaveBeenCalled();
      await act(async () => {
        native.resolve(hotkey);
        await native.promise;
      });
      expect(onCapture).toHaveBeenCalledExactlyOnceWith(hotkey);
    },
  );

  test.each([null, new Error("native unavailable")])(
    "falls back to DOM capture when native capture is unavailable (%s)",
    async (result) => {
      const onCapture = vi.fn();
      const input = await renderCapture(onCapture, true, () =>
        result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
      );
      await keyEvent(input, "keyDown", { key: "Control", location: 1 });
      await keyEvent(input, "keyDown", { key: "Alt", location: 2 });
      await keyEvent(input, "keyUp", { key: "Alt", location: 2 });
      expect(onCapture).toHaveBeenCalledExactlyOnceWith("Ctrl+Alt");
    },
  );

  test.each(["chord", "escape", "cancel", "blur", "unmount"])(
    "aborts native capture on %s and ignores its stale result",
    async (exit) => {
      const native = pendingCapture();
      let signal: AbortSignal | undefined;
      const onCapture = vi.fn();
      const input = await renderCapture(onCapture, true, (value) => {
        signal = value;
        return native.promise;
      });
      expect(signal?.aborted).toBe(false);
      await act(async () => {
        if (exit === "chord") fireEvent.keyDown(input, { key: "k", code: "KeyK", ctrlKey: true });
        if (exit === "escape") fireEvent.keyDown(input, { key: "Escape" });
        if (exit === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        if (exit === "blur") fireEvent.blur(input);
        if (exit === "unmount") cleanup();
        await Promise.resolve();
      });
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        native.resolve("Ctrl+Fn");
        await native.promise;
      });
      expect(onCapture.mock.calls).toEqual(exit === "chord" ? [["Ctrl+K"]] : []);
    },
  );
});

test.each(["macOS", "windows"] as const)(
  "suspends global shortcuts while recording an ordinary %s command",
  async (platform) => {
    const native = pendingCapture();
    const capture = vi.fn((_signal: AbortSignal, _allowsBareModifiers: boolean) => native.promise);
    const onCapture = vi.fn();
    const input = await renderCapture(onCapture, false, capture, platform);
    const signal = capture.mock.calls[0]![0];
    expect(capture).toHaveBeenCalledExactlyOnceWith(signal, false);
    await keyEvent(input, "keyDown", { key: "Control", location: 1, ctrlKey: true });
    await keyEvent(input, "keyUp", { key: "Control", location: 1 });
    expect(onCapture).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(false);
    await keyEvent(input, "keyDown", { key: "k", code: "KeyK", ctrlKey: true });
    expect(onCapture).toHaveBeenCalledExactlyOnceWith(
      platform === "macOS" ? "Ctrl+K" : "CmdOrCtrl+K",
    );
    expect(signal.aborted).toBe(true);
    await act(async () => {
      native.resolve("Fn");
      await native.promise;
    });
    expect(onCapture).toHaveBeenCalledOnce();
  },
);

test("does not commit an unexpected bare result for an ordinary command", async () => {
  const onCapture = vi.fn();
  await renderCapture(onCapture, false, async () => "Fn");
  expect(onCapture).not.toHaveBeenCalled();
});

test("enters a Windows capture session while keeping ordinary DOM chords authoritative", async () => {
  const native = pendingCapture();
  const capture = vi.fn((_signal: AbortSignal) => native.promise);
  const onCapture = vi.fn();
  const input = await renderCapture(onCapture, true, capture, "windows");
  expect(capture).toHaveBeenCalledOnce();
  await keyEvent(input, "keyDown", { key: "Control", location: 1, ctrlKey: true });
  await keyEvent(input, "keyDown", { key: "k", code: "KeyK", ctrlKey: true });
  expect(onCapture).toHaveBeenCalledExactlyOnceWith("CmdOrCtrl+K");
  expect(capture.mock.calls[0]![0].aborted).toBe(true);
  await act(async () => {
    native.resolve(null);
    await native.promise;
  });
});

test("rearms native capture if validation keeps the recorder open", async () => {
  const first = pendingCapture();
  const second = pendingCapture();
  const capture = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockResolvedValue(null);
  const onCapture = vi.fn();
  await renderCapture(onCapture, true, capture, "macOS", false);
  await act(async () => {
    first.resolve("Ctrl+Alt");
    await first.promise;
  });
  expect(capture).toHaveBeenCalledTimes(2);
  expect(capture.mock.calls[0]![0].aborted).toBe(true);
  await act(async () => {
    second.resolve("Shift+Fn");
    await second.promise;
  });
  expect(onCapture.mock.calls).toEqual([["Ctrl+Alt"], ["Shift+Fn"]]);
});
