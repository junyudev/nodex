import { fireEvent } from "@testing-library/react";
import { act } from "react";
import { beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import { todayAsIsoDate } from "@/lib/data-source-property-date";
import { DatePropertyEditor, preloadDatePropertyCalendar } from "./date-property-editor";

vi.mock("@/components/ui/date-calendar", async () => {
  const { DateCalendarTestSurface } = await import("./testkit/date-calendar-test-surface");
  return { NodexDateCalendar: DateCalendarTestSurface };
});

beforeAll(async () => {
  await act(preloadDatePropertyCalendar);
});

describe("DatePropertyEditor", () => {
  test("renders an empty date as only the shared Empty value", () => {
    const view = render(
      <DatePropertyEditor
        label="Due date"
        mode="date"
        value={null}
        revision={3}
        disabled={false}
        presentation="page"
        onChange={vi.fn()}
      />,
    );

    const trigger = view.getByRole("button", { name: "Edit Due date" });
    expect(trigger.textContent).toBe("Empty");
    expect(trigger.querySelector("svg")).toBeNull();
  });

  test("commits a strict typed date and clears it explicitly", async () => {
    const onChange = vi.fn();
    const view = render(
      <DatePropertyEditor
        label="Due date"
        mode="date"
        value="2026-08-04"
        revision={3}
        disabled={false}
        presentation="page"
        onChange={onChange}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Due date" }));
      await Promise.resolve();
    });
    const input = view.getByRole("textbox", { name: "Due date date" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "2026-08-19" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith("2026-08-19");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Clear" }));
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  test("keeps invalid typed input local instead of clearing the value", async () => {
    const onChange = vi.fn();
    const view = render(
      <DatePropertyEditor
        label="Due date"
        mode="date"
        value="2026-08-04"
        revision={3}
        disabled={false}
        presentation="page"
        onChange={onChange}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Due date" }));
      await Promise.resolve();
    });
    const input = view.getByRole("textbox", { name: "Due date date" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "2026-02-29" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(view.getByRole("alert").textContent).toContain("valid date");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("cancels a valid typed draft on Escape without blur-committing it", async () => {
    const onChange = vi.fn();
    const view = render(
      <DatePropertyEditor
        label="Due date"
        mode="date"
        value="2026-08-04"
        revision={3}
        disabled={false}
        presentation="page"
        onChange={onChange}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Due date" }));
      await Promise.resolve();
    });
    const input = view.getByRole("textbox", { name: "Due date date" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "2026-08-19" } });
      fireEvent.keyDown(input, { key: "Escape" });
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(view.queryByRole("textbox", { name: "Due date date" })).toBeNull();
  });

  test("does not blur-commit a draft before an explicit calendar action", async () => {
    const onChange = vi.fn();
    const view = render(
      <DatePropertyEditor
        label="Due date"
        mode="date"
        value="2026-08-04"
        revision={3}
        disabled={false}
        presentation="page"
        onChange={onChange}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Due date" }));
      await Promise.resolve();
    });
    const input = view.getByRole("textbox", { name: "Due date date" });
    const today = view.getByRole("button", { name: "Today" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "2026-08-19" } });
      fireEvent.pointerDown(today);
      fireEvent.blur(input);
      fireEvent.click(today);
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(todayAsIsoDate());
  });

  test("closes an open editor when the Property becomes read-only", async () => {
    const onChange = vi.fn();
    const props = {
      label: "Due date",
      mode: "date" as const,
      value: "2026-08-04",
      revision: 3,
      presentation: "page" as const,
      onChange,
    };
    const view = render(<DatePropertyEditor {...props} disabled={false} />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Due date" }));
      await Promise.resolve();
    });
    view.rerender(<DatePropertyEditor {...props} disabled />);
    expect(view.queryByRole("textbox", { name: "Due date date" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  test("resets an open date draft on a new revision without committing or moving focus", async () => {
    const onChange = vi.fn();
    const props = {
      label: "Due date",
      mode: "date" as const,
      value: "2026-08-04",
      revision: 3,
      disabled: false,
      presentation: "page" as const,
      onChange,
    };
    const view = render(<DatePropertyEditor {...props} />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Due date" }));
      await Promise.resolve();
    });
    const input = view.getByRole("textbox", { name: "Due date date" }) as HTMLInputElement;
    await act(async () => {
      input.focus();
      fireEvent.change(input, { target: { value: "2026-08-19" } });
      await Promise.resolve();
    });
    view.rerender(<DatePropertyEditor {...props} revision={4} />);
    expect(view.getByRole("textbox", { name: "Due date date" })).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("2026-08-04");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("allows retrying the same draft after reopening without a revision change", async () => {
    const onChange = vi.fn();
    const view = render(
      <DatePropertyEditor
        label="Due date"
        mode="date"
        value="2026-08-04"
        revision={3}
        disabled={false}
        presentation="page"
        onChange={onChange}
      />,
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Edit Due date" }));
        await Promise.resolve();
      });
      const input = view.getByRole("textbox", { name: "Due date date" });
      await act(async () => {
        fireEvent.change(input, { target: { value: "2026-08-19" } });
        fireEvent.keyDown(input, { key: "Enter" });
        fireEvent.keyDown(input, { key: "Escape" });
        await Promise.resolve();
      });
    }
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
