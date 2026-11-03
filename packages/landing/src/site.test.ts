import { expect, test } from "vite-plus/test";

import { windowsDownloadsAvailable } from "./lib/site";

test("Windows downloads start with the first release after 0.5.0", () => {
  expect(windowsDownloadsAvailable("0.4.9")).toBe(false);
  expect(windowsDownloadsAvailable("0.5.0")).toBe(false);
  expect(windowsDownloadsAvailable("0.5.1")).toBe(true);
  expect(windowsDownloadsAvailable("0.6.0")).toBe(true);
  expect(windowsDownloadsAvailable("1.0.0")).toBe(true);
  expect(windowsDownloadsAvailable("0.5.1-nightly.20261103.2100")).toBe(true);
});
