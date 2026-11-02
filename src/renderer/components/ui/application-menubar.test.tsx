import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { NodexApplicationMenubar } from "./application-menubar";
import type { ApplicationMenuAdapter } from "@/lib/application-menu";

function fixture() {
  const invoke = vi.fn(async () => true);
  const adapter: ApplicationMenuAdapter = {
    invoke,
    read: vi.fn(async () => ({
      menus: ["File", "Edit", "View", "Help"].map((label) => ({
        type: "submenu" as const,
        id: label,
        label,
        enabled: true,
        items: [
          {
            type: "item" as const,
            id: `${label}.disabled`,
            label: "Unavailable",
            enabled: false,
            checked: false,
          },
          {
            type: "item" as const,
            id: `${label}.action`,
            label: `${label} action`,
            enabled: true,
            checked: false,
          },
        ],
      })),
    })),
  };
  const view = render(
    <>
      <input aria-label="Editor" />
      <NodexApplicationMenubar adapter={adapter} />
    </>,
  );
  return { ...view, invoke, adapter };
}
async function press(key: string, options: Partial<KeyboardEvent> = {}) {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? window, { key, ...options });
    await Promise.resolve();
  });
}

test("pointer invocation uses the Adapter and restores the previous editor focus", async () => {
  const { invoke } = fixture();
  const file = await screen.findByRole("menuitem", { name: "File" });
  const editor = screen.getByRole("textbox", { name: "Editor" });
  await act(async () => {
    editor.focus();
    fireEvent.click(file);
    await Promise.resolve();
  });
  const action = await screen.findByRole("menuitem", { name: "File action" });
  await act(async () => {
    fireEvent.click(action);
    await Promise.resolve();
  });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("File.action"));
  await waitFor(() => expect(document.activeElement).toBe(editor));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

test("Alt release and F10 enter and exit menu focus; mnemonics open and Escape restores focus", async () => {
  fixture();
  const file = await screen.findByRole("menuitem", { name: "File" });
  const editor = screen.getByRole("textbox", { name: "Editor" });
  await act(async () => {
    editor.focus();
  });
  await press("Alt");
  expect(document.activeElement).toBe(editor);
  await act(async () => {
    fireEvent.keyUp(window, { key: "Alt" });
    await Promise.resolve();
  });
  expect(document.activeElement).toBe(file);
  await press("e");
  await screen.findByRole("menuitem", { name: "Edit action" });
  await press("Escape");
  await waitFor(() => expect(document.activeElement).toBe(editor));
  await press("F10");
  expect(document.activeElement).toBe(file);
  await press("F10");
  await waitFor(() => expect(document.activeElement).toBe(editor));
  await press("h", { altKey: true });
  await screen.findByRole("menuitem", { name: "Help action" });
  await act(async () => {
    fireEvent.blur(window);
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

test("arrows move between triggers and open the first enabled menu item", async () => {
  fixture();
  await screen.findByRole("menuitem", { name: "File" });
  await press("F10");
  await press("ArrowRight");
  const edit = screen.getByRole("menuitem", { name: "Edit" });
  expect(document.activeElement).toBe(edit);
  await press("ArrowDown");
  const action = await screen.findByRole("menuitem", { name: "Edit action" });
  await waitFor(() => expect(document.activeElement).toBe(action));
  await press("ArrowRight");
  const viewAction = await screen.findByRole("menuitem", { name: "View action" });
  await waitFor(() => expect(document.activeElement).toBe(viewAction));
  await press("ArrowLeft");
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Edit action" })),
  );
  await press("Escape");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});
