import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { fireEvent, waitFor } from "@testing-library/react";
import { render } from "@/test/dom";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { CodeBlockReadOnlyHeader } from "./code-block-readonly-header";

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("CodeBlockReadOnlyHeader", () => {
  test("uses the shared language label and copies only plain code", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const view = render(
      <NodexTooltipProvider>
        <CodeBlockReadOnlyHeader language="coq" code="Check nat." />
      </NodexTooltipProvider>,
    );

    expect(view.getByText("Rocq")).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Copy code to clipboard" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Check nat."));
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
