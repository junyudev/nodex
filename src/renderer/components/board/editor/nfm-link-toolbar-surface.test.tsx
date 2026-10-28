import { describe, expect, test, vi } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import { act, useState } from "react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { render, settleAsyncRender } from "@/test/dom";
import {
  NfmCompactLinkToolbar,
  NfmCreateLinkDialogSurface,
  NfmLinkEditToolbarSurface,
} from "./nfm-link-toolbar-surface";

function renderToolbar(props?: Partial<Parameters<typeof NfmCompactLinkToolbar>[0]>) {
  return render(
    <NodexTooltipProvider>
      <NfmCompactLinkToolbar
        href="https://community.openai.com/t/example"
        canOpen={true}
        openTooltip="Open in new tab"
        openLabel="Open"
        clearTooltip="Clear"
        clearLabel="Clear"
        copyLabel="Copy"
        copyTooltip="Copy link"
        copiedLabel="Copied"
        copiedTooltip="Copied"
        editTooltip="Edit"
        editLabel="Edit"
        onOpenLink={() => {}}
        onClearLink={() => {}}
        onCopyLink={() => {}}
        onEditLink={() => {}}
        {...props}
      />
    </NodexTooltipProvider>,
  );
}

describe("markdown compact link toolbar", () => {
  test("opens the link through the Open action when actionable", async () => {
    let openCount = 0;

    const view = renderToolbar({
      onOpenLink: () => {
        openCount += 1;
      },
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Open" }));
      await settleAsyncRender();
    });

    expect(openCount).toBe(1);
  });

  test("does not open blocked links and surfaces the disabled reason", async () => {
    const disabledReason = "Cannot resolve relative file link without project workspace.";
    let openCount = 0;

    const view = renderToolbar({
      canOpen: false,
      openTooltip: disabledReason,
      disabledReason,
      onOpenLink: () => {
        openCount += 1;
      },
    });

    const button = view.getByRole("button", { name: "Open" });

    await act(async () => {
      fireEvent.focus(button.parentElement ?? button);
      fireEvent.click(button);
      await settleAsyncRender();
    });

    expect(openCount).toBe(0);
    expect(button.hasAttribute("title")).toBe(false);
    expect(view.getByRole("tooltip").textContent).toContain(disabledReason);
  });

  test("copies the exact stored href through the copy action callback", async () => {
    let copiedHref = "";

    const view = renderToolbar({
      href: "folder/abc/file",
      onCopyLink: () => {
        copiedHref = "folder/abc/file";
      },
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy" }));
      await settleAsyncRender();
    });

    expect(copiedHref).toBe("folder/abc/file");
  });

  test("shows the copied state in the copy action", () => {
    const view = renderToolbar({
      copyState: "copied",
    });

    const copyButton = view.getByRole("button", { name: "Copied" });
    expect(copyButton.getAttribute("aria-label")).toBe("Copied");
  });

  test("preserves the toolbar through pointerdown so copy click can still fire", async () => {
    let copied = 0;

    function ToolbarHarness() {
      const [open, setOpen] = useState(true);

      if (!open) return <div>Closed</div>;

      return (
        <div
          onPointerDown={(event) => {
            if (!event.defaultPrevented) setOpen(false);
          }}
        >
          <NodexTooltipProvider>
            <NfmCompactLinkToolbar
              href="https://community.openai.com/t/example"
              canOpen={true}
              openTooltip="Open in new tab"
              openLabel="Open"
              clearTooltip="Clear"
              clearLabel="Clear"
              copyLabel="Copy"
              copyTooltip="Copy link"
              copiedLabel="Copied"
              copiedTooltip="Copied"
              editTooltip="Edit"
              editLabel="Edit"
              onOpenLink={() => {}}
              onClearLink={() => {}}
              onCopyLink={() => {
                copied += 1;
              }}
              onEditLink={() => {}}
            />
          </NodexTooltipProvider>
        </div>
      );
    }

    const view = render(<ToolbarHarness />);
    const copyButton = view.getByRole("button", { name: "Copy" });

    await act(async () => {
      fireEvent.pointerDown(copyButton);
      fireEvent.click(copyButton);
      await settleAsyncRender();
    });

    expect(copied).toBe(1);
    expect(view.container.textContent?.includes("Closed") ?? false).toBe(false);
  });

  test("replaces the toolbar with the URL-only edit toolbar when edit is clicked", async () => {
    function ToolbarHarness() {
      const [editing, setEditing] = useState(false);
      const [url, setUrl] = useState("https://community.openai.com/t/example");

      const handleFieldKeyDown = () => {};

      return (
        <NodexTooltipProvider>
          {editing ? (
            <NfmLinkEditToolbarSurface
              urlPlaceholder="Type or paste a link"
              urlValue={url}
              onUrlChange={setUrl}
              onUrlKeyDown={handleFieldKeyDown}
              onApply={() => setEditing(false)}
            />
          ) : (
            <NfmCompactLinkToolbar
              href={url}
              canOpen={true}
              openTooltip="Open in new tab"
              openLabel="Open"
              clearTooltip="Clear"
              clearLabel="Clear"
              copyLabel="Copy"
              copyTooltip="Copy link"
              copiedLabel="Copied"
              copiedTooltip="Copied"
              editTooltip="Edit"
              editLabel="Edit"
              onOpenLink={() => {}}
              onClearLink={() => {}}
              onCopyLink={() => {}}
              onEditLink={() => {
                setEditing(true);
              }}
            />
          )}
        </NodexTooltipProvider>
      );
    }

    const view = render(<ToolbarHarness />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit" }));
      await settleAsyncRender();
    });

    expect(view.queryByTestId("nfm-compact-link-toolbar") === null).toBe(true);
    expect(view.getByTestId("nfm-link-edit-toolbar").getAttribute("role")).toBe("toolbar");
    expect(Boolean(view.getByRole("textbox", { name: "Type or paste a link" }))).toBe(true);
    expect(view.queryByRole("textbox", { name: "Link title" }) === null).toBe(true);
  });

  test("clears the link through the compact Clear action", async () => {
    let clearCount = 0;
    const view = renderToolbar({
      onClearLink: () => {
        clearCount += 1;
      },
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Clear" }));
      await settleAsyncRender();
    });

    expect(clearCount).toBe(1);
  });
});

