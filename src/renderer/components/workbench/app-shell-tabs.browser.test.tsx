import { act, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { AppShellTabs } from "./app-shell-tabs";
import "../../globals.css";

vi.mock("@/lib/use-reduced-motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/use-reduced-motion")>()),
  useResolvedReducedMotion: () => true,
}));

test("closes a newly shown tab without moving its close target during the press", async () => {
  await page.viewport(800, 600);
  const close = vi.fn();
  const view = render(
    <div style={{ width: 600, height: 300 }}>
      <AppShellTabs
        tabs={[
          { id: "older", title: "Older", closable: true, renderPanel: () => null },
          { id: "opening", title: "Side chat", closable: true, renderPanel: () => null },
        ]}
        activeTabId="opening"
        onSelect={() => {}}
        onCloseTab={close}
      />
    </div>,
  );
  const button = view.getByRole("button", { name: "Close Side chat tab" });
  const tab = button.closest<HTMLElement>("[data-app-shell-tab-controller]");
  if (!tab) throw new Error("Expected a tab controller");
  await waitFor(() => expect(tab.offsetWidth).toBe(160));
  // Opening and exiting tabs can have unequal widths. Hold a deterministic opening frame.
  await act(async () => {
    tab.style.maxWidth = "90px";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await userEvent.click(button, { delay: 50 });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(close).toHaveBeenCalledExactlyOnceWith("opening");
});
