import {
  APP_TEST_SUITES,
  isNativeExecutable,
  nativeRequirements,
  type SuiteId as AppTestSuite,
} from "../../config/test-suites.ts";

export const STATIC_GROUPS = [
  "types",
  "source-ownership",
  "ui-contracts",
  "startup-bundles",
  "ci-contracts",
  "repository-contracts",
  "tooling-contracts",
  "dependency-security",
  "generated",
  "landing",
] as const;

export type StaticGroup = (typeof STATIC_GROUPS)[number];

export const DRAFT_STATIC_GROUPS: readonly StaticGroup[] = ["source-ownership", "ci-contracts"];

export { APP_TEST_SUITES } from "../../config/test-suites.ts";
export type { SuiteId as AppTestSuite } from "../../config/test-suites.ts";

export const TEST_SELECTION_MODES = ["none", "related", "full"] as const;

export type TestSelectionMode = (typeof TEST_SELECTION_MODES)[number];

export type DependencyKind =
  | "editor"
  | "github-actions"
  | "javascript"
  | "none"
  | "rust"
  | "source";

export interface CiGatePlan {
  readonly allGates: boolean;
  readonly appTestSuites: readonly AppTestSuite[];
  readonly dependencyKind: DependencyKind;
  readonly docsOnly: boolean;
  readonly draft: boolean;
  readonly landingOnly: boolean;
  readonly protocolContracts: boolean;
  readonly relatedPaths: readonly string[];
  readonly rustFast: boolean;
  readonly rustFull: boolean;
  readonly staticGroups: readonly StaticGroup[];
  readonly testMode: TestSelectionMode;
  readonly windowsChecks: boolean;
}

const PLAN_KEYS = [
  "allGates",
  "appTestSuites",
  "dependencyKind",
  "docsOnly",
  "draft",
  "landingOnly",
  "protocolContracts",
  "relatedPaths",
  "rustFast",
  "rustFull",
  "staticGroups",
  "testMode",
  "windowsChecks",
] as const satisfies readonly (keyof CiGatePlan)[];

const DEPENDENCY_KINDS = new Set<DependencyKind>([
  "editor",
  "github-actions",
  "javascript",
  "none",
  "rust",
  "source",
]);

const TEST_SELECTION_MODE_VALUES = new Set<TestSelectionMode>(TEST_SELECTION_MODES);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (value: Readonly<Record<string, unknown>>): void => {
  const expected = new Set<string>(PLAN_KEYS);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = PLAN_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0)
    throw new Error(`CI gate plan has unknown fields: ${unknown.join(", ")}.`);
  if (missing.length > 0) throw new Error(`CI gate plan is missing fields: ${missing.join(", ")}.`);
};

function assertBoolean(value: unknown, name: keyof CiGatePlan): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`CI gate plan ${name} must be boolean.`);
}

function assertEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: keyof CiGatePlan,
): asserts value is readonly T[] {
  const allowedValues = new Set<string>(allowed);
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string" && allowedValues.has(entry))
  ) {
    throw new Error(`CI gate plan ${name} contains an unsupported value.`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`CI gate plan ${name} must not contain duplicates.`);
  }
}

const hasOrdinaryGates = (plan: CiGatePlan): boolean =>
  plan.staticGroups.length > 0 ||
  plan.appTestSuites.length > 0 ||
  plan.protocolContracts ||
  plan.rustFast ||
  plan.windowsChecks;

const assertRelatedPaths: (value: unknown) => asserts value is readonly string[] = (value) => {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        !entry.startsWith("/") &&
        !/[\r\n]/u.test(entry) &&
        !entry.split("/").includes(".."),
    )
  ) {
    throw new Error("CI gate plan relatedPaths must contain safe repository-relative paths.");
  }
  if (new Set(value).size !== value.length) {
    throw new Error("CI gate plan relatedPaths must not contain duplicates.");
  }
};

