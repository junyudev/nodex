import { settleLazyRender } from "@/test/dom";
import "./workbench-testkit/workbench-shell-harness";
import { expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { renderWorkbench } from "./workbench-testkit/workbench-shell-harness";

test("Windows mounts one navigation group in the application row above workspace actions", async () => {
  const root = document.documentElement;
  const previousOs = root.dataset.codexOs;
  const previousType = root.dataset.codexWindowType;
  root.dataset.codexOs = "win32";
  root.dataset.codexWindowType = "electron";
  const view = renderWorkbench();
  try {
    const menu = await view.findByRole("menubar", { name: "Application menu" });
    const row = menu.parentElement!;
    await waitFor(() =>
      expect(within(row).getByRole("button", { name: /sidebar$/i })).toBeTruthy(),
    );
    expect(within(row).getByRole("button", { name: "Back" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Forward" })).toBeTruthy();
    expect(view.getAllByRole("button", { name: /sidebar$/i })).toHaveLength(1);
    const header = view.getByTestId("workbench-global-header");
    expect(header.contains(menu)).toBe(false);
    expect(within(header).queryByRole("button", { name: "Back" })).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Spaces and settings" }));
      await Promise.resolve();
    });
    const settings = await view.findByRole("menuitem", { name: /Settings/ });
    await act(async () => {
      fireEvent.click(settings);
      await Promise.resolve();
    });
    await settleLazyRender();
    await view.findByRole("button", { name: "Back to app" });
    expect(header.hidden).toBe(true);
    // Computer Use is a Windows capability too, so its settings are listed here.
    expect(view.getByRole("link", { name: "Computer use", hidden: true })).not.toBeNull();
  } finally {
    view.unmount();
    if (previousOs === undefined) delete root.dataset.codexOs;
    else root.dataset.codexOs = previousOs;
    if (previousType === undefined) delete root.dataset.codexWindowType;
    else root.dataset.codexWindowType = previousType;
  }
});
