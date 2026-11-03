import { expect, test } from "vite-plus/test";
import { resolveSettingsHostPresentation } from "./settings-host-presentation";

test.each(["linux", "unknown"])("%s hides host integrations it cannot run", (platform) => {
  expect(resolveSettingsHostPresentation(platform)).toEqual({
    computerUse: false,
    browserProfileImport: false,
    browserControl: false,
    appUpdates: false,
    launchAtLogin: false,
  });
});

test("macOS keeps its native integrations", () => {
  expect(resolveSettingsHostPresentation("darwin")).toEqual({
    computerUse: true,
    browserProfileImport: true,
    browserControl: true,
    appUpdates: true,
    launchAtLogin: false,
  });
});

test("Windows exposes app updates without macOS integrations", () => {
  expect(resolveSettingsHostPresentation("win32")).toEqual({
    computerUse: false,
    browserProfileImport: false,
    browserControl: false,
    appUpdates: true,
    launchAtLogin: true,
  });
});
