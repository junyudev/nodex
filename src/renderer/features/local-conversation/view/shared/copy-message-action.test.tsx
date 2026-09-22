import { act, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { CopyMessageActionButton } from "./thread-message-actions";
import { writeMessageToClipboard } from "./message-clipboard";

vi.mock("./message-clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./message-clipboard")>()),
  writeMessageToClipboard: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(writeMessageToClipboard).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function copyAction() {
  return render(
    <NodexTooltipProvider>
      <CopyMessageActionButton text="hello" feedbackMs={1500} />
    </NodexTooltipProvider>,
  );
}

describe("CopyMessageActionButton", () => {
  test("preserves keyboard focus and ignores repeated clicks during feedback", async () => {
    vi.useFakeTimers();
    vi.mocked(writeMessageToClipboard).mockResolvedValue(true);
    const view = copyAction();
    const button = view.getByRole("button", { name: "Copy message" });
    await act(async () => {
      button.focus();
      fireEvent.click(button);
    });
    expect(view.getByRole("button", { name: "Copied" })).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(writeMessageToClipboard).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(view.getByRole("button", { name: "Copy message" })).toBe(button);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeMessageToClipboard).toHaveBeenCalledTimes(2);
  });

  test("deduplicates an in-flight copy and allows retry after failure", async () => {
    let resolveCopy: (value: boolean) => void = () => {};
    vi.mocked(writeMessageToClipboard).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const view = copyAction();
    const button = view.getByRole("button", { name: "Copy message" });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(writeMessageToClipboard).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveCopy(false);
    });
    expect(view.queryByRole("button", { name: "Copied" })).toBeNull();
    vi.mocked(writeMessageToClipboard).mockResolvedValueOnce(true);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(view.getByRole("button", { name: "Copied" })).toBe(button);
  });

  test("does not mark rejected clipboard writes as copied", async () => {
    vi.mocked(writeMessageToClipboard).mockRejectedValueOnce(new Error("Denied"));
    const view = copyAction();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy message" }));
    });
    expect(view.queryByRole("button", { name: "Copied" })).toBeNull();
  });

  test("does not schedule feedback after unmount while a copy is pending", async () => {
    let resolveCopy: (value: boolean) => void = () => {};
    vi.mocked(writeMessageToClipboard).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const view = copyAction();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy message" }));
    });
    view.unmount();
    const timer = vi.spyOn(window, "setTimeout");
    await act(async () => {
      resolveCopy(true);
    });
    expect(timer).not.toHaveBeenCalled();
  });

  test("copies rich content from the matching body when actions render in a separate row", async () => {
    vi.mocked(writeMessageToClipboard).mockResolvedValue(true);
    const view = render(
      <NodexTooltipProvider>
        <section data-message-copy-root="other">
          <div className="codex-markdown">
            <p>Other message</p>
          </div>
        </section>
        <section data-message-copy-root="target">
          <div className="codex-markdown">
            <p>
              <strong>Target</strong>
            </p>
          </div>
        </section>
        <section data-message-copy-source="target">
          <CopyMessageActionButton text="**Target**" responseIcon />
        </section>
      </NodexTooltipProvider>,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy message" }));
    });
    expect(writeMessageToClipboard).toHaveBeenCalledWith(
      "**Target**",
      "<p><strong>Target</strong></p>",
    );
  });
});
