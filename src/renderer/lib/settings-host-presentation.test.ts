import { expect, test } from "vite-plus/test";
import { resolveSettingsHostPresentation } from "./settings-host-presentation";

test.each(["win32", "linux", "unknown"])("%s hides host integrations it cannot run", (platform) => {
  expect(resolveSettingsHostPresentation(platform)).toEqual({
    computerUse: false,
    browserProfileImport: false,
    browserControl: false,
    appUpdates: false,
  });
});

test("macOS keeps its native integrations", () => {
  expect(resolveSettingsHostPresentation("darwin")).toEqual({
    computerUse: true,
    browserProfileImport: true,
    browserControl: true,
    appUpdates: true,
  });
});
