import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { StrictMode } from "react";
import { CodeBlockCopyButton } from "./code-block-copy-button";

const content = "alpha\n\n\n\nbeta\u2028gamma\u2029delta";

function withClipboard(writeText: (text: string) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return () => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  };
}

function copyButton(text = content, disabled = false) {
  return (
    <StrictMode>
      <CodeBlockCopyButton text={text} disabled={disabled} />
    </StrictMode>
  );
}

async function click(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
}

describe("the public authored-code Copy control", () => {
  test("has one writer per attempt, feedback and cooldown, and a fresh source after a document changes", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    const restore = withClipboard(writeText);
    const view = render(copyButton());
    try {
      const button = view.getByRole("button", { name: "Copy code to clipboard" });
      await click(button);
      await waitFor(() => expect(view.getByRole("button", { name: "Copied code" })).toBe(button));
      await click(button);
      expect(writeText).toHaveBeenCalledExactlyOnceWith(content);
      view.rerender(copyButton("new source"));
      await waitFor(() =>
        expect(view.getByRole("button", { name: "Copy code to clipboard" })).toBe(button),
      );
      view.rerender(copyButton());
      await click(button);
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
      expect(writeText).toHaveBeenLastCalledWith(content);
    } finally {
      view.unmount();
      restore();
    }
  });

  test("a denied navigator write falls back once and reports success without a second handler", async () => {
    const writeText = vi.fn(async (_text: string) => {
      throw new Error("permission denied");
    });
    const restore = withClipboard(writeText);
    const original = Object.getOwnPropertyDescriptor(document, "execCommand");
    let accepted = "";
    const execCommand = vi.fn((command: string) => {
      if (command !== "copy") return false;
      accepted = document.querySelector("textarea")?.value ?? "";
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const view = render(copyButton());
    try {
      const button = view.getByRole("button", { name: "Copy code to clipboard" });
      await act(async () => {
        button.focus();
      });
      await click(button);
      await waitFor(() => expect(view.getByRole("button", { name: "Copied code" })).toBe(button));
      expect(writeText).toHaveBeenCalledExactlyOnceWith(content);
      expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
      expect(accepted).toBe(content);
      expect(document.activeElement).toBe(button);
      expect(document.querySelector("textarea")).toBeNull();
    } finally {
      view.unmount();
      restore();
      if (original) Object.defineProperty(document, "execCommand", original);
      else Reflect.deleteProperty(document, "execCommand");
    }
  });

  test("incomplete code cannot copy, and a failed attempt can retry", async () => {
    const writeText = vi.fn(async (_text: string): Promise<void> => {
      throw new Error("denied");
    });
    const restore = withClipboard(writeText);
    const original = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
    const view = render(copyButton(content, true));
    try {
      const button = view.getByRole("button", { name: "Copy code to clipboard" });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      await click(button);
      expect(writeText).not.toHaveBeenCalled();
      view.rerender(copyButton());
      await click(button);
      expect(view.queryByRole("button", { name: "Copied code" })).toBeNull();
      writeText.mockImplementation(async () => {});
      await click(button);
      await waitFor(() => expect(view.getByRole("button", { name: "Copied code" })).toBe(button));
      expect(writeText).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      restore();
      if (original) Object.defineProperty(document, "execCommand", original);
      else Reflect.deleteProperty(document, "execCommand");
    }
  });

  test("a pending old source or retired control cannot publish feedback on its replacement", async () => {
    let accept: (() => void) | undefined;
    const writeText = vi.fn(
      (_text: string) =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const restore = withClipboard(writeText);
    const view = render(copyButton());
    try {
      const button = view.getByRole("button", { name: "Copy code to clipboard" });
      await click(button);
      await click(button);
      expect(writeText).toHaveBeenCalledExactlyOnceWith(content);
      view.rerender(copyButton("replacement"));
      await act(async () => {
        accept?.();
        await Promise.resolve();
      });
      expect(view.queryByRole("button", { name: "Copied code" })).toBeNull();
      writeText.mockImplementation(async () => {});
      await click(button);
      await waitFor(() => expect(view.getByRole("button", { name: "Copied code" })).toBe(button));
      expect(writeText).toHaveBeenLastCalledWith("replacement");
      view.unmount();
    } finally {
      view.unmount();
      restore();
    }
  });
});
