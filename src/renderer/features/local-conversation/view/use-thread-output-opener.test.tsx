import { act, fireEvent } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import {
  useThreadOutputOpenInMenu,
  type ThreadOutputNativeBrowserTarget,
} from "./use-thread-output-opener";
import type { ThreadSummaryPanelOutputRow } from "../projection/thread-summary-panel-output-model";

const ports = vi.hoisted(() => ({
  files: vi.fn(async () => true),
  links: vi.fn(async () => true),
  targets: vi.fn(),
  native: vi.fn(async () => true),
  save: vi.fn(async () => ({ path: "/downloads/copy" })),
  copy: vi.fn(async () => undefined),
  query: vi.fn(),
}));
vi.mock("@/lib/file-reference-router", async (original) => ({
  ...(await original<typeof import("@/lib/file-reference-router")>()),
  useFileReferenceRouter: () => ({ hostId: "local", workspaceRoot: "/repo", open: ports.files }),
}));
vi.mock("@/lib/web-link-navigation", () => ({
  useLinkOpening: () => ({ browserAvailable: true, openLink: ports.links }),
  useWebLinkNavigation: () => undefined,
}));
vi.mock("@/lib/file-reference-open-targets", () => ({
  readFileReferenceOpenTargets: ports.targets,
  openFileReferenceTarget: ports.native,
}));
vi.mock("@/lib/workspace-file-operations", () => ({ saveWorkspaceFileCopy: ports.save }));
vi.mock("@/lib/clipboard", () => ({ writeTextToClipboard: ports.copy }));

const file = (path: string): ThreadSummaryPanelOutputRow => ({
  id: path,
  kind: "file",
  path,
  title: path,
  label: path,
});
const website: ThreadSummaryPanelOutputRow = {
  id: "web",
  kind: "website",
  target: "https://example.com/",
  title: "Example",
  label: "Example",
};
function Menu({
  row,
  hostId = "local",
  readNativeBrowserTargets,
}: {
  row: ThreadSummaryPanelOutputRow;
  hostId?: string;
  readNativeBrowserTargets?: () => Promise<readonly ThreadOutputNativeBrowserTarget[]>;
}) {
  const menu = useThreadOutputOpenInMenu(row, { hostId, cwd: "/repo", readNativeBrowserTargets });
  return (
    <>
      <button onClick={() => void menu.load()}>Load</button>
      <output>{menu.isLoading ? "Loading" : "Ready"}</output>
      {menu.items.map((item) => (
        <button key={item.id} onClick={() => void item.open()}>
          {item.label}
          {item.isSystemDefault ? " (Default)" : ""}
        </button>
      ))}
    </>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  ports.query.mockResolvedValue(null);
  Object.defineProperty(window, "api", { configurable: true, value: { invoke: ports.query } });
  ports.targets.mockResolvedValue({
    primary: null,
    alternatives: [
      {
        id: "application:preview",
        label: "Preview",
        appPath: "/Applications/Preview.app",
        iconUrl: "icon",
        isSystemDefault: true,
      },
      { id: "finder", label: "Finder", opener: "fileManager" },
    ],
  });
});
test("remote output menu exposes only the in-app viewer", async () => {
  const view = render(<Menu row={file("/repo/report.html")} hostId="ssh:build" />);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Load" }));
    await Promise.resolve();
  });
  await view.findByRole("button", { name: "Nodex" });
  expect(ports.targets).not.toHaveBeenCalled();
  expect(view.queryByRole("button", { name: "Save a copy" })).toBeNull();
});
test("a promoted file viewer does not inherit the OS association's default marker", async () => {
  ports.targets.mockResolvedValue({
    primary: null,
    alternatives: [
      {
        id: "application:preview",
        label: "Preview",
        appPath: "/Applications/Preview.app",
        isSystemDefault: false,
      },
      {
        id: "application:reader",
        label: "PDF Reader",
        appPath: "/Applications/PDF Reader.app",
        isSystemDefault: true,
      },
    ],
  });
  const view = render(<Menu row={file("report.pdf")} />);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Load" }));
    await Promise.resolve();
  });
  expect(await view.findByRole("button", { name: "PDF Reader (Default)" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Preview" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Preview (Default)" })).toBeNull();
});
test("website menus retain the default-browser fallback when the OS handler is unknown", async () => {
  const view = render(<Menu row={website} />);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Load" }));
    await Promise.resolve();
  });
  const browser = await view.findByRole("button", { name: "Open in default browser" });
  expect(ports.query).toHaveBeenCalledExactlyOnceWith("shell:default-browser:get");
  await act(async () => {
    fireEvent.click(browser);
    await Promise.resolve();
  });
  expect(ports.links).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "https://example.com/",
      openTarget: "external-browser",
    }),
  );
});
