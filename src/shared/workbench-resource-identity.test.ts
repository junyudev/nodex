import { describe, expect, test } from "vite-plus/test";
import {
  canonicalWorkbenchFilePath,
  workbenchFileResourceId,
  workbenchFilesResourceKey,
} from "./workbench-resource-identity";

describe("Workbench resource identity", () => {
  test("resolves equivalent absolute paths without changing filename spelling or host", () => {
    expect(workbenchFileResourceId("local", "src/../文件.ts", "/workspace")).toBe(
      workbenchFileResourceId("local", "/workspace/文件.ts"),
    );
    expect(workbenchFileResourceId("local", "/workspace/a.ts")).not.toBe(
      workbenchFileResourceId("remote", "/workspace/a.ts"),
    );
    expect(workbenchFileResourceId("local", "/workspace/A.ts")).not.toBe(
      workbenchFileResourceId("local", "/workspace/a.ts"),
    );
    expect(canonicalWorkbenchFilePath("/workspace/ a.ts ")).toBe("/workspace/ a.ts ");
    expect(canonicalWorkbenchFilePath("/workspace/name\\part.ts")).toBe("/workspace/name\\part.ts");
    expect(() => workbenchFileResourceId("local", "relative.ts")).toThrow();
  });

  test("normalizes Windows separators without walking above a drive or share root", () => {
    expect(canonicalWorkbenchFilePath("C:\\work\\..\\a.ts")).toBe("C:/a.ts");
    expect(canonicalWorkbenchFilePath("C:/../../a.ts")).toBe("C:/a.ts");
    expect(canonicalWorkbenchFilePath(canonicalWorkbenchFilePath("//host/share/../a.ts"))).toBe(
      "//host/share/a.ts",
    );
    expect(canonicalWorkbenchFilePath("\\\\host\\share\\..\\a.ts")).toBe("//host/share/a.ts");
  });

  test("distinguishes file explorer roots while a file remains independent of its project placement", () => {
    const config = { projectId: "project", hostId: "local", workspaceRoot: "/one", cwd: "/one" };
    expect(workbenchFilesResourceKey(config)).not.toBe(
      workbenchFilesResourceKey({ ...config, cwd: "/two", workspaceRoot: "/two" }),
    );
    expect(workbenchFilesResourceKey({ ...config, path: "/one/file.ts" })).toBe(
      workbenchFilesResourceKey({
        ...config,
        projectId: "other",
        cwd: "/two",
        path: "/one/file.ts",
      }),
    );
  });
});
