import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { dispatchFocusedHistory } from "@/lib/focused-history";
import {
  handleDatabaseViewHistoryBeforeInput,
  type DatabaseViewMutationHistory,
} from "./database-view-mutation-history";

afterEach(() => {
  document.body.replaceChildren();
});

describe("Database View history input ownership", () => {
  test("native history belongs to the embedded View, not its outer contenteditable", async () => {
    const outer = document.createElement("div");
    outer.contentEditable = "true";
    const view = document.createElement("div");
    view.contentEditable = "false";
    const row = document.createElement("button");
    view.append(row);
    outer.append(view);
    document.body.append(outer);
    const request = vi.fn<DatabaseViewMutationHistory["request"]>(() => ({
      accepted: false,
      entryId: null,
      result: Promise.resolve({ status: "noop" }),
    }));
    const history = { request };
    const parent = vi.fn();
    outer.addEventListener("beforeinput", parent);
    view.addEventListener("beforeinput", (event) => {
      handleDatabaseViewHistoryBeforeInput({
        event,
        history,
      });
    });
    row.focus();
    dispatchFocusedHistory("undo");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("undo"));
    expect(parent).not.toHaveBeenCalled();
    // Empty still belongs to this View, including an unsupported native redo.
    dispatchFocusedHistory("redo");
    expect(request).toHaveBeenLastCalledWith("redo");
    expect(parent).not.toHaveBeenCalled();
  });

  test("a focused property input keeps its own history", () => {
    const view = document.createElement("div");
    const input = document.createElement("input");
    view.append(input);
    document.body.append(view);
    const request = vi.fn<DatabaseViewMutationHistory["request"]>();
    const history = { request };
    const blocked = vi.fn();
    view.addEventListener("beforeinput", (event) => {
      handleDatabaseViewHistoryBeforeInput({
        event,
        history,
        onBlocked: blocked,
      });
    });
    const event = new InputEvent("beforeinput", {
      inputType: "historyUndo",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(blocked).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
