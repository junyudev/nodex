import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { resolveNodexProjectsDirectory } from "./nodex-projects-directory";

const profile = {
  projectsDirectory: null,
  documentsPath: resolve("fixture", "Documents"),
  isolatedRunId: null,
  nodexHome: resolve("fixture", ".nodex"),
};
const isolated = {
  ...profile,
  isolatedRunId: "run-1",
  nodexHome: resolve("runs.local", "task", ".nodex"),
};

test("a real Profile makes folders in the user's Documents/Nodex", () => {
  expect(resolveNodexProjectsDirectory(profile)).toBe(join(profile.documentsPath, "Nodex"));
});

test("an isolated run makes folders inside its own home, never the user's Documents", () => {
  expect(resolveNodexProjectsDirectory(isolated)).toBe(join(isolated.nodexHome, "workspace"));
});

test("a configured directory wins for either and must be absolute", () => {
  const configured = resolve("runs.local", "task", "workspace");
  for (const config of [profile, isolated])
    expect(
      resolveNodexProjectsDirectory({
        ...config,
        projectsDirectory: ` ${configured} `,
      }),
    ).toBe(configured);
  expect(() =>
    resolveNodexProjectsDirectory({ ...profile, projectsDirectory: "workspace" }),
  ).toThrow("NODEX_PROJECTS_DIR must be an absolute path");
});
