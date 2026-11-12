import { act, useState } from "react";
import { render, waitFor, type RenderResult } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { useNfmPromptSendAnchor } from "./nfm-prompt-send-anchor";

/** A bare text column: the anchor is measured from real line boxes, so only layout can prove it. */
function AnchorHost({ width, text }: { width: number; text: string }) {
  const [column, setColumn] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const anchor = useNfmPromptSendAnchor(column, content);
  return (
    <div ref={setColumn} className="relative" style={{ width, font: "16px/24px sans-serif" }}>
      <div ref={setContent}>{text}</div>
      <output
        data-testid="anchor"
        data-placement={anchor.placement}
        data-left={anchor.left}
        data-top={anchor.top}
      />
    </div>
  );
}

const OVERLONG_WORD = "Pneumonoultramicroscopicsilicovolcanoconiosis";

const mounted: RenderResult[] = [];

afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
});

function mountHost(width: number, text: string) {
  const view = render(<AnchorHost width={width} text={text} />);
  mounted.push(view);
  return view;
}

function readAnchor(view: RenderResult) {
  const output = view.getByTestId("anchor");
  return {
    placement: output.dataset.placement,
    left: Number(output.dataset.left),
    top: Number(output.dataset.top),
  };
}

describe("Prompt send anchor measurement", () => {
  test("follows a short line, leaving room for the button after its text", async () => {
    const view = mountHost(400, "Short prompt");
    await waitFor(() => expect(readAnchor(view).placement).toBe("inline"));
    const { left } = readAnchor(view);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(400 - 24);
  });

  test("takes a row beneath a last line that fills the column", async () => {
    // One unbreakable word runs past the column, so its last line has no room left for the button.
    const view = mountHost(120, OVERLONG_WORD);
    await waitFor(() => expect(readAnchor(view).placement).toBe("below"));
    expect(readAnchor(view).left).toBe(0);
  });

  test("moves back beside the text when the text shortens", async () => {
    const view = mountHost(120, OVERLONG_WORD);
    await waitFor(() => expect(readAnchor(view).placement).toBe("below"));
    await act(async () => {
      view.rerender(<AnchorHost width={120} text="Short" />);
      await Promise.resolve();
    });
    await waitFor(() => expect(readAnchor(view).placement).toBe("inline"));
  });
});
