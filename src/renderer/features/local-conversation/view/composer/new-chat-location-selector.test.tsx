import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { openNodexMenu, render, settleAsyncRender } from "@/test/dom";
import { NewChatLocationSelector } from "./new-chat-location-selector";

afterEach(async () => {
  await act(async () => cleanup());
});

test("searches available locations and resets search when dismissed", async () => {
  const view = render(
    <NodexTooltipProvider>
      <NewChatLocationSelector />
    </NodexTooltipProvider>,
  );
  const trigger = view.getByRole("button", { name: "Location" });
  await openNodexMenu(trigger);
  const search = await view.findByRole("textbox", { name: "Search locations" });
  await act(async () => {
    search.focus();
    fireEvent.change(search, { target: { value: "missing" } });
    await Promise.resolve();
  });
  expect(view.getByText("No matching locations")).toBeTruthy();
  expect(view.queryByRole("menuitem", { name: "This computer" })).toBeNull();
  await act(async () => {
    fireEvent.keyDown(search, { key: "Escape" });
    fireEvent.keyUp(search, { key: "Escape" });
    await Promise.resolve();
  });
  await waitFor(() => expect(view.queryByRole("textbox")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await openNodexMenu(trigger);
  const local = await view.findByRole("menuitem", { name: "This computer" });
  expect((view.getByRole("textbox", { name: "Search locations" }) as HTMLInputElement).value).toBe(
    "",
  );
  await act(async () => {
    fireEvent.click(local);
    await Promise.resolve();
  });
  await settleAsyncRender();
  await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
