import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { openNodexMenu } from "@/test/dom";
import { PermissionModeDropdown } from "./permission-mode-dropdown";

test("a failed permission change releases the menu for retry without changing the selected mode", async () => {
  const select = vi
    .fn()
    .mockRejectedValueOnce(new Error("Could not save permissions"))
    .mockResolvedValueOnce(undefined);
  const view = renderWithAppMaitai(
    <PermissionModeDropdown mode="approval-required" triggerStyle="settings" onSelect={select} />,
  );
  try {
    await openNodexMenu(screen.getByRole("button", { name: "Default permissions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Approve for me/ }));
      await Promise.resolve();
    });
    await openNodexMenu(screen.getByRole("button", { name: "Default permissions" }));
    const retry = await screen.findByRole("menuitem", { name: /Approve for me/ });
    await waitFor(() => expect(retry.getAttribute("aria-disabled")).not.toBe("true"));
    expect(screen.getByRole("button", { name: "Default permissions" }).textContent).toBe(
      "Ask for approval",
    );
    await act(async () => {
      fireEvent.click(retry);
      await Promise.resolve();
    });
    expect(select).toHaveBeenNthCalledWith(1, "auto");
    expect(select).toHaveBeenNthCalledWith(2, "auto");
  } finally {
    view.unmount();
  }
});
