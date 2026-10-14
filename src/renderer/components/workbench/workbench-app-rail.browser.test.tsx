import { act, render } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { WorkbenchAppRail } from "./workbench-app-rail";

test("Home and Space remain keyboard reachable and reflect the selected destination", async () => {
  const onHome = vi.fn();
  const onSpace = vi.fn();

  function RailHarness() {
    const [destination, setDestination] = useState<"home" | "space">("home");
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
      />
    );
  }

  const view = render(<RailHarness />);
  const home = view.getByRole("button", { name: "Home" });
  const space = view.getByRole("button", { name: "Space" });
  expect(home.getAttribute("aria-current")).toBe("page");
  expect(space.hasAttribute("aria-current")).toBe(false);

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
  expect(space.getAttribute("aria-current")).toBe("page");
  expect(home.hasAttribute("aria-current")).toBe(false);

  await act(async () => {
    await userEvent.tab({ shift: true });
    await userEvent.keyboard("{Enter}");
  });
  expect(document.activeElement).toBe(home);
  expect(onHome).toHaveBeenCalledOnce();
  expect(onSpace).toHaveBeenCalledOnce();
  expect(home.getAttribute("aria-current")).toBe("page");
  expect(space.hasAttribute("aria-current")).toBe(false);
});
