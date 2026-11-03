import { describe, expect, test } from "vite-plus/test";
import { act } from "react";
import { render, settleAsyncRender } from "@/test/dom";
import { NfmFloatingPopover } from "./nfm-floating-popover";

function makeAnchorElement() {
  const anchor = document.createElement("button");
  anchor.type = "button";
  anchor.getBoundingClientRect = () => new DOMRect(100, 200, 20, 20);
  document.body.appendChild(anchor);
  return anchor;
}

describe("NfmFloatingPopover", () => {
  test("keeps popovers inline by default", async () => {
    const anchor = makeAnchorElement();

    try {
      const view = render(
        <NfmFloatingPopover
          reference={{ element: anchor }}
          useFloatingOptions={{ open: true, strategy: "fixed" }}
          focusManagerProps={{ disabled: true }}
          elementProps={{
            className: "inline-popover-test",
            style: { zIndex: 20 },
          }}
        >
          <div>Inline popover</div>
        </NfmFloatingPopover>,
      );

      await act(async () => {
        await settleAsyncRender();
      });

      const popover = view.container.querySelector<HTMLElement>(".inline-popover-test");
      expect(popover !== null).toBe(true);
      expect(popover?.style.zIndex).toBe("calc(var(--bn-ui-base-z-index, 0) + 20)");
    } finally {
      anchor.remove();
    }
  });

  test("portals to document.body when portalElement is null", async () => {
    const anchor = makeAnchorElement();

    try {
      const view = render(
        <NfmFloatingPopover
          reference={{ element: anchor }}
          portalElement={null}
          useFloatingOptions={{ open: true, strategy: "fixed" }}
          focusManagerProps={{ disabled: true }}
          elementProps={{
            className: "body-popover-test",
            style: { zIndex: 50 },
          }}
        >
          <div>Body popover</div>
        </NfmFloatingPopover>,
      );

      await act(async () => {
        await settleAsyncRender();
      });

      const popover = document.body.querySelector<HTMLElement>(".body-popover-test");
      expect(popover !== null).toBe(true);
      expect(popover ? document.body.contains(popover) : false).toBe(true);
      expect(popover ? view.container.contains(popover) : true).toBe(false);
      expect(popover?.style.zIndex).toBe("calc(var(--bn-ui-base-z-index, 0) + 50)");
    } finally {
      anchor.remove();
    }
  });
  test("keeps the latest committed content during its close transition", async () => {
    const anchor = makeAnchorElement();
    const content = (open: boolean, label: string | null) => (
      <NfmFloatingPopover
        reference={{ element: anchor }}
        useFloatingOptions={{ open: open, strategy: "fixed" }}
        useTransitionStylesProps={{ duration: { open: 0, close: 1_000 } }}
        useTransitionStatusProps={{ duration: { open: 0, close: 1_000 } }}
        focusManagerProps={{ disabled: true }}
      >
        {label ? <span>{label}</span> : null}
      </NfmFloatingPopover>
    );
    const view = render(content(true, "Original link"));
    try {
      await act(settleAsyncRender);
      await act(async () => {
        view.rerender(content(true, "Updated link"));
        await settleAsyncRender();
      });
      await act(async () => {
        view.rerender(content(false, null));
        await settleAsyncRender();
      });
      expect(view.getByText("Updated link")).toBeTruthy();
      expect(view.queryByText("Original link")).toBeNull();
    } finally {
      view.unmount();
      anchor.remove();
    }
  });
});
