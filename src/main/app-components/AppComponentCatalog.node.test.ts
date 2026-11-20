import { expect, test } from "vite-plus/test";
import { join } from "node:path";
import {
  appComponentCatalog,
  appComponentDefinition,
  appComponentHome,
} from "./AppComponentCatalog";
import { appComponentRoot } from "./AppComponentStore";

test("selects Profile Desktop Tools for packaged Apple Silicon and matching unpackaged opt-ins", () => {
  const target = { platform: "darwin", arch: "arm64", isPackaged: false };
  const packaged = appComponentCatalog({ ...target, isPackaged: true });
  expect(packaged).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "desktop-tools", install: "at-startup" }),
      expect.objectContaining({ id: "claude-code", install: "on-first-use" }),
    ]),
  );
  expect(appComponentCatalog(target)).toEqual([]);
  expect(
    appComponentCatalog({ ...target, environment: { NODEX_DEV_APP_COMPONENTS: "1" } }),
  ).toEqual(packaged);
  const testEnvironment = { NODE_ENV: "test", NODEX_TEST_APP_COMPONENTS: "1" };
  expect(appComponentCatalog({ ...target, environment: testEnvironment })).toEqual(packaged);
  expect(
    appComponentCatalog({ ...target, environment: { NODEX_TEST_APP_COMPONENTS: "1" } }),
  ).toEqual([]);
  expect(
    appComponentCatalog({
      ...target,
      environment: { NODE_ENV: "test", NODEX_DEV_APP_COMPONENTS: "1" },
    }),
  ).toEqual([]);
  expect(
    appComponentCatalog({
      ...target,
      platform: "win32",
      isPackaged: true,
      environment: testEnvironment,
    }),
  ).toEqual([]);
});

test("serve offers first-use components in its own store even if an execution directory is shared", () => {
  const nodexHome = "/execution";
  const target = { platform: "darwin", arch: "arm64", isPackaged: true, nodexHome };
  const headless = { ...target, headless: true };
  expect(appComponentCatalog(headless)).toEqual(
    appComponentCatalog(target).filter(({ install }) => install === "on-first-use"),
  );
  const claude = appComponentDefinition(target, "claude-code")!;
  expect(appComponentRoot(appComponentHome(target), claude)).toBe(
    join(nodexHome, "components", "claude-code", claude.archive.sha256),
  );
  expect(appComponentRoot(appComponentHome(headless), claude)).toBe(
    join(nodexHome, "runtime", "host", "components", "claude-code", claude.archive.sha256),
  );
});
