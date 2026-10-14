import { describe, expect, test, vi } from "vite-plus/test";
import { waitFor } from "@testing-library/react";
import { renderWithAppMaitai as render } from "@/test/app-maitai";

vi.mock("@/lib/use-theme", () => ({
  useTheme: () => ({ resolved: "dark" }),
}));

describe("page stage raw content", () => {
  test("renders exact raw content in a read-only chrome", async () => {
    const { PageStageRawContent } = await import("./raw-content");
    const { container, getByText } = render(
      <PageStageRawContent
        content={`# Heading\n\n- item 1\n- item 2\n<image source="nodex://assets/demo.png" />`}
      />,
    );

    expect(getByText("Raw format").textContent).toBe("Raw format");
    expect(getByText("Read-only").textContent).toBe("Read-only");
    await waitFor(() => {
      const source = container.querySelector("diffs-container");
      expect(
        source?.shadowRoot?.textContent.includes('<image source="nodex://assets/demo.png" />'),
      ).toBe(true);
    });
  });

  test("renders an empty-state hint when the description is blank", async () => {
    const { PageStageRawContent } = await import("./raw-content");
    const { getByText } = render(<PageStageRawContent content="" />);

    expect(getByText("Description is empty.").textContent).toBe("Description is empty.");
  });
});
