import { ownerOfTest, nativeRequirements, suiteConfig } from "../../config/test-suites.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APP_TEST_SUITES,
  assertCiGatePlan,
  STATIC_GROUPS,
  type AppTestSuite,
  type CiGatePlan,
  type DependencyKind,
  type StaticGroup,
} from "./ci-gate-plan.ts";

export type { AppTestSuite, CiGatePlan, DependencyKind, StaticGroup } from "./ci-gate-plan.ts";

const RELEASE_PATHS = new Set(["Cargo.lock", "Cargo.toml", "CHANGELOG.md", "package.json"]);

const isDocumentationPath = (path: string): boolean =>
  path === "AGENTS.md" || path === "CONTEXT.md" || path.endsWith(".md") || path.startsWith("docs/");

const isLandingPath = (path: string): boolean =>
  path.startsWith("packages/landing/") || path === ".github/workflows/deploy-landing-site.yml";

const isRendererPath = (path: string): boolean =>
  path.startsWith("src/renderer/") ||
  path.startsWith("packages/storybook/") ||
  path.startsWith("src/shared/") ||
  path.startsWith("config/renderer-") ||
  path.startsWith("vitest.renderer") ||
  path.startsWith("vitest.browser");

const isElectronMainPath = (path: string): boolean =>
  path.startsWith("src/main/") ||
  path.startsWith("src/preload/") ||
  path === "electron.vite.config.ts" ||
  path === "electron-builder.yml" ||
  path.startsWith("scripts/scenarios/");

const isRustPath = (path: string): boolean =>
  path === "Cargo.toml" ||
  path === "Cargo.lock" ||
  path === "rust-toolchain.toml" ||
  path.startsWith("crates/");

const isMigrationPath = (path: string): boolean =>
  path === "crates/nodex-core/src/infrastructure/migration.rs" ||
  path.startsWith("crates/nodex-core/schema/") ||
  path.startsWith("crates/nodex-store-format/");

const isProtocolPath = (path: string): boolean =>
  path.startsWith("crates/nodex-core-contracts/") ||
  path.startsWith("crates/nodex-core-protocol/") ||
  path.startsWith("packages/codex-app-server-protocol/") ||
  path.startsWith("packages/core-protocol/") ||
  path.startsWith("src/shared/core-") ||
  path.startsWith("src/shared/codex-") ||
  path.startsWith("src/main/core-client/");

const isGeneratedResourcePath = (path: string): boolean =>
  path === "scripts/build-resources.ts" ||
  path === "scripts/generate-third-party-notices.ts" ||
  path === "src/shared/build-resources.ts" ||
  path.startsWith("resources/");

const isKnownAppPath = (path: string): boolean =>
  path.startsWith("src/") ||
  path.startsWith("packages/") ||
  path.startsWith("third_party/") ||
  path.startsWith("scripts/") ||
  path.startsWith("resources/") ||
  path.startsWith("crates/") ||
  path.startsWith(".config/") ||
  path.startsWith("playwright") ||
  path.startsWith("tests/e2e/") ||
  path.startsWith("vitest") ||
  path.startsWith("tsconfig") ||
  path === "electron.vite.config.ts" ||
  path === "electron-builder.yml" ||
  path === "pnpm-workspace.yaml";

const isGitHubPath = (path: string): boolean => path.startsWith(".github/");

const isRustDependencyPath = (path: string): boolean =>
  path === "Cargo.lock" || path === "Cargo.toml" || /^crates\/[^/]+\/Cargo\.toml$/u.test(path);

const isJavaScriptDependencyPath = (path: string): boolean =>
  path === "package.json" ||
  path === "pnpm-lock.yaml" ||
  /^(?:packages|third_party\/blocknote\/packages)\/[^/]+\/package\.json$/u.test(path);

const isStressTestPath = (path: string): boolean => path.includes(".stress.");

const owningTestSuite = (path: string): AppTestSuite | undefined => {
  const owner = ownerOfTest(path);
  return owner?.tier === "default" ? owner.suite : undefined;
};

const nativeTestSuites = APP_TEST_SUITES.filter((suite) => nativeRequirements(suite).length > 0);

