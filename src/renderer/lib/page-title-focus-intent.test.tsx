import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import {
  consumePageTitleFocus,
  hasPendingPageTitleFocus,
  requestPageTitleFocus,
  useConsumePageTitleFocus,
} from "./page-title-focus-intent";

function TitleFocusProbe({
  pageId,
  ready = true,
}: {
  readonly pageId: string;
  readonly ready?: boolean;
}) {
  const focusTitle = useConsumePageTitleFocus(pageId, ready);
  return <div data-focus-title={String(focusTitle)} />;
}

describe("useConsumePageTitleFocus", () => {
  test("preserves the focus intent across StrictMode double-renders and remounts before ready, then consumes it once ready", () => {
    const pageId = "page-strict-mode-test";
    requestPageTitleFocus(pageId);

    const first = render(
      <StrictMode>
        <TitleFocusProbe pageId={pageId} ready={false} />
      </StrictMode>,
    );
    expect(
      first.container.querySelector("[data-focus-title]")?.getAttribute("data-focus-title"),
    ).toBe("true");
    expect(hasPendingPageTitleFocus(pageId)).toBe(true);
    first.unmount();

    const second = render(
      <StrictMode>
        <TitleFocusProbe pageId={pageId} ready />
      </StrictMode>,
    );
    expect(
      second.container.querySelector("[data-focus-title]")?.getAttribute("data-focus-title"),
    ).toBe("true");
    expect(hasPendingPageTitleFocus(pageId)).toBe(false);
    second.unmount();

    const reopen = render(<TitleFocusProbe pageId={pageId} ready />);
    expect(
      reopen.container.querySelector("[data-focus-title]")?.getAttribute("data-focus-title"),
    ).toBe("false");
    reopen.unmount();
    consumePageTitleFocus(pageId);
  });
});
