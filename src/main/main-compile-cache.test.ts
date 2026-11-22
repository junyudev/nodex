import { expect, test } from "vite-plus/test";
import { mainCompileCacheDirectory } from "./main-compile-cache";

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
  expect(mainCompileCacheDirectory({ ...base, isPackaged: false, platform: "darwin" })).toBeNull();
  expect(mainCompileCacheDirectory({ ...base, isPackaged: true, platform: "win32" })).toBeNull();
});
