import { act, render } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { WorkbenchPrimaryDestination } from "../../../shared/workbench-layout";
import { WorkbenchAppRail } from "./workbench-app-rail";

test("rail entries remain keyboard reachable and reflect the selected destination", async () => {
  const onHome = vi.fn();
  const onSpace = vi.fn();
  const onScheduled = vi.fn();
  const onPlugins = vi.fn();

  function RailHarness() {
    const [destination, setDestination] = useState<WorkbenchPrimaryDestination>("home");
    return (
      <WorkbenchAppRail
        destination={destination}
        onHome={() => {
          onHome();
          setDestination("home");
        }}
        onSpace={() => {
          onSpace();
          setDestination("space");
        }}
        onScheduled={() => {
          onScheduled();
          setDestination("scheduled");
        }}
        onPlugins={() => {
          onPlugins();
          setDestination("plugins");
        }}
      />
    );
  }

  const view = render(<RailHarness />);
  const home = view.getByRole("button", { name: "Home" });
  const space = view.getByRole("button", { name: "Space" });
  const scheduled = view.getByRole("button", { name: "Scheduled" });
  const plugins = view.getByRole("button", { name: "Plugins" });
  const current = () =>
    [home, space, scheduled, plugins]
      .filter((button) => button.getAttribute("aria-current") === "page")
      .map((button) => button.getAttribute("aria-label"));
  expect(current()).toEqual(["Home"]);

  await act(async () => {
    await userEvent.tab();
  });
  expect(document.activeElement).toBe(home);

  await act(async () => {
    await userEvent.tab();
    await userEvent.keyboard(" ");
  });
  expect(document.activeElement).toBe(space);
  expect(onSpace).toHaveBeenCalledOnce();
  expect(onHome).not.toHaveBeenCalled();
  expect(current()).toEqual(["Space"]);

  await act(async () => {
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
  });
  expect(document.activeElement).toBe(scheduled);
  expect(onScheduled).toHaveBeenCalledOnce();
  expect(current()).toEqual(["Scheduled"]);

  await act(async () => {
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
  });
  expect(document.activeElement).toBe(plugins);
  expect(onPlugins).toHaveBeenCalledOnce();
  expect(current()).toEqual(["Plugins"]);

  await act(async () => {
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    await userEvent.keyboard("{Enter}");
  });
  expect(document.activeElement).toBe(home);
  expect(onHome).toHaveBeenCalledOnce();
  expect(current()).toEqual(["Home"]);
});
