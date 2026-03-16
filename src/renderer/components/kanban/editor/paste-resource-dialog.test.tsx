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

describe("paste resource dialog", () => {
  test("renders link action only when the current paste supports it", async () => {
    const { PasteResourceDialog } = await import("./paste-resource-dialog");
    const withLinkRender = render(
      <PasteResourceDialog
        open
        state={{
          target: {
            selectedBlockIds: [],
            currentBlockId: "block-1",
            canInsertInline: true,
            replaceCurrentEmptyParagraph: true,
          },
          items: [{ kind: "file", name: "report.txt", path: "/tmp/report.txt" }],
          allowLink: true,
        }}
        onOpenChange={() => { }}
        onChooseMode={() => { }}
        onContinueInline={() => { }}
      />,
    );
    const withoutLinkRender = render(
      <PasteResourceDialog
        open
        state={{
          target: {
            selectedBlockIds: [],
            currentBlockId: "block-1",
            canInsertInline: true,
            replaceCurrentEmptyParagraph: true,
          },
          items: [{ kind: "file", name: "report.txt", mimeType: "text/plain" }],
          allowLink: false,
        }}
        onOpenChange={() => { }}
        onChooseMode={() => { }}
        onContinueInline={() => { }}
      />,
    );

    expect(textContent(withLinkRender.container).includes("Keep as Link")).toBeTrue();
    expect(textContent(withoutLinkRender.container).includes("Keep as Link")).toBeFalse();
    expect(textContent(withoutLinkRender.container).includes("Save a Copy")).toBeTrue();
  });

  test("renders user-friendly oversized-text actions without link mode", async () => {
    const { PasteResourceDialog } = await import("./paste-resource-dialog");
    const pastedText = `# Incident note

The worker queue backed up after a large sync finished at 09:14.
Please keep the markdown formatting when this is pasted inline.`;
    const { container } = render(
      <PasteResourceDialog
        open
        state={{
          target: {
            selectedBlockIds: [],
            currentBlockId: "block-1",
            canInsertInline: true,
            replaceCurrentEmptyParagraph: true,
          },
          items: [{ kind: "text", name: "Pasted text" }],
          textPayload: pastedText,
          allowLink: false,
        }}
        onOpenChange={() => { }}
        onChooseMode={() => { }}
        onContinueInline={() => { }}
      />,
    );

    expect(textContent(container).includes("Paste Anyway")).toBeTrue();
    expect(textContent(container).includes("Keep as Link")).toBeFalse();
    expect(textContent(container).includes("Save a copy to assets and link to it, paste it anyway, or cancel.")).toBeTrue();
    expect(textContent(container).includes("# Incident note")).toBeTrue();
    expect(textContent(container).includes("145 characters")).toBeTrue();
    expect(textContent(container).includes("4 lines")).toBeTrue();
  });

  test("hides save copy for folder paste and keeps link action", async () => {
    const { PasteResourceDialog } = await import("./paste-resource-dialog");
    const { container } = render(
      <PasteResourceDialog
        open
        state={{
          target: {
            selectedBlockIds: [],
            currentBlockId: "block-1",
            canInsertInline: true,
            replaceCurrentEmptyParagraph: true,
          },
          items: [{ kind: "folder", name: "Designs", path: "/tmp/Designs" }],
          allowLink: true,
        }}
        onOpenChange={() => { }}
        onChooseMode={() => { }}
      />,
    );

    expect(textContent(container).includes("Keep as Link")).toBeTrue();
    expect(textContent(container).includes("Save a Copy")).toBeFalse();
    expect(textContent(container).includes("Keep a link to the original folder, or cancel.")).toBeTrue();
  });
});
