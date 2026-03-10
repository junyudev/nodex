import { describe, expect, test } from "bun:test";
import { sep } from "path";
import { configureInstanceScopePaths, resolveInstanceScopePaths } from "./instance-scope";

describe("resolveInstanceScopePaths", () => {
  test("returns deterministic user/session data paths under the kanban dir", () => {
    const scopedPaths = resolveInstanceScopePaths("/tmp/nodex-profile");

    expect(scopedPaths.userDataPath.endsWith(`${sep}electron-user-data`)).toBe(true);
    expect(scopedPaths.sessionDataPath.endsWith(`${sep}electron-session-data`)).toBe(true);
  });
});

describe("configureInstanceScopePaths", () => {
  test("sets electron userData and sessionData paths to the scoped profile", () => {
    const setPathCalls: Array<{ key: string; value: string }> = [];
    const electronApp = {
      setPath: (key: string, value: string) => {
        setPathCalls.push({ key, value });
      },
    };

    const scopedPaths = configureInstanceScopePaths(electronApp, "/tmp/nodex-profile");

    expect(setPathCalls.length).toBe(2);
    expect(setPathCalls[0]?.key).toBe("userData");
    expect(setPathCalls[0]?.value).toBe(scopedPaths.userDataPath);
    expect(setPathCalls[1]?.key).toBe("sessionData");
    expect(setPathCalls[1]?.value).toBe(scopedPaths.sessionDataPath);
  });
});