// Rust and fixture files are external inputs that Vitest's module graph cannot follow.
const isNativeTestInput = (path: string): boolean =>
  isRustPath(path) ||
  isRustDependencyPath(path) ||
  path.startsWith(".cargo/") ||
  path.startsWith("rust-toolchain") ||
  path.startsWith("crates/nodex-core/tests/fixtures/");

const requiresFullTests = (paths: readonly string[]): boolean =>
  paths.some(
    (path) =>
      path === "package.json" ||
      path === "pnpm-lock.yaml" ||
      path === "pnpm-workspace.yaml" ||
      path === "electron.vite.config.ts" ||
      path.startsWith("config/") ||
      path.startsWith("scripts/ci/") ||
      path.startsWith("scripts/testing/") ||
      path === "scripts/tooling/process.ts" ||
      isNativeTestInput(path) ||
      path === "src/renderer/test/setup.ts" ||
      path === "src/renderer/test/setup-browser.ts" ||
      path.startsWith("tsconfig") ||
      path.startsWith("vitest"),
  );

const testSuitesForPaths = (paths: readonly string[]): readonly AppTestSuite[] => {
  const selected = new Set<AppTestSuite>();
  const add = (...suites: readonly AppTestSuite[]): void => {
    for (const suite of suites) selected.add(suite);
  };
  for (const path of paths) {
    if (isStressTestPath(path) || path.startsWith("tests/e2e/")) continue;
    const testSuite = owningTestSuite(path);
    if (testSuite) {
      add(testSuite);
      continue;
    }
    if (path === "src/renderer/test/setup-browser.ts") {
      add("browser");
      continue;
    }
    if (path === "src/renderer/test/setup.ts") {
      add("renderer");
      continue;
    }
    if (isNativeTestInput(path)) {
      add(...nativeTestSuites);
      continue;
    }
    if (path.startsWith("src/shared/")) {
      add(...APP_TEST_SUITES);
      continue;
    }
    if (path.startsWith("src/main/core-client/")) {
      add("core-client", "main", "integration");
      continue;
    }
    if (path.startsWith("src/main/") || path.startsWith("src/preload/")) {
      add("core-client", "main", "integration");
      continue;
    }
    if (path.startsWith("src/renderer/")) {
      add("unit", "renderer", "browser");
      continue;
    }
    if (path.startsWith("packages/effect-codex-app-server/")) {
      add("effect-codex", "core-client", "main", "integration");
      continue;
    }
    if (path.startsWith("packages/landing/")) {
      add("unit", "renderer");
      continue;
    }
    if (path.startsWith("packages/") || path.startsWith("third_party/")) {
      add("unit", "renderer", "browser");
      continue;
    }
    if (path === "electron.vite.config.ts" || path === "electron-builder.yml") {
      add("main", "integration");
      continue;
    }
    if (path.startsWith("vitest.")) {
      add(...APP_TEST_SUITES.filter((suite) => suiteConfig(suite) === path));
      continue;
    }
    if (
      path === "config/test-suites.ts" ||
      path.startsWith("scripts/testing/") ||
      path === "scripts/tooling/process.ts"
    ) {
      add(...APP_TEST_SUITES);
      continue;
    }
    if (path.startsWith("config/vitest-") || path === "config/electron-test-runtime.ts") {
      add(...APP_TEST_SUITES);
      continue;
    }
    if (path.startsWith("config/renderer-")) {
      add("unit", "renderer", "browser");
      continue;
    }
    if (path.startsWith("tsconfig")) {
      add(...APP_TEST_SUITES);
      continue;
    }
    if (path.startsWith("config/") || path.startsWith("scripts/")) {
      add("unit");
    }
  }
  return APP_TEST_SUITES.filter((suite) => selected.has(suite));
};

const dependencyKindFor = (paths: readonly string[]): DependencyKind => {
  if (paths.length === 0) return "source";
  if (paths.every(isGitHubPath)) return "github-actions";
  if (paths.every(isRustDependencyPath)) return "rust";
  if (!paths.every(isJavaScriptDependencyPath)) return "none";
  return paths.some((path) => path.startsWith("third_party/blocknote/")) ? "editor" : "javascript";
};

const normalizePath = (value: string): string => {
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`Changed path is invalid: ${JSON.stringify(value)}.`);
  }
  return path.replace(/^\.\//u, "");
};

