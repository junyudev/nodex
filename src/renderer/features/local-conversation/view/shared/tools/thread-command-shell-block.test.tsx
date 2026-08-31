import { describe, expect, test } from "vite-plus/test";
import { render } from "@testing-library/react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { ThreadExecShellContainer } from "./thread-command-shell-block";

function renderPlainShell({
  output,
  isInProgress = false,
}: {
  output: string;
  isInProgress?: boolean;
}) {
  return render(
    <NodexTooltipProvider>
      <ThreadExecShellContainer
        command=""
        footer={<button type="button">Retry setup</button>}
        isInProgress={isInProgress}
        output={output}
        surface="plain"
      />
    </NodexTooltipProvider>,
  );
}

describe("ThreadExecShellContainer plain surface", () => {
  test("keeps the action footer outside the clipped shell body", () => {
    const view = renderPlainShell({ output: "Environment setup failed\n" });
    const footer = view.getByRole("button", { name: "Retry setup" });
    const outerShell = footer.parentElement;
    const clippedBody = footer.previousElementSibling;

    expect(outerShell?.lastElementChild).toBe(footer);
    expect(clippedBody?.contains(view.getByText("Environment setup failed"))).toBe(true);
    expect(clippedBody?.contains(footer)).toBe(false);
    expect(Boolean(view.getByRole("button", { name: "Copy output" }))).toBe(true);
  });

  test("renders ANSI output as safe text and omits the empty-output placeholder while streaming", () => {
    const completed = renderPlainShell({ output: "plain \u001b[31mred\u001b[0m\n" });
    expect(completed.container.textContent).toContain("plain red");
    expect(completed.container.textContent).not.toContain("\u001b");
    completed.unmount();

    const streaming = renderPlainShell({ output: "", isInProgress: true });
    expect(streaming.queryByText("No output")).toBe(null);
  });
});
