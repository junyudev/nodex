import { describe, expect, mock, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
    const markup = renderToStaticMarkup(
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

    expect(markup.includes("Send this thread section?")).toBeTrue();
    expect(markup.includes("Parser audit")).toBeTrue();
    expect(markup.includes("Send to existing thread")).toBeTrue();
    expect(markup.includes("hello\nworld")).toBeTrue();
    expect(markup.includes("Do not ask again")).toBeTrue();
    expect(markup.includes("(revertible in Settings)")).toBeTrue();
  });

  test("shows the auto-create note when no section exists yet", async () => {
    const { ThreadSectionSendDialog } = await import("./thread-section-send-dialog");
    const markup = renderToStaticMarkup(
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

    expect(markup.includes("A new `threadSection` block will be inserted before the current block when you send.")).toBeTrue();
    expect(markup.includes("draft text")).toBeTrue();
  });
});
