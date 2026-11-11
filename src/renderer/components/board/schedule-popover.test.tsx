import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { useScheduleState } from "@/lib/use-schedule-state";
import { render, settleAsyncRender } from "@/test/dom";
import { SchedulePopover } from "./schedule-popover";

function EmptySchedule({ openOnMount }: { readonly openOnMount?: boolean }) {
  const schedule = useScheduleState({ page: null, saveProperty: () => undefined });
  return <SchedulePopover schedule={schedule} page={{}} openOnMount={openOnMount} />;
}

test("Schedule opens on mount and closes back to its trigger", async () => {
  const view = render(<EmptySchedule openOnMount />);
  const trigger = view.getByRole("button", { name: "Set schedule" });
  await view.findByLabelText("Start");
  expect(document.activeElement).toBe(trigger);

  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Escape" });
  });
  await waitFor(() => expect(view.queryByLabelText("Start")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  view.rerender(<EmptySchedule openOnMount={false} />);
  view.rerender(<EmptySchedule openOnMount />);
  await settleAsyncRender();
  expect(view.queryByLabelText("Start")).toBeNull();
});

test("Schedule stays closed when the mount request arrives after mount", async () => {
  const view = render(<EmptySchedule />);
  expect(view.queryByLabelText("Start")).toBeNull();
  view.rerender(<EmptySchedule openOnMount />);
  await settleAsyncRender();
  expect(view.queryByLabelText("Start")).toBeNull();
});
