import { render, screen } from "@testing-library/react";
import { expect, it } from "vite-plus/test";
import { QueuedRunLabel } from "./queued-run-label";

it.each([
  [1, "1st"],
  [2, "2nd"],
  [3, "3rd"],
  [11, "11th"],
  [12, "12th"],
  [13, "13th"],
  [21, "21st"],
])("announces the current machine queue rank %s", (position, label) => {
  const view = render(<QueuedRunLabel position={Number(position)} />);
  expect(screen.getByRole("status").textContent).toBe(`Queued · ${label}`);
  view.rerender(<QueuedRunLabel position={2} />);
  expect(screen.getByRole("status").textContent).toBe("Queued · 2nd");
});
