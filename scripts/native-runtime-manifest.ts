import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type NativeRuntimeArchitecture = "arm64" | "x64";

export const swiftTargetForNativeRuntime = (
  architecture: NativeRuntimeArchitecture,
): "arm64-apple-macos15.0" | "x86_64-apple-macos15.0" =>
  architecture === "arm64" ? "arm64-apple-macos15.0" : "x86_64-apple-macos15.0";

export type NativeRuntimeBinaryName =
  | "nodex"
  | "nodex-appshot-helper"
  | "nodex-dictation-helper"
  | "nodex-browser-profile-helper"
  | "nodex-core"
  | "nodex-service";

export interface NativeRuntimeBinaryManifest {
  readonly bundlePath: string;
  readonly file: string;
  readonly name: NativeRuntimeBinaryName;
  readonly sourceSha256: string;
  readonly sourceSize: number;
}

export interface NativeRuntimeManifest {
  readonly binaries: readonly NativeRuntimeBinaryManifest[];
  readonly minimumMacOS: "15.0";
  readonly productVersion: string;
  readonly rustTarget: "aarch64-apple-darwin" | "x86_64-apple-darwin";
  readonly schemaVersion: 4;
  readonly targetArch: NativeRuntimeArchitecture;
  readonly targetPlatform: "darwin";
}

export const NATIVE_RUNTIME_BINARY_PATHS: Readonly<Record<NativeRuntimeBinaryName, string>> = {
  nodex: "Resources/bin/nodex",
  "nodex-appshot-helper": "Resources/bin/nodex-appshot-helper",
  "nodex-dictation-helper": "Resources/bin/nodex-dictation-helper",
  "nodex-browser-profile-helper": "Resources/bin/nodex-browser-profile-helper",
  "nodex-core": "Resources/bin/nodex-core",
  "nodex-service": "Helpers/Nodex Service.app/Contents/MacOS/nodex-service",
};

const EXPECTED_BINARY_NAMES = new Set<NativeRuntimeBinaryName>([
  "nodex",
  "nodex-appshot-helper",
  "nodex-dictation-helper",
  "nodex-browser-profile-helper",
  "nodex-core",
  "nodex-service",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (value: unknown, label: string): string => {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Invalid native runtime manifest ${label}`);
};

const requireBinaryName = (value: unknown): NativeRuntimeBinaryName => {
  const name = requireString(value, "binary name");
  if (EXPECTED_BINARY_NAMES.has(name as NativeRuntimeBinaryName)) {
    return name as NativeRuntimeBinaryName;
  }
  throw new Error(`Invalid native runtime binary name: ${name}`);
};

const parseBinary = (value: unknown): NativeRuntimeBinaryManifest => {
  if (!isObject(value)) throw new Error("Invalid native runtime binary entry");
  const name = requireBinaryName(value.name);
  const sourceSha256 = requireString(value.sourceSha256, `${name} sourceSha256`);
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw new Error(`Invalid native runtime ${name} sourceSha256`);
  }
  if (!Number.isSafeInteger(value.sourceSize) || (value.sourceSize as number) <= 0) {
    throw new Error(`Invalid native runtime ${name} sourceSize`);
  }
  const bundlePath = requireString(value.bundlePath, `${name} bundlePath`);
  if (bundlePath !== NATIVE_RUNTIME_BINARY_PATHS[name]) {
    throw new Error(`Invalid native runtime ${name} bundlePath`);
  }
  return {
    bundlePath,
    file: requireString(value.file, `${name} file`),
    name,
    sourceSha256,
    sourceSize: value.sourceSize as number,
  };
};

export function parseNativeRuntimeManifest(value: unknown): NativeRuntimeManifest {
  if (!isObject(value)) throw new Error("Invalid native runtime manifest");
  if (value.schemaVersion !== 4) {
    throw new Error("Unsupported native runtime manifest schema");
  }
  if (value.targetPlatform !== "darwin") {
    throw new Error("Unsupported native runtime target platform");
  }
  if (value.targetArch !== "arm64" && value.targetArch !== "x64") {
    throw new Error("Unsupported native runtime target architecture");
  }
  const expectedRustTarget =
    value.targetArch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (value.rustTarget !== expectedRustTarget) {
    throw new Error("Native runtime Rust target does not match its architecture");
  }
  if (value.minimumMacOS !== "15.0") {
    throw new Error("Native runtime minimum macOS must be 15.0");
  }
  const productVersion = requireString(value.productVersion, "productVersion");
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.\d{8}\.[1-9]\d*)?$/.test(productVersion)
  ) {
    throw new Error("Native runtime productVersion must be a release semantic version");
  }
  if (!Array.isArray(value.binaries)) {
    throw new Error("Invalid native runtime binary inventory");
  }
  const binaries = value.binaries.map(parseBinary);
  const names = new Set(binaries.map(({ name }) => name));
  if (
    names.size !== EXPECTED_BINARY_NAMES.size ||
    [...EXPECTED_BINARY_NAMES].some((name) => !names.has(name))
  ) {
    throw new Error("Native runtime manifest must contain each required binary exactly once");
  }
  return {
    binaries,
    minimumMacOS: "15.0",
    productVersion,
    rustTarget: expectedRustTarget,
    schemaVersion: 4,
    targetArch: value.targetArch,
    targetPlatform: "darwin",
  };
}

export const readNativeRuntimeManifest = (manifestPath: string): NativeRuntimeManifest => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`Invalid native runtime manifest at ${manifestPath}`);
  }
  return parseNativeRuntimeManifest(value);
};

export const sha256File = (filePath: string): string =>
  createHash("sha256").update(readFileSync(filePath)).digest("hex");
