import { describe, expect, test } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import { act } from "react";
import { NodexPopover, NodexPopoverTrigger } from "@/components/ui/popover";
import { render, settleAsyncRender } from "@/test/dom";
import { NfmEditorPopoverContent } from "./nfm-editor-popover-content";

describe("markdown editor popover content", () => {
  test("keeps editor selection focus stable while opening and closing", async () => {
    const focusProbe = document.createElement("button");
    focusProbe.type = "button";
    document.body.appendChild(focusProbe);
    focusProbe.focus();

    try {
      const view = render(
        <NodexPopover>
          <NodexPopoverTrigger>
            <button type="button">Open editor popover</button>
          </NodexPopoverTrigger>
          <NfmEditorPopoverContent>
            <input aria-label="Picker search" />
          </NfmEditorPopoverContent>
        </NodexPopover>,
      );

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Open editor popover" }));
        await settleAsyncRender();
      });

      const input = view.getByRole("textbox", { name: "Picker search" });
      expect(document.activeElement === input).toBe(false);

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Open editor popover" }));
        await settleAsyncRender();
      });

      expect(view.queryByRole("textbox", { name: "Picker search" }) === null).toBe(true);
    } finally {
      focusProbe.remove();
    }
  });
});
