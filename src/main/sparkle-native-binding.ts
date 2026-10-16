import { createRequire } from "node:module";
import path from "node:path";

import type { MacAppUpdaterCheckKind, MacAppUpdaterEvent } from "./mac-app-updater";

interface SparkleNativeBinding {
  readonly checkForUpdates: (kind: MacAppUpdaterCheckKind) => void;
  readonly dispose: () => void;
  readonly initialize: (
    options: {
      readonly applicationBundlePath: string;
      readonly feedUrl: string;
      readonly hostBundlePath: string;
    },
    emit: (event: unknown) => void,
  ) => { readonly architecture: "arm64"; readonly sparkleVersion: string };
  readonly installDownloadedUpdate: () => void;
  readonly setFeedUrl: (feedUrl: string) => void;
}

const requireFromMain = createRequire(import.meta.url);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: Record<string, unknown>, key: string): string | undefined =>
  typeof value[key] === "string" ? value[key] : undefined;

const requiredString = (value: Record<string, unknown>, key: string): string => {
  const result = optionalString(value, key);
  if (result !== undefined) return result;
  throw new Error(`Sparkle native event ${key} must be a string.`);
};

const nullableByteCount = (value: unknown, label: string): number | null => {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(`Sparkle native event ${label} must be a non-negative byte count or null.`);
};

export function parseSparkleNativeEvent(value: unknown): MacAppUpdaterEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Sparkle native event must be an object with a type.");
  }
  switch (value.type) {
    case "check-started":
      if (value.kind !== "background" && value.kind !== "user") {
        throw new Error("Sparkle native check kind is invalid.");
      }
      return { kind: value.kind, type: value.type };
    case "update-found":
    case "update-ready":
      return {
        buildVersion: requiredString(value, "buildVersion"),
        ...(optionalString(value, "releaseDate")
          ? { releaseDate: optionalString(value, "releaseDate") }
          : {}),
        ...(optionalString(value, "releaseName")
          ? { releaseName: optionalString(value, "releaseName") }
          : {}),
        ...(optionalString(value, "releaseNotes")
          ? { releaseNotes: optionalString(value, "releaseNotes") }
          : {}),
        type: value.type,
        version: requiredString(value, "version"),
      };
    case "download-started":
      return {
        expectedBytes: nullableByteCount(value.expectedBytes, "expectedBytes"),
        type: value.type,
      };
    case "download-progress":
      return {
        expectedBytes: nullableByteCount(value.expectedBytes, "expectedBytes"),
        receivedBytes: nullableByteCount(value.receivedBytes, "receivedBytes") ?? 0,
        type: value.type,
      };
    case "installing":
      return { type: value.type };
    case "up-to-date":
      return { type: value.type, version: requiredString(value, "version") };
    case "error":
      if (typeof value.recoverable !== "boolean") {
        throw new Error("Sparkle native error recoverable must be a boolean.");
      }
      return {
        code: requiredString(value, "code"),
        message: requiredString(value, "message"),
        recoverable: value.recoverable,
        type: value.type,
      };
    default:
      throw new Error(`Unsupported Sparkle native event: ${value.type}`);
  }
}

export function loadSparkleNativeBinding(resourcesPath: string): SparkleNativeBinding {
  const bindingPath = path.join(resourcesPath, "native", "nodex-sparkle.node");
  const candidate = requireFromMain(bindingPath) as unknown;
  if (
    !isRecord(candidate) ||
    typeof candidate.initialize !== "function" ||
    typeof candidate.checkForUpdates !== "function" ||
    typeof candidate.installDownloadedUpdate !== "function" ||
    typeof candidate.setFeedUrl !== "function" ||
    typeof candidate.dispose !== "function"
  ) {
    throw new Error("Packaged Sparkle native binding has an unsupported API.");
  }
  return candidate as unknown as SparkleNativeBinding;
}
