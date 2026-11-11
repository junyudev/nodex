import path from "node:path";
import { expect, test } from "vite-plus/test";
import { resolveChromeHostRegistration } from "./ChromeHostRegistrationPolicy";

const base = {
  homeDirectory: path.resolve("user"),
  nodexHome: path.resolve("profile"),
  personalNodexHome: path.resolve("profile"),
  isolatedRunId: null,
  hasScenarioHome: false,
  isPackaged: false,
  launchMode: undefined,
};

test.each([
  ["packaged desktop", { isPackaged: true }, "production"],
  [
    "packaged desktop with an alternate Profile",
    { isPackaged: true, nodexHome: path.resolve("alternate") },
    "disabled",
  ],
  [
    "packaged desktop ignores the development opt-in",
    { isPackaged: true, launchMode: "development" },
    "production",
  ],
  ["unpackaged desktop", {}, "disabled"],
  ["development, seed or snapshot", { isolatedRunId: "dev" }, "disabled"],
  [
    "development launcher opt-in",
    { isolatedRunId: "dev", launchMode: "development" },
    "development",
  ],
  ["packaged isolated run", { isPackaged: true, isolatedRunId: "test" }, "disabled"],
  ["unpackaged direct launch with inherited opt-in", { launchMode: "development" }, "disabled"],
  ["packaged scenario", { isPackaged: true, hasScenarioHome: true }, "disabled"],
  ["Electron scenario", { isPackaged: true, launchMode: "disposable" }, "disposable"],
] as const)("%s registration ownership", (_label, input, kind) => {
  expect(resolveChromeHostRegistration({ ...base, ...input })).toEqual(
    kind === "disabled"
      ? { kind }
      : {
          kind,
          homeDirectory:
            kind === "disposable"
              ? path.join(base.nodexHome, "browser-host-home")
              : base.homeDirectory,
        },
  );
});
