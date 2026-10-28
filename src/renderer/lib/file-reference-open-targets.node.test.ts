import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  readFileReferenceOpenTargets,
  openFileReferenceTarget,
} from "./file-reference-open-targets";

const operations = vi.hoisted(() => ({
  native: vi.fn(),
  available: vi.fn(),
  openApplication: vi.fn(),
  open: vi.fn(),
  openDefault: vi.fn(),
}));
vi.mock("./file-system-operations", () => ({
  readFileOpenApplications: operations.native,
  listAvailableFileLinkOpeners: operations.available,
  openFileWithApplication: operations.openApplication,
  openFileLink: operations.open,
  openPathWithDefaultApplication: operations.openDefault,
}));
vi.mock("./file-link-opener-settings", () => ({ readFileLinkOpener: () => "cursor" }));
beforeEach(() => {
  vi.clearAllMocks();
  operations.native.mockResolvedValue({ defaultApplication: null, applications: [] });
  operations.available.mockResolvedValue(["vscode", "cursor", "fileManager"]);
  operations.openDefault.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());
test("offers only available editor destinations and promotes the preferred installed target", async () => {
  const targets = await readFileReferenceOpenTargets("/repo/file.ts");
  expect(targets.primary?.opener).toBe("cursor");
  expect(targets.alternatives.map((target) => target.id)).toEqual([
    "vscode",
    "cursor",
    "fileManager",
  ]);
});
test("uses actual native applications and routes them by appPath", async () => {
  operations.native.mockResolvedValue({
    defaultApplication: {
      name: "Preview",
      appPath: "/Applications/Preview.app",
      iconDataUrl: "data:image/png;base64,AA==",
    },
    applications: [],
  });
  operations.openApplication.mockResolvedValue(true);
  const targets = await readFileReferenceOpenTargets("/repo/diagram.pdf");
  expect(targets.primary).toEqual({
    id: "application:/Applications/Preview.app",
    label: "Preview",
    appPath: "/Applications/Preview.app",
    iconUrl: "data:image/png;base64,AA==",
  });
  expect(await openFileReferenceTarget(targets.primary!, { path: "/repo/diagram.pdf" })).toBe(true);
  expect(operations.openApplication).toHaveBeenCalledWith({
    path: "/repo/diagram.pdf",
    appPath: "/Applications/Preview.app",
  });
  expect(operations.open).not.toHaveBeenCalled();
});

test.each(["empty", "failed"])(
  "keeps native files out of editors when native discovery is %s",
  async (mode) => {
    if (mode === "failed") operations.native.mockRejectedValue(new Error("Unavailable"));
    const targets = await readFileReferenceOpenTargets("/repo/diagram.pdf");
    expect(targets.primary).toEqual({
      id: "systemDefault",
      label: "Default app",
      systemDefault: true,
    });
    expect(targets.alternatives.map((target) => target.id)).toEqual([
      "systemDefault",
      "fileManager",
    ]);
    expect(await openFileReferenceTarget(targets.primary!, { path: "/repo/diagram.pdf" })).toBe(
      true,
    );
    expect(operations.openDefault).toHaveBeenCalledExactlyOnceWith("/repo/diagram.pdf");
    expect(operations.open).not.toHaveBeenCalled();
  },
);

test.each(["/repo/diagram.pdf", "/repo/file.ts"])(
  "names the available file-manager destination for the desktop platform in %s",
  async (path) => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    const targets = await readFileReferenceOpenTargets(path);
    expect(targets.alternatives.find((target) => target.opener === "fileManager")?.label).toBe(
      "File Explorer",
    );
  },
);

test("uses the Linux file-manager name when navigator is unavailable", async () => {
  vi.stubGlobal("navigator", undefined);
  const targets = await readFileReferenceOpenTargets("/repo/diagram.pdf");
  expect(targets.alternatives.find((target) => target.opener === "fileManager")?.label).toBe(
    "File Manager",
  );
});
