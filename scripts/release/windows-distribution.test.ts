import { expect, test } from "vite-plus/test";
import { assertWindowsInstalledProbe } from "./windows-installed-probe";
import { windowsComponentPins, windowsProbeFixture } from "./windows-components.fixture";

const assertProbe = (value: unknown) =>
  assertWindowsInstalledProbe(value, "x64", windowsComponentPins);

test("requires installed stock-Node PTY evidence before emitting a Windows bundle", () => {
  expect(() => assertProbe(windowsProbeFixture())).not.toThrow();
  expect(() => assertProbe({ ...windowsProbeFixture(), packagedPty: undefined })).toThrow(
    "receipt",
  );
  const probe = windowsProbeFixture();
  probe.packagedPty.exitCode = 0;
  expect(() => assertProbe(probe)).toThrow("receipt");
});

test("rejects evidence from a foreign CPU or the Electron archive companion", () => {
  const foreign = windowsProbeFixture();
  foreign.packagedPty.architecture = "ia32";
  expect(() => assertProbe(foreign)).toThrow("receipt");
  const probe = windowsProbeFixture();
  probe.packagedPty.addonPath =
    "C:/installed/resources/app.asar.unpacked/out/agent-runtime/node_modules/node-pty";
  expect(() => assertProbe(probe)).toThrow("installed runtime");
});

test("requires the Node host and addon to belong to the same installation", () => {
  const probe = windowsProbeFixture();
  probe.packagedPty.nodeExecutable = "C:/another/resources/node-runtime/node.exe";
  expect(() => assertProbe(probe)).toThrow("installed runtime");
});

test("requires the exact Component pins and conformance from their Profile roots", () => {
  const probe = windowsProbeFixture();
  probe.components.receipts[0]!.root = "C:/installed/resources/browser-runtime";
  expect(() => assertProbe(probe)).toThrow("different Component receipt");
  const foreign = windowsProbeFixture();
  foreign.components.receipts[0]!.pin = {
    ...windowsComponentPins[0]!,
    archive: { ...windowsComponentPins[0]!.archive, sha256: "f".repeat(64) },
  };
  expect(() => assertProbe(foreign)).toThrow("different Component receipt");
  const unverified = windowsProbeFixture();
  unverified.components.desktopTools.processesClosed = 1;
  expect(() => assertProbe(unverified)).toThrow("Component conformance");
});
