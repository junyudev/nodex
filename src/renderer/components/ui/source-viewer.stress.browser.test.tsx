import { waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { renderWithAppMaitai as render } from "@/test/app-maitai";
import "../../globals.css";
import { SourceViewer } from "./source-viewer";

vi.mock("@/lib/use-theme", () => ({
  useTheme: () => ({ resolved: "dark" }),
}));

describe("SourceViewer browser behavior", () => {
  test("keeps a 1.5 MB exact source viewport-sized and selectable", async () => {
    const source = "export const fixture = true;\n".repeat(55_556).slice(0, 1_500_000);
    const view = render(
      <div style={{ height: 640, width: 960 }}>
        <SourceViewer
          value={source}
          ariaLabel="Large exact source"
          filename="fixture.ts"
          lineNumbers
          className="h-full"
        />
      </div>,
    );

    const region = view.getByRole("region", { name: "Large exact source" });
    const file = region.querySelector("diffs-container");
    expect(file).not.toBeNull();

    await waitFor(
      () => {
        expect(file?.shadowRoot?.querySelector("[data-code]")).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    expect(region.getElementsByTagName("*").length).toBeLessThan(2_000);
    expect(file?.shadowRoot?.textContent.length ?? 0).toBeLessThan(20_000);
  });
});
