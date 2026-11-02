import "./workbench-testkit/workbench-shell-harness";
import { expect, test } from "vite-plus/test";
import { waitFor, within } from "@testing-library/react";
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
  } finally {
    view.unmount();
    if (previousOs === undefined) delete root.dataset.codexOs;
    else root.dataset.codexOs = previousOs;
    if (previousType === undefined) delete root.dataset.codexWindowType;
    else root.dataset.codexWindowType = previousType;
  }
});
