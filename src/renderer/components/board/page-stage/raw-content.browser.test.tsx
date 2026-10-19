import { describe, expect, test, vi } from "vite-plus/test";
import { waitFor } from "@testing-library/react";
import { renderWithAppMaitai as render } from "@/test/app-maitai";
import { settleLazyRender } from "@/test/dom";
import "@/globals.css";

vi.mock("@/lib/use-theme", () => ({
  useTheme: () => ({ resolved: "dark" }),
}));

describe("page stage raw content", () => {
  test("renders exact raw content in a read-only chrome", async () => {
    const { PageStageRawContent } = await import("./raw-content");
    const content = '# Heading\n\n- item 1\n- item 2\n<image source="nodex://assets/demo.png" />';
    const view = render(<PageStageRawContent content={content} />);

    await settleLazyRender();
    expect(view.getByText("Read-only")).not.toBeNull();
    const source = await view.findByRole("region", { name: "Raw page source" });
    await waitFor(() => {
      const root = source.querySelector("diffs-container")?.shadowRoot;
      const lines = Array.from(root?.querySelectorAll("[data-line]") ?? []);
      expect(lines.map((line) => line.textContent).join("\n")).toBe(content);
      expect(root?.querySelector('textarea, input, [contenteditable="true"]')).toBeNull();
    });
  });

  test("renders an empty-state hint when the description is blank", async () => {
    const { PageStageRawContent } = await import("./raw-content");
    const view = render(<PageStageRawContent content="" />);

    expect(view.getByText("Description is empty.")).not.toBeNull();
  });
});
