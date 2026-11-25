import { describe, expect, test } from "vite-plus/test";
import {
  collectSecondInstancesForStartupReplay,
  requestsExplicitNewWindow,
} from "./main-runtime-startup-events";
import { mainCompileCacheDirectory } from "./main-compile-cache";
import { sep } from "path";
import { configureInstanceScopePaths, resolveInstanceScopePaths } from "./instance-scope";

describe("main-runtime-startup-events", () => {
  describe("collectSecondInstancesForStartupReplay", () => {
    test("consumes initial argv and queued deep links before replaying plain second instances", async () => {
      const calls: string[] = [];
      const replay = await collectSecondInstancesForStartupReplay(
        {
          initialArgv: ["--flag", "nodex://pages/card-1"],
          startupEvents: [
            { type: "open-url", url: "nodex://sessions/session-1" },
            { type: "second-instance", argv: ["nodex://pages/card-2"] },
            { type: "second-instance", argv: ["--new-window"] },
          ],
        },
        {
          consumeArgvDeepLink: (argv) => {
            calls.push(`argv:${argv.join(",")}`);
            return argv.some((arg) => arg.startsWith("nodex://"));
          },
          consumeOpenUrlDeepLink: (url) => {
            calls.push(`url:${url}`);
          },
        },
      );

      expect(calls.join("|")).toBe(
        "argv:--flag,nodex://pages/card-1|url:nodex://sessions/session-1|argv:nodex://pages/card-2|argv:--new-window",
      );
      expect(replay.length).toBe(1);
      expect(replay[0]?.join(",")).toBe("--new-window");
    });
  });

  describe("requestsExplicitNewWindow", () => {
    test("distinguishes an explicit new-window launch from an ordinary second instance", () => {
      expect(requestsExplicitNewWindow(["nodex", "--new-window"])).toBe(true);
      expect(requestsExplicitNewWindow(["nodex", "--new-window=false"])).toBe(false);
      expect(requestsExplicitNewWindow(["nodex", "--original-process-start-time=1"])).toBe(false);
    });
  });
});

describe("main-compile-cache", () => {
  const base = { home: "/Users/someone", environment: {}, appName: "Nodex" } as const;

  test("a packaged Nodex caches compiled Main code in the account's own cache folder", () => {
    expect(mainCompileCacheDirectory({ ...base, isPackaged: true, platform: "darwin" })).toBe(
      "/Users/someone/Library/Caches/Nodex/compile-cache",
    );
    expect(
      mainCompileCacheDirectory({
        ...base,
        isPackaged: true,
        platform: "win32",
        environment: { LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" },
      }),
    ).toBe("C:\\Users\\someone\\AppData\\Local\\Nodex\\compile-cache");
    expect(mainCompileCacheDirectory({ ...base, isPackaged: true, platform: "linux" })).toBe(
      "/Users/someone/.cache/Nodex/compile-cache",
    );
    expect(
      mainCompileCacheDirectory({
        ...base,
        isPackaged: true,
        platform: "linux",
        environment: { XDG_CACHE_HOME: "/var/cache/someone" },
      }),
    ).toBe("/var/cache/someone/Nodex/compile-cache");
  });

  test("development builds and an unknown Windows cache folder compile from source", () => {
    expect(
      mainCompileCacheDirectory({ ...base, isPackaged: false, platform: "darwin" }),
    ).toBeNull();
    expect(mainCompileCacheDirectory({ ...base, isPackaged: true, platform: "win32" })).toBeNull();
  });
});

describe("instance-scope", () => {
  describe("resolveInstanceScopePaths", () => {
    test("returns deterministic user/session data paths under the Nodex home", () => {
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
});
