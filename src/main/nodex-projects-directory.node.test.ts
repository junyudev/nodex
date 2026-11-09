import { expect, test } from "vitest";
import { resolveNodexProjectsDirectory } from "./nodex-projects-directory";

const profile = {
  projectsDirectory: null,
  documentsPath: "/Users/test/Documents",
  isolatedRunId: null,
  nodexHome: "/Users/test/.nodex",
};
const isolated = {
  ...profile,
  isolatedRunId: "run-1",
  nodexHome: "/repo/runs.local/task/.nodex",
};

test("a real Profile makes folders in the user's Documents/Nodex", () => {
  expect(resolveNodexProjectsDirectory(profile)).toBe("/Users/test/Documents/Nodex");
});

test("an isolated run makes folders inside its own home, never the user's Documents", () => {
  expect(resolveNodexProjectsDirectory(isolated)).toBe("/repo/runs.local/task/.nodex/workspace");
});

test("a configured directory wins for either and must be absolute", () => {
  for (const config of [profile, isolated])
    expect(
      resolveNodexProjectsDirectory({
        ...config,
        projectsDirectory: " /repo/runs.local/task/workspace ",
      }),
    ).toBe("/repo/runs.local/task/workspace");
  expect(() =>
    resolveNodexProjectsDirectory({ ...profile, projectsDirectory: "workspace" }),
  ).toThrow("NODEX_PROJECTS_DIR must be an absolute path");
});