const createPlan = (overrides: Partial<CiGatePlan>): CiGatePlan => {
  const candidate: CiGatePlan = {
    allGates: false,
    appTestSuites: [],
    dependencyKind: "none",
    docsOnly: false,
    landingOnly: false,
    protocolContracts: false,
    relatedPaths: [],
    releaseTransition: false,
    rustFast: false,
    rustFull: false,
    rustMigration: false,
    staticGroups: [],
    testMode: "none",
    ...overrides,
  };
  assertCiGatePlan(candidate);
  return candidate;
};

const allGatesPlan = (dependencyKind: DependencyKind, allGates = true): CiGatePlan =>
  createPlan({
    allGates,
    appTestSuites: APP_TEST_SUITES,
    dependencyKind,
    protocolContracts: true,
    rustFast: true,
    rustFull: true,
    rustMigration: true,
    staticGroups: STATIC_GROUPS,
    testMode: "full",
  });

const githubWorkflowPlan = (paths: readonly string[]): CiGatePlan => {
  const appTests = paths.includes(".github/workflows/_app-tests.yml");
  const rustChecks = paths.includes(".github/workflows/_rust-checks.yml");
  const staticGroups = paths.includes(".github/workflows/_static-checks.yml")
    ? STATIC_GROUPS
    : (["ci-contracts"] as const);
  return createPlan({
    appTestSuites: appTests ? APP_TEST_SUITES : [],
    dependencyKind: "github-actions",
    protocolContracts: rustChecks,
    rustFast: rustChecks,
    rustFull: rustChecks,
    rustMigration: rustChecks,
    staticGroups,
    testMode: appTests ? "full" : "none",
  });
};

const githubActionPlan = (paths: readonly string[]): CiGatePlan => {
  if (paths.every((path) => path.startsWith(".github/workflows/"))) {
    return githubWorkflowPlan(paths);
  }
  if (paths.every((path) => path.startsWith(".github/actions/run-stress-tests/"))) {
    return createPlan({
      dependencyKind: "github-actions",
      staticGroups: ["ci-contracts"],
    });
  }
  if (paths.every((path) => path.startsWith(".github/actions/setup-playwright/"))) {
    return createPlan({
      appTestSuites: ["browser"],
      dependencyKind: "github-actions",
      staticGroups: ["ci-contracts"],
      testMode: "full",
    });
  }
  if (paths.every((path) => path.startsWith(".github/actions/setup-rust-ci/"))) {
    return createPlan({
      dependencyKind: "github-actions",
      protocolContracts: true,
      rustFast: true,
      rustFull: true,
      rustMigration: true,
      staticGroups: ["ci-contracts", "repository-contracts"],
    });
  }
  return allGatesPlan("github-actions");
};

const sourcePlan = (
  paths: readonly string[],
  dependencyKind: DependencyKind,
  fullTests: boolean,
): CiGatePlan => {
  const renderer = paths.some(isRendererPath);
  const electronMain = paths.some(isElectronMainPath);
  const rust = paths.some(isRustPath);
  const migration = paths.some(isMigrationPath);
  const protocol = paths.some(isProtocolPath);
  const appTestSuites = testSuitesForPaths(paths);
  const staticGroups = new Set<StaticGroup>(["types"]);
  if (renderer) staticGroups.add("ui-contracts");
  if (electronMain || rust || protocol) staticGroups.add("repository-contracts");
  if (paths.some(isGeneratedResourcePath)) staticGroups.add("generated");
  if (
    paths.some(
      (path) =>
        path.startsWith("config/") ||
        path.startsWith("vitest.") ||
        path.startsWith("scripts/testing/") ||
        /\.(?:test|integration)\.[cm]?[jt]sx?$/u.test(path),
    )
  ) {
    staticGroups.add("ci-contracts");
  }
  return createPlan({
    appTestSuites,
    dependencyKind,
    protocolContracts: protocol,
    rustFast: rust,
    rustMigration: migration,
    staticGroups: [...staticGroups],
    testMode: appTestSuites.length === 0 ? "none" : fullTests ? "full" : "related",
    relatedPaths: appTestSuites.length > 0 && !fullTests ? paths : [],
  });
};

