import { describe, expect, test } from "vite-plus/test";

import {
  assertLocalInstallDestination,
  createFreshLocalMacPackagePlan,
  parseLocalMacInstallOptions,
  type LocalMacBuildInstallOptions,
} from "./install-local-macos";

const options = (
  overrides: Partial<LocalMacBuildInstallOptions> = {},
): LocalMacBuildInstallOptions => ({
  allowProductionDestination: false,
  appPath: "/tmp/Nodex.app",
  cliTargetPath: "/tmp/bin/nodex",
  destination: "/tmp/Nodex Dev.app",
  installCli: false,
  targetArch: "arm64",
  ...overrides,
});

describe("local macOS app installer", () => {
  test("defaults to a fresh repository build and away from production", () => {
    const parsed = parseLocalMacInstallOptions(["--", "--install-cli"], "arm64", "/tmp/repository");

    expect(parsed.source).toEqual({
      kind: "fresh",
      repositoryRoot: "/tmp/repository",
    });
    expect(parsed.destination).toBe("/Applications/Nodex Dev.app");
    expect(parsed.installCli).toBe(true);
    expect(parsed.targetArch).toBe("arm64");
    expect(parsed.strictSign).toBe(false);
  });

  test("accepts an explicit strict-sign override for release-equivalent signing", () => {
    expect(
      parseLocalMacInstallOptions(["--strict-sign"], "arm64", "/tmp/repository").strictSign,
    ).toBe(true);
  });

  test("accepts an explicit artifact without treating dist as an implicit source", () => {
    expect(
      parseLocalMacInstallOptions(
        ["--app-path", "/tmp/build/Nodex.app"],
        "arm64",
        "/tmp/repository",
      ).source,
    ).toEqual({
      appPath: "/tmp/build/Nodex.app",
      kind: "artifact",
    });
  });

  test("packages a fresh app in one unique generated directory for the selected architecture", () => {
    const first = createFreshLocalMacPackagePlan("/tmp/repository", "arm64", "operation-a");
    const second = createFreshLocalMacPackagePlan("/tmp/repository", "arm64", "operation-b");

    expect(first.outputRoot).toBe("/tmp/repository/.generated/local-install/operation-a");
    expect(first.appPath).toBe(
      "/tmp/repository/.generated/local-install/operation-a/mac-arm64/Nodex.app",
    );
    expect(second.outputRoot).not.toBe(first.outputRoot);
    expect(first.commands.map(({ arguments: arguments_ }) => arguments_)).toEqual([
      ["run", "build"],
      ["run", "stage:native-runtime:mac:arm64"],
      ["exec", "tsx", "scripts/prepared-electron-build.ts", "verify"],
      [
        "exec",
        "electron-builder",
        "--mac",
        "dir",
        "--arm64",
        "--publish",
        "never",
        "--config.mac.notarize=false",
        "--config.directories.output=/tmp/repository/.generated/local-install/operation-a",
      ],
      ["exec", "tsx", "scripts/prepared-electron-build.ts", "verify"],
    ]);
  });

  test("signs local packages in fast local mode unless strict signing is requested", () => {
    const fast = createFreshLocalMacPackagePlan("/tmp/repository", "arm64", "operation-a");
    const strict = createFreshLocalMacPackagePlan("/tmp/repository", "arm64", "operation-b", true);

    const electronBuilderCommand = (plan: typeof fast) =>
      plan.commands.find(({ arguments: arguments_ }) => arguments_.includes("electron-builder"));
    expect(electronBuilderCommand(fast)?.environment).toEqual({
      NODEX_MAC_SIGN_MODE: "local",
    });
    expect(electronBuilderCommand(strict)?.environment).toBeUndefined();
    for (const plan of [fast, strict]) {
      for (const command of plan.commands) {
        if (command !== electronBuilderCommand(plan)) {
          expect(command.environment).toBeUndefined();
        }
      }
    }
  });

  test("requires an explicit override for the production Applications path", () => {
    expect(() =>
      assertLocalInstallDestination(
        options({
          destination: "/Applications/Nodex.app",
        }),
      ),
    ).toThrow("--allow-production-destination");

    expect(() =>
      assertLocalInstallDestination(
        options({
          allowProductionDestination: true,
          destination: "/Applications/Nodex.app",
        }),
      ),
    ).not.toThrow();
  });

  test("rejects a source/destination collision and broad paths", () => {
    expect(() =>
      assertLocalInstallDestination(
        options({
          destination: "/tmp/Nodex.app",
        }),
      ),
    ).toThrow("must be different");
    expect(() =>
      assertLocalInstallDestination(
        options({
          destination: "/Nodex.app",
        }),
      ),
    ).toThrow("broad");
  });
});
