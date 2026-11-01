import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { resolveNodexHomePath } from "./nodex-home";

const baseOptions = {
  cwd: "/workspace/project",
  platform: "linux",
  env: {},
  userHome: "/home/user",
} satisfies Parameters<typeof resolveNodexHomePath>[0];

describe("resolveNodexHomePath", () => {
  test("prefers an absolute environment override", () => {
    expect(
      resolveNodexHomePath({
        ...baseOptions,
        env: { NODEX_HOME: "/profiles/work" },
        configuredHome: "/profiles/configured",
      }),
    ).toBe("/profiles/work");
  });

  test("resolves relative environment overrides from the launch directory", () => {
    expect(
      resolveNodexHomePath({
        ...baseOptions,
        env: { NODEX_HOME: "relative-profile" },
      }),
    ).toBe(path.posix.join(baseOptions.cwd, "relative-profile"));
  });

  test("ignores a blank environment override", () => {
    expect(
      resolveNodexHomePath({
        ...baseOptions,
        env: { NODEX_HOME: "   " },
        configuredHome: "/profiles/configured",
      }),
    ).toBe("/profiles/configured");
  });

  test("resolves absolute, relative, and tilde-configured homes", () => {
    expect(
      resolveNodexHomePath({
        ...baseOptions,
        configuredHome: "/profiles/configured",
      }),
    ).toBe("/profiles/configured");
    expect(
      resolveNodexHomePath({
        ...baseOptions,
        configuredHome: "project-profile",
      }),
    ).toBe(path.posix.join(baseOptions.cwd, "project-profile"));
    expect(
      resolveNodexHomePath({
        ...baseOptions,
        configuredHome: "~/custom-nodex",
      }),
    ).toBe("/home/user/custom-nodex");
  });

  test("defaults to the hidden Nodex home under the user home", () => {
    expect(resolveNodexHomePath(baseOptions)).toBe("/home/user/.nodex");
  });
});

test("resolves Windows drive, UNC and tilde homes with Windows path semantics", () => {
  const windows = { platform: "win32", cwd: "C:\\工作\\repo", userHome: "C:\\Users\\Ada", env: {} };
  expect(resolveNodexHomePath(windows)).toBe("C:\\Users\\Ada\\.nodex");
  expect(resolveNodexHomePath({ ...windows, configuredHome: "~\\My Profile" })).toBe(
    "C:\\Users\\Ada\\My Profile",
  );
  expect(resolveNodexHomePath({ ...windows, env: { NODEX_HOME: "D:\\Profiles\\work" } })).toBe(
    "D:\\Profiles\\work",
  );
  expect(
    resolveNodexHomePath({ ...windows, env: { NODEX_HOME: "\\\\server\\profiles\\work" } }),
  ).toBe("\\\\server\\profiles\\work");
});
