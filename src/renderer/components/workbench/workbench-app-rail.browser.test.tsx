import { act, render } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { WorkbenchPrimaryDestination } from "../../../shared/workbench-layout";
import { WorkbenchAppRail } from "./workbench-app-rail";

test("rail entries remain keyboard reachable and reflect the selected destination", async () => {
  const onHome = vi.fn();
  const onSpace = vi.fn();
  const onAutomations = vi.fn();
  const onInsights = vi.fn();
  const onPlugins = vi.fn();

  function RailHarness() {
    const [destination, setDestination] = useState<WorkbenchPrimaryDestination>("home");
    return (
      <WorkbenchAppRail
        destination={destination}
        onInsights={() => {
          onInsights();
          setDestination("insights");
        }}
        onHome={() => {
          onHome();
          setDestination("home");
        }}
        onSpace={() => {
          onSpace();
          setDestination("space");
        }}
        onAutomations={() => {
          onAutomations();
          setDestination("automations");
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
  const automations = view.getByRole("button", { name: "Automations" });
  const insights = view.getByRole("button", { name: "Insights" });
  const plugins = view.getByRole("button", { name: "Plugins" });
  const current = () =>
    [home, space, automations, insights, plugins]
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
  expect(document.activeElement).toBe(automations);
  expect(onAutomations).toHaveBeenCalledOnce();
  expect(current()).toEqual(["Automations"]);

  // Places come first; Insights reads across them below the hairline.
  await act(async () => {
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
  });
  expect(document.activeElement).toBe(plugins);
  expect(onPlugins).toHaveBeenCalledOnce();
  expect(current()).toEqual(["Plugins"]);

  await act(async () => {
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
  });
  expect(document.activeElement).toBe(insights);
  expect(onInsights).toHaveBeenCalledOnce();
  expect(current()).toEqual(["Insights"]);

  await act(async () => {
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    await userEvent.keyboard("{Enter}");
  });
  expect(document.activeElement).toBe(home);
  expect(onHome).toHaveBeenCalledOnce();
  expect(current()).toEqual(["Home"]);
});