describe("markdown link edit toolbar surface", () => {
  test("renders only the URL field and applies the edited link", async () => {
    let applied = 0;
    const view = render(
      <NfmLinkEditToolbarSurface
        urlPlaceholder="Type or paste a link"
        urlValue="https://community.openai.com/t/example"
        onUrlChange={() => {}}
        onUrlKeyDown={() => {}}
        onApply={() => {
          applied += 1;
        }}
      />,
    );

    expect(Boolean(view.getByRole("textbox", { name: "Type or paste a link" }))).toBe(true);
    expect(view.queryByRole("textbox", { name: "Link title" }) === null).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Apply link" }));
      await settleAsyncRender();
    });

    expect(applied).toBe(1);
  });

  test("renders the compact create-link dialog and invokes submit", async () => {
    let submitted = 0;

    const view = render(
      <NfmCreateLinkDialogSurface
        urlLabel="Page or URL"
        urlPlaceholder="Paste or type a link"
        urlValue="https://community.openai.com/t/example"
        submitLabel="Add link"
        onUrlChange={() => {}}
        onUrlKeyDown={() => {}}
        onSubmit={() => {
          submitted += 1;
        }}
      />,
    );

    expect(Boolean(view.getByLabelText("Page or URL"))).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Add link" }));
      await settleAsyncRender();
    });

    expect(submitted).toBe(1);
  });

  test("opens the Page picker through the explicit secondary action", async () => {
    const openPagePicker = vi.fn();
    const view = render(
      <NfmCreateLinkDialogSurface
        urlLabel="Page or URL"
        urlPlaceholder="Paste or type a link"
        urlValue=""
        submitLabel="Add link"
        secondaryActionLabel="Page…"
        onUrlChange={() => undefined}
        onUrlKeyDown={() => undefined}
        onSubmit={() => undefined}
        onSecondaryAction={openPagePicker}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Page…" }));
      await settleAsyncRender();
    });
    expect(openPagePicker).toHaveBeenCalledOnce();
  });
});