export function classifyChangedPaths(
  changedPaths: readonly string[],
  options: { readonly full?: boolean; readonly forceFullTests?: boolean } = {},
): CiGatePlan {
  const paths = [...new Set(changedPaths.map(normalizePath))];
  if (options.full || paths.length === 0) return allGatesPlan("source");

  const releaseTransition =
    paths.length === RELEASE_PATHS.size && [...RELEASE_PATHS].every((path) => paths.includes(path));
  if (releaseTransition) return createPlan({ releaseTransition: true });

  if (paths.every(isDocumentationPath)) return createPlan({ docsOnly: true });
  const landingOnly =
    paths.some(isLandingPath) &&
    paths.every((path) => isLandingPath(path) || isDocumentationPath(path));
  if (landingOnly)
    return createPlan({
      landingOnly: true,
      staticGroups: paths.some((path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path))
        ? ["ci-contracts", "landing"]
        : ["landing"],
      appTestSuites: ["unit", "renderer"],
      testMode: options.forceFullTests ? "full" : "related",
      relatedPaths: options.forceFullTests ? [] : paths.filter(isLandingPath),
    });
  const executablePaths = paths.filter((path) => !isDocumentationPath(path));

  const ciScriptsOnly = executablePaths.every((path) => path.startsWith("scripts/ci/"));
  if (ciScriptsOnly) {
    return createPlan({
      appTestSuites: ["unit"],
      dependencyKind: "source",
      staticGroups: ["types", "ci-contracts"],
      testMode: "full",
    });
  }

  const dependencyKind = dependencyKindFor(executablePaths);
  if (dependencyKind === "github-actions") return githubActionPlan(executablePaths);
  if (dependencyKind === "javascript" || dependencyKind === "editor") {
    return allGatesPlan(dependencyKind, false);
  }
  if (dependencyKind === "rust") {
    return createPlan({
      appTestSuites: nativeTestSuites,
      testMode: "full",
      dependencyKind,
      protocolContracts: true,
      rustFast: true,
      rustFull: true,
      rustMigration: true,
      staticGroups: ["repository-contracts", "generated"],
    });
  }

  const hasUnknownPath = executablePaths.some(
    (path) =>
      !isDocumentationPath(path) &&
      !isLandingPath(path) &&
      !isKnownAppPath(path) &&
      !RELEASE_PATHS.has(path),
  );
  if (hasUnknownPath) {
    return allGatesPlan(dependencyKind === "none" ? "source" : dependencyKind);
  }
  return sourcePlan(
    executablePaths,
    dependencyKind,
    options.forceFullTests || requiresFullTests(executablePaths),
  );
}

export function buildChangeClassificationDocument(
  changedPaths: readonly string[],
  options: { readonly full?: boolean; readonly forceFullTests?: boolean } = {},
): {
  readonly changedPaths: readonly string[];
  readonly plan: CiGatePlan;
} {
  const plan = classifyChangedPaths(changedPaths, options);
  return {
    // Full Rust gates never use an affected-path closure. Keeping a repo-wide
    // list out of reusable job environments also keeps every subprocess below
    // the host operating system's ARG_MAX limit.
    changedPaths: plan.rustFull ? [] : changedPaths,
    plan,
  };
}

const readOption = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
};

const main = (): void => {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const base = readOption(args, "--base");
  const head = readOption(args, "--head") ?? "HEAD";
  if (!base && !full) {
    throw new Error(
      "Usage: classify-change --base <sha> [--head <sha>] [--full] [--output <path>].",
    );
  }
  const cwd = resolve(import.meta.dirname, "../..");
  const paths = full
    ? []
    : execFileSync("git", ["diff", "--name-only", "-z", `${base}..${head}`], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
        .split("\0")
        .filter(Boolean);
  const forceFullTests = paths.some(
    (path) => !isDocumentationPath(path) && !existsSync(resolve(cwd, path)),
  );
  const document = buildChangeClassificationDocument(paths, {
    forceFullTests,
    full,
  });
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  const destination = readOption(args, "--output");
  if (!destination) {
    process.stdout.write(serialized);
    return;
  }
  const outputPath = resolve(destination);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, "utf8");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
