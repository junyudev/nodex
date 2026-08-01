import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vite-plus/test";

import { readReleaseVersion, readRootChangelog } from "./utils/release";

test("landing release data comes from repository sources of truth", () => {
  const rootPackage = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8"),
  ) as { version: string };

  expect(readReleaseVersion()).toBe(rootPackage.version);
  expect(readRootChangelog()).toMatch(/^# Changelog/m);
});
