import { describe, expect, mock, test } from "bun:test";
import type { ComponentProps } from "react";
import { render, textContent } from "../../../test/dom";

mock.module("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
  DialogContent: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
  DialogDescription: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
  DialogFooter: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
  DialogHeader: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
  DialogTitle: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
}));

describe("thread section send dialog", () => {
  test("renders the plain-text preview and section metadata", async () => {
    const { ThreadSectionSendDialog } = await import("./thread-section-send-dialog");
    const { container, getByText } = render(
      <ThreadSectionSendDialog
        open
        state={{
          sectionTitle: "Parser audit",
          plainTextPreview: "hello\nworld",
          threadLabel: "Thread A",
          sendActionLabel: "Send to existing thread",
          autoCreateSection: false,
        }}
        onOpenChange={() => { }}
        onConfirm={() => { }}
      />,
    );

    expect(getByText("Send this thread section?").textContent).toBe("Send this thread section?");
    expect(getByText("Parser audit").textContent).toBe("Parser audit");
    expect(getByText("Send to existing thread").textContent).toBe("Send to existing thread");
    expect(textContent(container).includes("hello\nworld")).toBeTrue();
    expect(textContent(container).includes("Do not ask again")).toBeTrue();
    expect(textContent(container).includes("(revertible in Settings)")).toBeTrue();
  });

  test("shows the auto-create note when no section exists yet", async () => {
    const { ThreadSectionSendDialog } = await import("./thread-section-send-dialog");
    const { container } = render(
      <ThreadSectionSendDialog
        open
        state={{
          sectionTitle: "Untitled section",
          plainTextPreview: "draft text",
          threadLabel: "No existing thread",
          sendActionLabel: "Start a new thread",
          autoCreateSection: true,
        }}
        onOpenChange={() => { }}
        onConfirm={() => { }}
      />,
    );

    expect(textContent(container).includes("A new `threadSection` block will be inserted before the current block when you send.")).toBeTrue();
    expect(textContent(container).includes("draft text")).toBeTrue();
  });
});
