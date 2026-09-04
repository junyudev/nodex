import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NfmCodeBlockActionBar } from "./nfm-code-block-action-bar";

describe("NfmCodeBlockActionBar", () => {
  test("offers searchable language, copy, and More actions", async () => {
    const onLanguageChange = vi.fn();
    const onCopy = vi.fn(async () => true);
    const onMore = vi.fn();
    render(
      <NfmCodeBlockActionBar
        languageId="typescript"
        mode="all"
        onLanguageChange={onLanguageChange}
        onCopy={onCopy}
        onMore={onMore}
      />,
    );

    expect(screen.getByRole("toolbar", { name: "Code block action bar" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open language dropdown" }));
    expect(screen.getAllByRole("option")).toHaveLength(88);

    fireEvent.change(screen.getByRole("combobox", { name: "Search code languages" }), {
      target: { value: "coq" },
    });
    const rocq = screen.getByRole("option", { name: "Rocq" });
    expect(rocq.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(rocq);
    expect(onLanguageChange).toHaveBeenCalledWith("rocq");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code to clipboard" }));
      await Promise.resolve();
    });
    expect(onCopy).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Open block actions menu" }));
    expect(onMore).toHaveBeenCalledOnce();
  });

  test("keeps plain Code actions reachable through More in a narrow block", () => {
    render(
      <NfmCodeBlockActionBar
        languageId="text"
        mode="more_only"
        onLanguageChange={vi.fn()}
        onCopy={vi.fn(async () => true)}
        onMore={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Open language dropdown" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy code to clipboard" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open block actions menu" })).not.toBeNull();
  });

  test("keeps Mermaid Display beside More in a narrow block", () => {
    render(
      <NfmCodeBlockActionBar
        languageId="mermaid"
        mode="more_only"
        onLanguageChange={vi.fn()}
        onCopy={vi.fn(async () => true)}
        onMore={vi.fn()}
        mermaid={{
          previewMode: "split",
          hasValidDiagram: true,
          onPreviewModeChange: vi.fn(),
          onExpand: vi.fn(),
          onDownload: vi.fn(),
        }}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Open language preview format dropdown" }),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open language dropdown" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy code to clipboard" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open block actions menu" })).not.toBeNull();
  });

  test("offers the complete Mermaid preview action set without changing the language catalog", () => {
    const onPreviewModeChange = vi.fn();
    const onExpand = vi.fn();
    const onDownload = vi.fn();
    render(
      <NfmCodeBlockActionBar
        languageId="mermaid"
        mode="all"
        onLanguageChange={vi.fn()}
        onCopy={vi.fn(async () => true)}
        onMore={vi.fn()}
        mermaid={{
          previewMode: "split",
          hasValidDiagram: true,
          onPreviewModeChange,
          onExpand,
          onDownload,
        }}
      />,
    );

    const displayTrigger = screen.getByRole("button", {
      name: "Open language preview format dropdown",
    });
    expect(displayTrigger.textContent).toBe("");
    fireEvent.click(displayTrigger);
    expect(screen.getAllByRole("radio").map((item) => item.getAttribute("aria-label"))).toEqual([
      "Show only code and hide preview",
      "Show only preview and hide code",
      "Show code and preview",
    ]);
    expect(
      screen.getByRole("radio", { name: "Show code and preview" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Show only preview and hide code" }));
    expect(onPreviewModeChange).toHaveBeenCalledWith("preview");
    expect(document.activeElement).toBe(displayTrigger);

    fireEvent.click(screen.getByRole("button", { name: "Expand diagram" }));
    fireEvent.click(screen.getByRole("button", { name: "Download diagram as JPEG" }));
    expect(onExpand).toHaveBeenCalledOnce();
    expect(onDownload).toHaveBeenCalledOnce();
  });
});