export function assertCiGatePlan(value: unknown): asserts value is CiGatePlan {
  if (!isRecord(value)) throw new Error("CI gate plan must be an object.");
  assertExactKeys(value);
  for (const key of [
    "allGates",
    "docsOnly",
    "draft",
    "landingOnly",
    "protocolContracts",
    "rustFast",
    "rustFull",
    "windowsChecks",
  ] as const) {
    assertBoolean(value[key], key);
  }
  assertEnumArray(value.appTestSuites, APP_TEST_SUITES, "appTestSuites");
  assertEnumArray(value.staticGroups, STATIC_GROUPS, "staticGroups");
  assertRelatedPaths(value.relatedPaths);
  if (
    typeof value.dependencyKind !== "string" ||
    !DEPENDENCY_KINDS.has(value.dependencyKind as DependencyKind)
  ) {
    throw new Error("CI gate plan dependencyKind is unsupported.");
  }
  if (
    typeof value.testMode !== "string" ||
    !TEST_SELECTION_MODE_VALUES.has(value.testMode as TestSelectionMode)
  ) {
    throw new Error("CI gate plan testMode is unsupported.");
  }
  const candidate = value as unknown as CiGatePlan;
  if (candidate.rustFull && !candidate.rustFast) {
    throw new Error("Full Rust selection requires the Rust fast lanes.");
  }
  if (
    candidate.draft &&
    (candidate.allGates ||
      candidate.testMode !== "none" ||
      candidate.protocolContracts ||
      candidate.rustFast ||
      candidate.windowsChecks ||
      candidate.staticGroups.some((group) => !DRAFT_STATIC_GROUPS.includes(group)))
  ) {
    throw new Error("Draft plans may select only cheap static contracts.");
  }
  const narrowModes = [candidate.docsOnly, candidate.landingOnly].filter(Boolean);
  if (narrowModes.length > 1) throw new Error("CI gate plan narrow modes are mutually exclusive.");
  if (candidate.docsOnly && hasOrdinaryGates(candidate)) {
    throw new Error("Docs-only plans must not select ordinary gates.");
  }
  if (
    candidate.testMode === "none" &&
    (candidate.appTestSuites.length > 0 || candidate.relatedPaths.length > 0)
  ) {
    throw new Error("A test-free plan must not select test suites or related paths.");
  }
  if (
    candidate.testMode === "related" &&
    (candidate.appTestSuites.length === 0 || candidate.relatedPaths.length === 0)
  ) {
    throw new Error("Related test selection requires suites and changed paths.");
  }
  if (
    candidate.testMode === "full" &&
    (candidate.appTestSuites.length === 0 || candidate.relatedPaths.length > 0)
  ) {
    throw new Error("Full test selection requires suites and no related paths.");
  }
  if (
    candidate.landingOnly &&
    ((!candidate.draft && !candidate.staticGroups.includes("landing")) ||
      candidate.staticGroups.some(
        (group) =>
          group !== "landing" &&
          group !== "types" &&
          group !== "tooling-contracts" &&
          group !== "ci-contracts" &&
          group !== "source-ownership" &&
          group !== "repository-contracts",
      ) ||
      candidate.appTestSuites.some((suite) => suite !== "unit" && suite !== "renderer") ||
      candidate.protocolContracts ||
      candidate.rustFast ||
      candidate.windowsChecks)
  ) {
    throw new Error(
      "Landing-only plans may select landing, types, source ownership, CI, repository and tooling contracts, and unit/renderer tests.",
    );
  }
}

export const parseCiGatePlan = (value: unknown): CiGatePlan => {
  assertCiGatePlan(value);
  return value;
};

export const requiredJobIdsForGatePlan = (plan: CiGatePlan): readonly string[] => {
  const jobs: string[] = [];
  if (plan.staticGroups.length > 0) jobs.push("static-contracts");
  if (plan.appTestSuites.length > 0) jobs.push("app-tests");
  if (plan.rustFast || plan.protocolContracts) jobs.push("rust-checks");
  if (plan.windowsChecks) jobs.push("windows-checks");
  return jobs;
};

const APP_SHARD_COUNTS = {
  unit: 2,
  "effect-codex": 1,
  "agent-runtime": 2,
  "core-client": 2,
  main: 1,
  renderer: 2,
  integration: 1,
  browser: 3,
} as const satisfies Record<AppTestSuite, number>;

export function appShardCount(suite: AppTestSuite): number {
  return APP_SHARD_COUNTS[suite];
}

export interface AppTestSegment {
  readonly suite: AppTestSuite;
  readonly shard: number;
}

const segmentId = ({ suite, shard }: AppTestSegment) =>
  appShardCount(suite) === 1 ? suite : `${suite}-${shard + 1}`;

// Start longer non-browser segments first. Prefer sharing native build setup when pairing.
const APP_LANE_ORDER = [
  "renderer",
  "core-client",
  "agent-runtime",
  "unit",
  "main",
  "integration",
  "effect-codex",
] as const satisfies readonly AppTestSuite[];

export function cachedAppLanes(plan: CiGatePlan): ReadonlyMap<string, readonly AppTestSegment[]> {
  const segments = APP_LANE_ORDER.filter((suite) => plan.appTestSuites.includes(suite)).flatMap(
    (suite) => Array.from({ length: appShardCount(suite) }, (_, shard) => ({ suite, shard })),
  );
  const hasBrowser = plan.appTestSuites.includes("browser");
  const slots = plan.appTestSuites.length - Number(hasBrowser);
  const lanes: AppTestSegment[][] = segments.slice(0, slots).map((segment) => [segment]);
  const native = (suite: AppTestSuite) =>
    nativeRequirements(suite, undefined, "linux").some(isNativeExecutable);
  for (const companion of segments.slice(slots)) {
    const available = lanes.filter((lane) => lane.length === 1);
    const paired =
      available.findLast(
        ([primary]) =>
          primary.suite !== companion.suite && native(primary.suite) === native(companion.suite),
      ) ?? available.at(-1);
    if (!paired) throw new Error("Application CI exceeds its suite-job budget.");
    paired.push(companion);
  }
  // Browser shards are the longest lanes and each owns a distinct result cache.
  if (hasBrowser) {
    const browserLanes = Array.from({ length: appShardCount("browser") }, (_, shard) => [
      { suite: "browser" as const, shard },
    ]);
    lanes.unshift(...browserLanes);
  }
  return new Map(lanes.map((lane) => [lane.map(segmentId).join("+"), lane]));
}

export function parseCachedAppLaneIds(value: unknown, plan: CiGatePlan): readonly string[] {
  const expected = [...cachedAppLanes(plan).keys()];
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    !value.every((lane, index) => lane === expected[index])
  ) {
    throw new Error("Application CI matrix must cover every selected suite and shard.");
  }
  return expected;
}
