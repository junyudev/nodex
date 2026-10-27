import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterAll, afterEach, expect, test, vi } from "vite-plus/test";
import {
  MAX_FILE_OPEN_APPLICATIONS,
  parseLaunchServicesApplications,
  prioritizedBundleIdsForFile,
} from "./file-open-applications";
import { openFileWithApplication, readFileOpenApplications } from "./file-link-opener";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

const application = (
  name: string,
  appPath = `/Applications/${name}.app`,
  bundleId = "fixture.app",
) => ({ name, appPath, bundleId });
const root = await mkdtemp(path.join(tmpdir(), "nodex-open-applications-"));
const filePath = path.join(root, "video ' 空格.webm ");
await writeFile(filePath, "media");
afterEach(() => vi.clearAllMocks());
afterAll(() => rm(root, { recursive: true, force: true }));

test("keeps the default separate, deduplicates in system order and excludes Nodex and its running bundle", () => {
  const result = parseLaunchServicesApplications(
    JSON.stringify({
      defaultApplication: application("QuickTime Player"),
      applications: [
        application("Zed"),
        application("QuickTime Player"),
        application("IINA"),
        application("IINA", "/Applications/./IINA.app/"),
        application("Nodex", "/Applications/Nodex.app", "app.jyu.nodex"),
        application("Nodex Dev"),
        { name: "bad", appPath: "relative.app" },
      ],
    }),
    "/Applications/Nodex Dev.app/Contents/Resources/app.asar",
  );
  expect(result.defaultApplication).toEqual({
    name: "QuickTime Player",
    appPath: "/Applications/QuickTime Player.app",
    iconDataUrl: null,
  });
  expect(result.applications.map((app) => app.name)).toEqual(["Zed", "IINA"]);
});

test("opens a file type's well-known viewer ahead of whichever app claimed the default", () => {
  const output = JSON.stringify({
    defaultApplication: application("Fig Player", "/Applications/Fig Player.app", "fig.player"),
    applications: [
      application("Anty", "/Applications/Anty.app", "anty.browser"),
      application("QuickTime Player", undefined, "com.apple.QuickTimePlayerX"),
    ],
  });
  const result = parseLaunchServicesApplications(
    output,
    "",
    prioritizedBundleIdsForFile("/clips/review.WEBM"),
  );
  expect(result.defaultApplication?.name).toBe("QuickTime Player");
  expect(result.applications.map((app) => app.name)).toEqual(["Fig Player", "Anty"]);
  expect(prioritizedBundleIdsForFile("/notes/plan.txt")).toEqual([]);
});

test("caps alternatives and permits a missing or excluded default", () => {
  const result = parseLaunchServicesApplications(
    JSON.stringify({
      defaultApplication: application("Nodex", "/Applications/Nodex.app", "app.jyu.nodex"),
      applications: Array.from({ length: MAX_FILE_OPEN_APPLICATIONS + 5 }, (_, index) =>
        application(`Player ${MAX_FILE_OPEN_APPLICATIONS + 5 - index}`),
      ),
    }),
    "/Applications/Other.app",
  );
  expect(result.defaultApplication).toBeNull();
  expect(result.applications).toHaveLength(MAX_FILE_OPEN_APPLICATIONS);
  expect(result.applications.at(0)?.name).toBe(`Player ${MAX_FILE_OPEN_APPLICATIONS + 5}`);
  expect(result.applications.at(-1)?.name).toBe("Player 6");
  expect(
    parseLaunchServicesApplications('{"defaultApplication":null,"applications":[]}', ""),
  ).toEqual({ defaultApplication: null, applications: [] });
});

test.each([
  "invalid JSON",
  "{}",
  '{"applications":null}',
  '{"defaultApplication":42,"applications":[null]}',
])("handles malformed discovery output: %s", (output) => {
  expect(parseLaunchServicesApplications(output, "")).toEqual({
    defaultApplication: null,
    applications: [],
  });
});

test("validates exact existing paths before discovery and tolerates missing icons", async () => {
  const readApplications = vi.fn(async () =>
    JSON.stringify({
      defaultApplication: application("Player"),
      applications: [application("Other")],
    }),
  );
  const readIcon = vi.fn(async (path: string) => {
    if (path.endsWith("Other.app")) throw new Error("No icon");
    return "data:image/png;base64,fixture";
  });
  const result = await readFileOpenApplications(filePath, {
    platform: "darwin",
    readApplications,
    readIcon,
  });
  expect(readApplications).toHaveBeenCalledWith(filePath);
  expect(result.defaultApplication?.iconDataUrl).toBe("data:image/png;base64,fixture");
  expect(result.applications[0]?.iconDataUrl).toBeNull();
  readApplications.mockClear();
  await expect(
    readFileOpenApplications(path.join(root, "missing"), { readApplications, readIcon }),
  ).rejects.toThrow();
  await expect(
    readFileOpenApplications("relative", { readApplications, readIcon }),
  ).rejects.toThrow();
  expect(readApplications).not.toHaveBeenCalled();
  expect(
    await readFileOpenApplications(filePath, { platform: "linux", readApplications, readIcon }),
  ).toEqual({ defaultApplication: null, applications: [] });
  expect(readApplications).not.toHaveBeenCalled();
});

test("opens exact filenames with a validated application bundle and reports launch failures", async () => {
  const appPath = path.join(root, "Player.app");
  await mkdir(appPath);
  const launch = (code: number) => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", code));
    return child as ReturnType<typeof spawn>;
  };
  vi.mocked(spawn).mockImplementation(() => launch(0));
  expect(await openFileWithApplication({ path: filePath, appPath }, "darwin")).toBe(true);
  expect(spawn).toHaveBeenCalledWith(
    "/usr/bin/open",
    ["-a", appPath, filePath],
    expect.any(Object),
  );
  vi.mocked(spawn).mockImplementation(() => launch(1));
  expect(await openFileWithApplication({ path: filePath, appPath }, "darwin")).toBe(false);
  vi.mocked(spawn).mockClear();
  for (const input of [
    { path: filePath, appPath: "Player" },
    { path: "relative", appPath },
    { path: filePath, appPath: path.join(root, "Missing.app") },
  ])
    expect(await openFileWithApplication(input, "darwin")).toBe(false);
  expect(await openFileWithApplication({ path: filePath, appPath }, "linux")).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
});
