import type {
  AntigravityRuntimeInspection,
  AntigravityRuntimeOperation,
} from "./antigravity-runtime";

export const managedAntigravityExecutable = {
  executablePath: "/test/antigravity/versions/latest/agy",
  source: "managed",
  version: "1.5.13",
  managedVersionDirectory: "/test/antigravity/versions/latest",
} satisfies AntigravityRuntimeInspection["managed"];

export function antigravityInspection(
  overrides: Partial<AntigravityRuntimeInspection> = {},
): AntigravityRuntimeInspection {
  return {
    driver: "antigravity",
    runtimeGeneration: "generation1",
    platform: { os: "darwin", arch: "arm64", supported: true },
    managedDirectory: "/test/antigravity",
    managed: null,
    managedIssue: null,
    path: null,
    instances: [],
    compatibility: null,
    managedLock: "clear",
    leaseScope: "runtime",
    minimumVersion: "1.5.0",
    recommendedVersion: null,
    recommendedRange: null,
    supportedRanges: [],
    latestKnownVersion: null,
    updateAvailable: null,
    leaseCount: 0,
    inUse: false,
    installing: false,
    canRemove: false,
    removalBlockedBy: [],
    ...overrides,
  };
}

export function antigravityOperation(
  overrides: Partial<AntigravityRuntimeOperation> = {},
): AntigravityRuntimeOperation {
  return {
    driver: "antigravity",
    kind: "install",
    operationId: "operation1",
    runtimeGeneration: "generation1",
    revision: 1,
    phase: "running",
    result: null,
    error: null,
    cancellable: true,
    ...overrides,
  };
}
