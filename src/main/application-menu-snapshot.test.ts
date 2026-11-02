import { expect, test } from "vite-plus/test";
import type { Menu, MenuItem } from "electron";
import { ApplicationMenuSnapshots, findNativeMenuAccelerator } from "./application-menu-snapshot";
function fixture() {
  const action = { label: "Copy", type: "normal", enabled: true, visible: true } as MenuItem;
  const parent = {
    label: "&Edit",
    type: "submenu",
    enabled: true,
    visible: true,
    submenu: { items: [action] },
  } as MenuItem;
  const menu = { items: [parent] } as Menu;
  return { action, parent, menu };
}
test("snapshot membership belongs to one window and is revoked on reread, rebuild, and release", () => {
  const snapshots = new ApplicationMenuSnapshots();
  const { action, menu } = fixture();
  const first = snapshots.read(1, menu).menus[0]!.items[0]!.id;
  expect(snapshots.resolve(1, first)).toBe(action);
  expect(snapshots.resolve(2, first)).toBeNull();
  snapshots.read(1, menu);
  expect(snapshots.resolve(1, first)).toBeNull();
  const second = snapshots.read(2, menu).menus[0]!.items[0]!.id;
  snapshots.release(2);
  expect(snapshots.resolve(2, second)).toBeNull();
  const third = snapshots.read(1, menu).menus[0]!.items[0]!.id;
  snapshots.clear();
  expect(snapshots.resolve(1, third)).toBeNull();
});
test("invocation revalidates visible and enabled ancestry and excludes structural rows", () => {
  const snapshots = new ApplicationMenuSnapshots();
  const { action, parent, menu } = fixture();
  const snapshot = snapshots.read(1, menu);
  const id = snapshot.menus[0]!.items[0]!.id;
  expect(snapshot.menus[0]!.label).toBe("Edit");
  expect(snapshots.resolve(1, snapshot.menus[0]!.id)).toBeNull();
  parent.enabled = false;
  expect(snapshots.resolve(1, id)).toBeNull();
  parent.enabled = true;
  action.visible = false;
  expect(snapshots.resolve(1, id)).toBeNull();
  expect(snapshots.read(1, menu).menus[0]!.items).toEqual([]);
});

test("only Main-owned enabled accelerators cross native input after menu removal", () => {
  const { menu, parent } = fixture();
  const reload = {
    label: "Reload",
    role: "reload",
    enabled: true,
    visible: true,
    accelerator: "Ctrl+R",
  } as MenuItem;
  const workspaceAction = {
    label: "New Window",
    id: "file.newWindow",
    enabled: true,
    visible: true,
    accelerator: "Ctrl+N",
  } as MenuItem;
  const closeWindow = {
    label: "Close Window",
    id: "file.closeWindow",
    enabled: true,
    visible: true,
    accelerator: "Ctrl+Shift+W",
  } as MenuItem;
  parent.submenu!.items.push(reload, workspaceAction, closeWindow);
  expect(findNativeMenuAccelerator(menu, (key) => key === "Ctrl+R")).toBe(reload);
  expect(findNativeMenuAccelerator(menu, (key) => key === "Ctrl+N")).toBeNull();
  expect(findNativeMenuAccelerator(menu, (key) => key === "Ctrl+Shift+W")).toBe(closeWindow);
  parent.enabled = false;
  expect(findNativeMenuAccelerator(menu, () => true)).toBeNull();
});
