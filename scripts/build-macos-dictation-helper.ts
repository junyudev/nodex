import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  swiftTargetForNativeRuntime,
  type NativeRuntimeArchitecture,
} from "./native-runtime-manifest";

interface BuildStamp {
  readonly architecture: NativeRuntimeArchitecture;
  readonly minimumMacOS: "15.0";
  readonly protocolVersion: 3;
  readonly sourceSha256: string;
}

const parseOutputPath = (argv: readonly string[]): string => {
  const index = argv.indexOf("--out");
  const outputPath = index < 0 ? null : argv[index + 1];
  if (!outputPath || index + 2 !== argv.length) {
    throw new Error("usage: build-macos-dictation-helper --out <.generated/path>");
  }
  return outputPath;
};

const resolveArchitecture = (): NativeRuntimeArchitecture => {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch;
  throw new Error(`Unsupported macOS architecture: ${process.arch}`);
};

const readStamp = (pathname: string): BuildStamp | null => {
  try {
    return JSON.parse(readFileSync(pathname, "utf8")) as BuildStamp;
  } catch {
    return null;
  }
};

const main = (): void => {
  if (process.platform !== "darwin") return;
  const repositoryRoot = path.resolve(".");
  const outputPath = path.resolve(repositoryRoot, parseOutputPath(process.argv.slice(2)));
  const generatedRoot = path.join(repositoryRoot, ".generated");
  if (!outputPath.startsWith(`${generatedRoot}${path.sep}`)) {
    throw new Error("The dictation helper output must stay beneath .generated");
  }
  const sourcePath = path.join(repositoryRoot, "resources/macos/nodex-dictation-helper.swift");
  const stamp: BuildStamp = {
    architecture: resolveArchitecture(),
    minimumMacOS: "15.0",
    protocolVersion: 3,
    sourceSha256: createHash("sha256").update(readFileSync(sourcePath)).digest("hex"),
  };
  const stampPath = `${outputPath}.build.json`;
  const previous = readStamp(stampPath);
  if (
    existsSync(outputPath) &&
    previous?.architecture === stamp.architecture &&
    previous.minimumMacOS === stamp.minimumMacOS &&
    previous.protocolVersion === stamp.protocolVersion &&
    previous.sourceSha256 === stamp.sourceSha256
  ) {
    return;
  }
  const outputDirectory = path.dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  const temporaryDirectory = mkdtempSync(path.join(outputDirectory, ".nodex-dictation-helper-"));
  const temporaryBinary = path.join(temporaryDirectory, "helper");
  try {
    execFileSync(
      "xcrun",
      [
        "swiftc",
        "-O",
        "-parse-as-library",
        "-target",
        swiftTargetForNativeRuntime(stamp.architecture),
        sourcePath,
        "-o",
        temporaryBinary,
      ],
      { stdio: "inherit" },
    );
    chmodSync(temporaryBinary, 0o755);
    rmSync(outputPath, { force: true });
    renameSync(temporaryBinary, outputPath);
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o644 });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
};

main();
