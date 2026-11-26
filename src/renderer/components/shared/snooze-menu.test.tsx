import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { NodexModalHost } from "@/lib/modal-registry";
import { renderWithMaitai } from "../../test/thread-maitai";

import { SnoozeMenu } from "./snooze-menu";

// Wednesday, Nov 25 2026, 2:15 PM local time.
const NOW = new Date(2026, 10, 25, 14, 15);

function SnoozeRow({
  showRow,
  onChoose,
  onRowPointerDown,
}: {
  readonly showRow: boolean;
  readonly onChoose: (snoozedUntil: string) => void;
  readonly onRowPointerDown: () => void;
}) {
  return (
    <NodexTooltipProvider>
      {showRow ? (
        <div data-testid="row" onPointerDown={onRowPointerDown}>
          <SnoozeMenu onChoose={onChoose} />
        </div>
      ) : null}
      <NodexModalHost />
    </NodexTooltipProvider>
  );
}

describe("Custom snooze", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("opens beside the menu's row, outlives it, and snoozes until a typed time", async () => {
    const onChoose = vi.fn();
    const onRowPointerDown = vi.fn();
    const view = renderWithMaitai(
      <SnoozeRow showRow onChoose={onChoose} onRowPointerDown={onRowPointerDown} />,
    );

    await act(async () => {
      fireEvent.mouseDown(screen.getByRole("button", { name: "Snooze" }), { button: 0 });
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Custom…" }));

    const dialog = await screen.findByRole("dialog", { name: "Snooze until" });
    const field = await within(dialog).findByRole("textbox", { name: "Date and time" });
    // It starts at the next morning, and its clicks never reach the row that offered it.
    expect(within(dialog).getByText("tomorrow at 9:00 AM")).toBeTruthy();
    fireEvent.pointerDown(field);
    expect(onRowPointerDown).not.toHaveBeenCalled();

    view.rerender(
      <SnoozeRow showRow={false} onChoose={onChoose} onRowPointerDown={onRowPointerDown} />,
    );
    expect(screen.getByRole("dialog", { name: "Snooze until" })).toBe(dialog);

    const snooze = within(dialog).getByRole("button", { name: "Snooze" });
    fireEvent.change(field, { target: { value: "tom 3pm" } });
    expect(within(dialog).getByText("Couldn’t read that time")).toBeTruthy();
    expect(snooze).toHaveProperty("disabled", true);

    fireEvent.change(field, { target: { value: "fri 3pm" } });
    expect(within(dialog).getByText("Fri, Nov 27 at 3:00 PM")).toBeTruthy();
    expect(within(dialog).getByRole("option", { name: "3:00 PM" }).ariaSelected).toBe("true");

    fireEvent.click(snooze);
    expect(onChoose).toHaveBeenCalledWith(new Date(2026, 10, 27, 15, 0).toISOString());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
