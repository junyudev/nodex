import { describe, expect, test } from "vite-plus/test";
import {
  assertAgentRuntimeMacosArtifactModes,
  assertAgentRuntimeMacosPlatformContract,
  parseLipoArchitectures,
  parseOtoolMinimumMacosVersion,
} from "./agent-runtime-macos-platform-contract";

const buildVersion = (minimum: string) => `
Load command 10
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos ${minimum}
      sdk 26.0
`;

const legacyVersion = (minimum: string) => `
Load command 9
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version ${minimum}
      sdk 13.3
`;

describe("Agent runtime macOS platform contract", () => {
  test("requires executable mode for every Mach-O closure artifact but not the manifest", () => {
    expect(() =>
      assertAgentRuntimeMacosArtifactModes([
        { artifactPath: "codex-package.json", executable: false },
        { artifactPath: "bin/codex-app-server", executable: true },
        { artifactPath: "bin/codex-code-mode-host", executable: true },
        { artifactPath: "codex-path/rg", executable: false },
        { artifactPath: "codex-resources/zsh/bin/zsh", executable: true },
      ]),
    ).toThrow("codex-path/rg");

    expect(() =>
      assertAgentRuntimeMacosArtifactModes([
        { artifactPath: "codex-package.json", executable: false },
        { artifactPath: "bin/codex-app-server", executable: true },
        { artifactPath: "bin/codex-code-mode-host", executable: true },
        { artifactPath: "codex-path/rg", executable: true },
        { artifactPath: "codex-resources/zsh/bin/zsh", executable: true },
      ]),
    ).not.toThrow();
  });

  test("parses thin architectures and both macOS load-command formats", () => {
    expect(parseLipoArchitectures("arm64\n")).toEqual(["arm64"]);
    expect(parseOtoolMinimumMacosVersion(buildVersion("15.0"))).toBe("15.0");
    expect(parseOtoolMinimumMacosVersion(legacyVersion("10.12"))).toBe("10.12");
  });

  test("accepts exact Nodex deployment targets and older bundled tools", () => {
    expect(() =>
      assertAgentRuntimeMacosPlatformContract({
        inspections: [
          {
            artifactPath: "bin/codex-app-server",
            lipoOutput: "arm64",
            otoolOutput: buildVersion("15.0"),
          },
          {
            artifactPath: "codex-path/rg",
            lipoOutput: "arm64",
            otoolOutput: legacyVersion("10.12"),
          },
        ],
        productMinimumMacos: "15.0",
        targetArch: "arm64",
      }),
    ).not.toThrow();
  });

  test("rejects universal or wrong-architecture payloads", () => {
    expect(() =>
      assertAgentRuntimeMacosPlatformContract({
        inspections: [
          {
            artifactPath: "bin/codex-app-server",
            lipoOutput: "x86_64 arm64",
            otoolOutput: buildVersion("15.0"),
          },
        ],
        productMinimumMacos: "15.0",
        targetArch: "arm64",
      }),
    ).toThrow("expected only arm64");
  });

  test("rejects tools newer than the product minimum and accepts upstream binaries built below it", () => {
    expect(() =>
      assertAgentRuntimeMacosPlatformContract({
        inspections: [
          {
            artifactPath: "codex-resources/zsh/bin/zsh",
            lipoOutput: "x86_64",
            otoolOutput: buildVersion("15.1"),
          },
        ],
        productMinimumMacos: "15.0",
        targetArch: "x64",
      }),
    ).toThrow("newer than the product minimum");

    expect(() =>
      assertAgentRuntimeMacosPlatformContract({
        inspections: [
          {
            artifactPath: "bin/codex-code-mode-host",
            lipoOutput: "x86_64",
            otoolOutput: buildVersion("14.0"),
          },
        ],
        productMinimumMacos: "15.0",
        targetArch: "x64",
      }),
    ).not.toThrow();
  });
});
