import { beforeEach, expect, test, vi } from "vite-plus/test";
import { buildWebLinkContextMenu, openWebLinkContextMenu } from "./web-link-context-menu";
import { installWindowApi } from "../test/browser-globals";

const ports = vi.hoisted(() => ({ menu: vi.fn(), copy: vi.fn(), external: vi.fn() }));
vi.mock("./native-context-menu", () => ({ showNativeContextMenu: ports.menu }));
vi.mock("./clipboard", () => ({ writeTextToClipboardStrict: ports.copy }));
vi.mock("./file-system-operations", () => ({ openExternalUrl: ports.external }));

beforeEach(() => vi.clearAllMocks());

test("conditions browser destinations on the owning surface's capabilities", () => {
  const openTab = vi.fn();
  const openWindow = vi.fn();
  const ids = (items: ReturnType<typeof buildWebLinkContextMenu>) =>
    items.map((item) => item.id).filter(Boolean);
  expect(ids(buildWebLinkContextMenu({}))).toEqual([
    "open-in-label",
    "open-in-external-browser",
    "copy-link",
    "save-link-as",
  ]);
  expect(
    ids(
      buildWebLinkContextMenu({ navigation: { openTab, openWindow }, selectedText: "selection" }),
    ),
  ).toEqual([
    "open-in-label",
    "open-in-new-tab",
    "open-in-new-window",
    "open-in-external-browser",
    "copy-selection",
    "copy-link",
    "save-link-as",
  ]);
  expect(
    ids(buildWebLinkContextMenu({ navigation: { openTab, isDefaultBrowser: true } })),
  ).not.toContain("open-in-external-browser");
});

test("copies the captured link selection and never treats it as a navigation action", async () => {
  ports.menu.mockResolvedValue("copy-selection");
  await openWebLinkContextMenu({
    url: "https://example.test",
    selectedText: "captured text",
    x: 1,
    y: 2,
    isCurrent: () => true,
  });
  expect(ports.copy).toHaveBeenCalledWith("captured text");
  expect(ports.external).not.toHaveBeenCalled();
});

test("does not execute a late native choice for a retired link", async () => {
  let current = true;
  ports.menu.mockImplementation(async () => {
    current = false;
    return "copy-link";
  });
  await openWebLinkContextMenu({
    url: "https://example.test",
    x: 1,
    y: 2,
    isCurrent: () => current,
  });
  expect(ports.copy).not.toHaveBeenCalled();
});

test("saves links through the native download command", async () => {
  const invoke = vi.fn(async () => true);
  installWindowApi({ invoke });
  ports.menu.mockResolvedValue("save-link-as");
  await openWebLinkContextMenu({
    url: "https://example.test/file",
    x: 1,
    y: 2,
    isCurrent: () => true,
  });
  expect(invoke).toHaveBeenCalledWith("browser-link:save", { url: "https://example.test/file" });
});
