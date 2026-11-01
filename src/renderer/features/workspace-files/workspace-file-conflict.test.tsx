import { fireEvent, render } from "@testing-library/react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, test, vi } from "vite-plus/test";
import { WorkspaceFileConflict } from "./workspace-file-conflict";
import { WORKSPACE_FILE_COMPARISON_MAX_CHARACTERS } from "./workspace-file-editor-diff";

vi.mock("@/lib/use-theme", () => ({ useTheme: () => ({ resolved: "light" }) }));
vi.mock("@/components/ui/read-only-file-diff", () => ({
  ReadOnlyFileDiff: ({ fileDiff }: { fileDiff: FileDiffMetadata }) => (
    <div data-testid="conflict-diff">{fileDiff.additionLines.join("")}</div>
  ),
}));

function renderConflict(diskValue: string, localValue: string) {
  const onUseDisk = vi.fn();
  const onKeepLocal = vi.fn();
  const view = render(
    <WorkspaceFileConflict
      filename="page.html"
      diskValue={diskValue}
      localValue={localValue}
      onUseDisk={onUseDisk}
      onKeepLocal={onKeepLocal}
    />,
  );
  return { view, onUseDisk, onKeepLocal };
}

describe("external change conflict", () => {
  test("compares the disk version with local changes", () => {
    const { view } = renderConflict("<p>disk</p>\n", "<p>local</p>\n");

    expect(view.getByTestId("conflict-diff").textContent).toBe("<p>local</p>\n");
    expect(view.queryByText("This comparison is too large to show")).toBeNull();
  });

  test("keeps the choice without diffing versions past the comparison limit", () => {
    const disk = "x".repeat(WORKSPACE_FILE_COMPARISON_MAX_CHARACTERS + 1);
    const { view, onUseDisk, onKeepLocal } = renderConflict(disk, "local\n");

    expect(view.queryByTestId("conflict-diff")).toBeNull();
    expect(view.getByText("This comparison is too large to show")).toBeInstanceOf(HTMLElement);
    expect(view.getByText("Choose the version to keep.")).toBeInstanceOf(HTMLElement);
    fireEvent.click(view.getByRole("button", { name: "Keep my changes" }));
    fireEvent.click(view.getByRole("button", { name: "Use disk version" }));
    expect(onKeepLocal).toHaveBeenCalledTimes(1);
    expect(onUseDisk).toHaveBeenCalledTimes(1);
  });
});
