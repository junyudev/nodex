import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import {
  useThreadOutputOpener,
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
function Body({ row, hostId = "local" }: { row: ThreadSummaryPanelOutputRow; hostId?: string }) {
  const opener = useThreadOutputOpener({ hostId, cwd: "/repo", workspaceRoot: "/repo" });
  return <button onClick={(event) => void opener.openFromEvent(row, event)}>Open</button>;
}
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
test.each(["/repo/report.html", "/repo/image.png", "/repo/file.md"])(
  "file output %s uses side-panel intent",
  async (path) => {
    const view = render(<Body row={file(path)} hostId="ssh:build" />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Open" }));
      await Promise.resolve();
    });
    expect(ports.files).toHaveBeenCalledWith(
      { path },
      expect.objectContaining({
        hostId: "ssh:build",
        cwd: "/repo",
        workspaceRoot: "/repo",
        sidePanel: true,
      }),
    );
    expect(ports.links).not.toHaveBeenCalled();
  },
);
test("website output forwards its activation to preference-aware opening", async () => {
  const view = render(<Body row={website} />);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Open" }), { ctrlKey: true, shiftKey: true });
    await Promise.resolve();
  });
  expect(ports.links).toHaveBeenCalledWith(
    expect.objectContaining({
      url: website.target,
      hostId: "local",
      initiator: "mcp_app_resource",
      activation: expect.objectContaining({ ctrlKey: true, shiftKey: true }),
    }),
  );
});
test("local output menu resolves the native path, offers explicit preview and retains target metadata", async () => {
  const view = render(<Menu row={file("report.html")} />);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Load" }));
    await Promise.resolve();
  });
  expect(await view.findByRole("button", { name: "Preview (Default)" })).toBeTruthy();
  expect(ports.targets).toHaveBeenCalledWith("/repo/report.html");
  expect(view.queryByRole("button", { name: "Finder" })).toBeNull();
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Preview (Default)" }));
    await Promise.resolve();
  });
  expect(ports.native).toHaveBeenCalledWith(
    expect.objectContaining({ appPath: "/Applications/Preview.app" }),
    { path: "/repo/report.html" },
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Nodex" }));
    await Promise.resolve();
  });
  expect(ports.files).toHaveBeenCalledWith(
    { path: "/repo/report.html" },
    expect.objectContaining({ previewSource: true, sidePanel: true }),
  );
});
test("remote output menu exposes only the in-app viewer", async () => {
  const view = render(<Menu row={file("/repo/report.html")} hostId="ssh:build" />);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Load" }));
    await Promise.resolve();
  });
  await view.findByRole("button", { name: "Nodex" });
  expect(ports.targets).not.toHaveBeenCalled();
  expect(view.queryByRole("button", { name: "Download a copy" })).toBeNull();
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
test("website menus query the OS browser and open its URL through the external destination", async () => {
  ports.query.mockResolvedValue({
    name: "Safari",
    iconDataUrl: "data:image/png;base64,fixture",
    appPath: "/Applications/Safari.app",
  });
  const { result } = renderHook(() => useThreadOutputOpener({ hostId: "local" }));
  const items = await result.current.getOpenInMenu(website);
  expect(ports.query).toHaveBeenCalledExactlyOnceWith("shell:default-browser:get");
  const native = items.filter((item) => item.kind === "native");
  expect(native).toEqual([
    expect.objectContaining({
      id: "external-browser",
      label: "Safari",
      iconUrl: "data:image/png;base64,fixture",
      appPath: "/Applications/Safari.app",
      isSystemDefault: true,
    }),
  ]);
  expect(await native[0]!.open()).toBe(true);
  expect(ports.links).toHaveBeenCalledExactlyOnceWith({
    url: "https://example.com/",
    hostId: "local",
    initiator: "mcp_app_resource",
    openTarget: "external-browser",
  });
  expect(ports.native).not.toHaveBeenCalled();
});
test("website menus retain the default-browser fallback when the OS handler is unknown", async () => {
  const view = render(<Menu row={website} />);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Load" }));
    await Promise.resolve();
  });
  const browser = await view.findByRole("button", { name: "Default browser (Default)" });
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
test("website menu loads detected browser targets and keeps explicit in-app and Copy link actions", async () => {
  let resolve!: (value: readonly ThreadOutputNativeBrowserTarget[]) => void;
  const native = vi.fn(async () => true);
  const read = () =>
    new Promise<readonly ThreadOutputNativeBrowserTarget[]>((done) => {
      resolve = done;
    });
  const view = render(<Menu row={website} readNativeBrowserTargets={read} />);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Load" }));
    await Promise.resolve();
  });
  expect(view.getByText("Loading")).toBeTruthy();
  await act(async () => {
    resolve([
      {
        id: "safari",
        label: "Safari",
        appPath: "/Applications/Safari.app",
        isSystemDefault: true,
        open: native,
      },
    ]);
    await Promise.resolve();
  });
  await waitFor(() => expect(view.getByRole("button", { name: "Safari (Default)" })).toBeTruthy());
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Nodex" }));
    await Promise.resolve();
  });
  expect(ports.links).toHaveBeenCalledWith(
    expect.objectContaining({ openTarget: "in-app-browser", initiator: "mcp_app_resource" }),
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Safari (Default)" }));
    await Promise.resolve();
  });
  expect(native).toHaveBeenCalledWith("https://example.com/");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Copy link" }));
    await Promise.resolve();
  });
  expect(ports.copy).toHaveBeenCalledWith("https://example.com/");
});
