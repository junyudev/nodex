import { expect, test } from "vite-plus/test";
import { resolveSettingsHostPresentation } from "./settings-host-presentation";

test.each(["linux", "unknown"])("%s hides host integrations it cannot run", (platform) => {
  expect(resolveSettingsHostPresentation(platform)).toEqual({
    terminalShell: false,
    computerUse: false,
    browserProfileImport: false,
    browserControl: false,
    appUpdates: false,
    launchAtLogin: false,
  });
});

test("macOS keeps its native integrations", () => {
  expect(resolveSettingsHostPresentation("darwin")).toEqual({
    terminalShell: false,
    computerUse: true,
    browserProfileImport: true,
    browserControl: true,
    appUpdates: true,
    launchAtLogin: false,
  });
});

test("Windows exposes Browser control and app update settings", () => {
  expect(resolveSettingsHostPresentation("win32")).toEqual({
    terminalShell: true,
    computerUse: true,
    browserProfileImport: false,
    browserControl: true,
    appUpdates: true,
    launchAtLogin: true,
  });
});
