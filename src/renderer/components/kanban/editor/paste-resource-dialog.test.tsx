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

describe("paste resource dialog", () => {
  test("renders link action only when the current paste supports it", async () => {
    const { PasteResourceDialog } = await import("./paste-resource-dialog");
    const withLinkMarkup = renderToStaticMarkup(
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
    const withoutLinkMarkup = renderToStaticMarkup(
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

    expect(withLinkMarkup.includes("Keep as Link")).toBeTrue();
    expect(withoutLinkMarkup.includes("Keep as Link")).toBeFalse();
    expect(withoutLinkMarkup.includes("Save a Copy")).toBeTrue();
  });

  test("renders user-friendly oversized-text actions without link mode", async () => {
    const { PasteResourceDialog } = await import("./paste-resource-dialog");
    const pastedText = `# Incident note

The worker queue backed up after a large sync finished at 09:14.
Please keep the markdown formatting when this is pasted inline.`;
    const markup = renderToStaticMarkup(
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

    expect(markup.includes("Paste Anyway")).toBeTrue();
    expect(markup.includes("Keep as Link")).toBeFalse();
    expect(markup.includes("Save a copy to assets and link to it, paste it anyway, or cancel.")).toBeTrue();
    expect(markup.includes("# Incident note")).toBeTrue();
    expect(markup.includes("145 characters")).toBeTrue();
    expect(markup.includes("4 lines")).toBeTrue();
  });

  test("hides save copy for folder paste and keeps link action", async () => {
    const { PasteResourceDialog } = await import("./paste-resource-dialog");
    const markup = renderToStaticMarkup(
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

    expect(markup.includes("Keep as Link")).toBeTrue();
    expect(markup.includes("Save a Copy")).toBeFalse();
    expect(markup.includes("Keep a link to the original folder, or cancel.")).toBeTrue();
  });
});
