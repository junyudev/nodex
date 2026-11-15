import { fireEvent, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import type { BrowserPageDialog } from "../../../shared/browser/browser-page-dialogs";
import { BrowserPageDialogCard } from "./browser-page-dialog";

function dialog(overrides: Partial<BrowserPageDialog> = {}): BrowserPageDialog {
  return {
    id: "dialog-1",
    kind: "confirm",
    origin: "https://shop.example.com",
    message: "Remove this item?",
    canSuppress: false,
    ...overrides,
  };
}

function renderDialog(value: BrowserPageDialog) {
  const onRespond = vi.fn(async () => true);
  render(
    <div>
      <input aria-label="Chat" />
      <BrowserPageDialogCard dialog={value} onRespond={onRespond} />
    </div>,
  );
  return onRespond;
}

describe("Browser page dialog", () => {
  test("names the frame that asked and the page it is embedded in", () => {
    renderDialog(dialog({ embeddingOrigin: "https://news.example.org" }));
    const card = screen.getByRole("alertdialog", { name: "shop.example.com says" });
    expect(card.textContent).toContain("Embedded in news.example.org");
    expect(card.textContent).toContain("Remove this item?");
  });

  test("submitting confirms and Escape cancels a confirm", async () => {
    const confirmed = renderDialog(dialog());
    const card = screen.getByRole("alertdialog");
    // Enter on the focused default button submits the form.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "OK" }));
    await act(async () => {
      fireEvent.submit(card);
      await Promise.resolve();
    });
    expect(confirmed).toHaveBeenCalledWith(dialog(), { accept: true, suppress: false });

    const cancelled = renderDialog(dialog({ id: "dialog-2" }));
    await act(async () => {
      fireEvent.keyDown(screen.getAllByRole("alertdialog")[1]!, { key: "Escape" });
      await Promise.resolve();
    });
    expect(cancelled).toHaveBeenCalledWith(dialog({ id: "dialog-2" }), {
      accept: false,
      suppress: false,
    });
  });

  test("an alert offers only OK, and a repeated dialog can be stopped", async () => {
    const onRespond = renderDialog(dialog({ kind: "alert", canSuppress: true }));
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Don’t let this page open more dialogs" }),
    );
    await act(async () => {
      fireEvent.submit(screen.getByRole("alertdialog"));
      await Promise.resolve();
    });
    expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ kind: "alert" }), {
      accept: true,
      suppress: true,
    });
  });

  test("leaves the keyboard with work elsewhere in the app", () => {
    const onRespond = vi.fn(async () => true);
    const view = render(<input aria-label="Chat" />);
    const chat = screen.getByRole("textbox", { name: "Chat" });
    chat.focus();
    view.rerender(
      <>
        <input aria-label="Chat" />
        <BrowserPageDialogCard dialog={dialog()} onRespond={onRespond} />
      </>,
    );
    expect(document.activeElement).toBe(chat);
  });
});
