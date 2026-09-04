import { APP_TEST_SUITES, type SuiteId as AppTestSuite } from "../../config/test-suites.ts";

export const STATIC_GROUPS = [
  "types",
  "ui-contracts",
  "ci-contracts",
  "repository-contracts",
  "generated",
  "landing",
] as const;

export type StaticGroup = (typeof STATIC_GROUPS)[number];

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
  readonly landingOnly: boolean;
  readonly protocolContracts: boolean;
  readonly relatedPaths: readonly string[];
  readonly releaseTransition: boolean;
  readonly rustFast: boolean;
  readonly rustFull: boolean;
  readonly rustMigration: boolean;
  readonly staticGroups: readonly StaticGroup[];
  readonly testMode: TestSelectionMode;
}

const PLAN_KEYS = [
  "allGates",
  "appTestSuites",
  "dependencyKind",
  "docsOnly",
  "landingOnly",
  "protocolContracts",
  "relatedPaths",
  "releaseTransition",
  "rustFast",
  "rustFull",
  "rustMigration",
  "staticGroups",
  "testMode",
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
  plan.rustMigration;

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
    "landingOnly",
    "protocolContracts",
    "releaseTransition",
    "rustFast",
    "rustFull",
    "rustMigration",
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
  const narrowModes = [
    candidate.docsOnly,
    candidate.landingOnly,
    candidate.releaseTransition,
  ].filter(Boolean);
  if (narrowModes.length > 1) throw new Error("CI gate plan narrow modes are mutually exclusive.");
  if ((candidate.docsOnly || candidate.releaseTransition) && hasOrdinaryGates(candidate)) {
    throw new Error("Docs-only and release-transition plans must not select ordinary gates.");
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
    (!candidate.staticGroups.includes("landing") ||
      candidate.staticGroups.some((group) => group !== "landing" && group !== "ci-contracts") ||
      candidate.appTestSuites.some((suite) => suite !== "unit" && suite !== "renderer") ||
      candidate.protocolContracts ||
      candidate.rustFast ||
      candidate.rustMigration)
  ) {
    throw new Error("Landing-only plans may select landing/CI contracts and unit/renderer tests.");
  }
}

export const parseCiGatePlan = (value: unknown): CiGatePlan => {
  assertCiGatePlan(value);
  return value;
};

export const requiredJobIdsForGatePlan = (plan: CiGatePlan): readonly string[] => {
  if (plan.releaseTransition) return ["release-transition"];
  const jobs: string[] = [];
  if (plan.staticGroups.length > 0) jobs.push("static-contracts");
  if (plan.appTestSuites.length > 0) jobs.push("app-tests");
  if (plan.rustFast || plan.protocolContracts || plan.rustMigration) jobs.push("rust-checks");
  return jobs;
};
