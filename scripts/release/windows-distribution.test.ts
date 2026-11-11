import { randomUUID } from "node:crypto";
import { expect, test } from "vite-plus/test";
import { assertWindowsInstalledProbe } from "./windows-distribution";

const fixture = () => {
  const marker = `NODEX_PTY_${randomUUID()}`;
  return {
    failures: [],
    desktopTools: { status: "skipped: candidate assets" },
    evidence: {},
    normalQuit: {},
    upgrade: {},
    uninstall: {},
    packagedPty: {
      schemaVersion: 1,
      nodeExecutable: "/installed/resources/node-runtime/node.exe",
      addonPath: "/installed/resources/agent-runtime/node_modules/node-pty",
      platform: "win32",
      architecture: "arm64",
      marker,
      output: marker,
      exitCode: 73,
      ptyPid: 123,
    },
  };
};
test("requires installed stock-Node PTY evidence before emitting a Windows bundle", () => {
  expect(() => assertWindowsInstalledProbe(fixture(), "arm64", false)).not.toThrow();
  expect(() =>
    assertWindowsInstalledProbe({ ...fixture(), packagedPty: undefined }, "arm64", false),
  ).toThrow("receipt");
  const probe = fixture();
  probe.packagedPty.exitCode = 0;
  expect(() => assertWindowsInstalledProbe(probe, "arm64", false)).toThrow("receipt");
});
test("rejects evidence from a foreign CPU or the Electron archive companion", () => {
  expect(() => assertWindowsInstalledProbe(fixture(), "x64", false)).toThrow("installed runtime");
  const probe = fixture();
  probe.packagedPty.addonPath =
    "/installed/resources/app.asar.unpacked/out/agent-runtime/node_modules/node-pty";
  expect(() => assertWindowsInstalledProbe(probe, "arm64", false)).toThrow("installed runtime");
});

test("requires the Node host and addon to belong to the same installation", () => {
  const probe = fixture();
  probe.packagedPty.nodeExecutable = "/another/resources/node-runtime/node.exe";
  expect(() => assertWindowsInstalledProbe(probe, "arm64", false)).toThrow("installed runtime");
});

test("requires installed vendor evidence when the lock selects a published closure", () => {
  const probe = fixture();
  expect(() => assertWindowsInstalledProbe(probe, "arm64", true)).toThrow("Desktop Tool state");
  const passed = { status: "passed", signedImages: 22, processesClosed: 2 };
  expect(() =>
    assertWindowsInstalledProbe({ ...probe, desktopTools: passed }, "arm64", true),
  ).not.toThrow();
  expect(() =>
    assertWindowsInstalledProbe({ ...probe, desktopTools: passed }, "arm64", false),
  ).toThrow("Desktop Tool state");
});
