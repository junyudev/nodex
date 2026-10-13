import { useState } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { InlineVisualizationColorControl } from "./inline-visualization-color-control";

function ColorField({ changed }: { readonly changed: (value: string) => void }) {
  const [value, setValue] = useState("#11223344");
  return (
    <>
      <InlineVisualizationColorControl
        label="Tint"
        value={value}
        disabled={false}
        change={(next) => {
          setValue(next);
          changed(next);
        }}
      />
      <button type="button" onClick={() => setValue("#11223344")}>
        Reset color
      </button>
      <button type="button" onClick={() => setValue("#aabbccdd")}>
        Other color
      </button>
    </>
  );
}

test("inline color edits accept alpha, discard invalid drafts and never resurrect them after external resets", async () => {
  const changed = vi.fn();
  const view = render(<ColorField changed={changed} />);
  const input = view.getByRole("textbox", { name: "Tint" });
  await act(async () => {
    fireEvent.change(input, { target: { value: "#abcd" } });
  });
  expect(changed).toHaveBeenLastCalledWith("#abcd");
  await act(async () => {
    fireEvent.change(input, { target: { value: "#oops" } });
  });
  expect((input as HTMLInputElement).value).toBe("#oops");
  expect(changed).toHaveBeenCalledOnce();
  await act(async () => {
    fireEvent.blur(input);
  });
  expect((input as HTMLInputElement).value).toBe("#abcd");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Reset color" }));
  });
  await act(async () => {
    fireEvent.change(input, { target: { value: "invalid" } });
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Other color" }));
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Reset color" }));
  });
  expect((input as HTMLInputElement).value).toBe("#11223344");
});

test("the compact popup commits opaque HEX on blur or Enter and rejects alpha and invalid drafts", async () => {
  const changed = vi.fn();
  const view = render(<ColorField changed={changed} />);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Choose tint" }));
  });
  const hex = await view.findByRole("textbox", { name: "Tint HEX" });
  expect((hex as HTMLInputElement).value).toBe("#112233");
  await act(async () => {
    fireEvent.change(hex, { target: { value: " abc " } });
  });
  expect(changed).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.blur(hex);
  });
  expect(changed).toHaveBeenLastCalledWith("#AABBCC");
  expect((hex as HTMLInputElement).value).toBe("#AABBCC");
  await act(async () => {
    fireEvent.change(hex, { target: { value: "#44556677" } });
    fireEvent.blur(hex);
  });
  expect(changed).toHaveBeenCalledOnce();
  expect((hex as HTMLInputElement).value).toBe("#AABBCC");
  await act(async () => {
    hex.focus();
    fireEvent.change(hex, { target: { value: "789" } });
  });
  await act(async () => {
    fireEvent.keyDown(hex, { key: "Enter" });
  });
  expect(changed).toHaveBeenLastCalledWith("#778899");
});

test("closing a screen-color request aborts its capability and rejects a late reply", async () => {
  let signal: AbortSignal | undefined;
  let reply!: (value: { sRGBHex: string }) => void;
  const descriptor = Object.getOwnPropertyDescriptor(window, "EyeDropper");
  Object.defineProperty(window, "EyeDropper", {
    configurable: true,
    value: class {
      open(input: { signal: AbortSignal }) {
        signal = input.signal;
        return new Promise<{ sRGBHex: string }>((resolve) => {
          reply = resolve;
        });
      }
    },
  });
  const changed = vi.fn();
  const view = render(<ColorField changed={changed} />);
  try {
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Choose tint" }));
    });
    await act(async () => {
      fireEvent.click(await view.findByRole("button", { name: "Pick color from screen" }));
    });
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      reply({ sRGBHex: "#ABCDEF" });
      await Promise.resolve();
    });
    expect(changed).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    if (descriptor) Object.defineProperty(window, "EyeDropper", descriptor);
    else Reflect.deleteProperty(window, "EyeDropper");
  }
});
