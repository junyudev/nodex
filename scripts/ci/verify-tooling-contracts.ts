import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

interface LintDiagnostic {
  readonly code?: string;
  readonly filename: string;
  readonly severity: "error" | "warning";
}

interface LintReport {
  readonly diagnostics: readonly LintDiagnostic[];
}

interface ExpectedDiagnostic {
  readonly code: string;
  readonly count?: number;
  readonly filename: string;
}

interface RunLintOptions {
  readonly quiet?: boolean;
  readonly reportUnusedDisableDirectives?: boolean;
}

const projectRoot = resolve(import.meta.dirname, "../..");
const vpExecutable = process.platform === "win32" ? "vp.cmd" : "vp";
const directPnpmCommandPattern = /(?:^|[;&|()\s])pnpm(?:\.cmd)?(?:\s|$)/u;

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, unknown>>;
}

function ownedPackageManifestPaths(): readonly string[] {
  const packagesDirectory = resolve(projectRoot, "packages");
  const workspaceManifests = readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(packagesDirectory, entry.name, "package.json"))
    .filter(existsSync);
  return [resolve(projectRoot, "package.json"), ...workspaceManifests];
}

function verifyOwnedPackageScriptControlPlane(): void {
  const violations = ownedPackageManifestPaths().flatMap((manifestPath) => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
    if (!manifest.scripts) return [];

    return Object.entries(manifest.scripts).flatMap(([scriptName, command]) => {
      if (typeof command !== "string" || !directPnpmCommandPattern.test(command)) return [];
      return [`${relative(projectRoot, manifestPath)}#${scriptName}`];
    });
  });
  if (violations.length === 0) return;

  throw new Error(
    `Owned package scripts must use the Vite+ control plane; replace direct pnpm commands in ${violations.join(", ")}`,
  );
}

function runLint(
  paths: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
  options: RunLintOptions = {},
): { readonly report: LintReport; readonly status: number } {
  const result = spawnSync(
    vpExecutable,
    [
      "lint",
      ...(options.quiet === false ? [] : ["--quiet"]),
      ...(options.reportUnusedDisableDirectives ? ["--report-unused-disable-directives"] : []),
      "--format",
      "json",
      ...paths,
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODEX_TOOLING_FIXTURE_MODE: "1",
        ...extraEnvironment,
      },
    },
  );
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`Vite+ fixture lint terminated by ${result.signal}`);
  }

  const marker = '{ "diagnostics"';
  const reportOffset = result.stdout.indexOf(marker);
  if (reportOffset < 0) {
    throw new Error(
      ["Vite+ fixture lint did not return JSON.", result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return {
    report: JSON.parse(result.stdout.slice(reportOffset)) as LintReport,
    status: result.status ?? 1,
  };
}

function verifyInvalidFixtures(
  expected: readonly ExpectedDiagnostic[],
  environment?: Readonly<Record<string, string>>,
): void {
  const result = runLint(
    expected.map(({ filename }) => filename),
    environment,
  );
  if (result.status === 0) {
    throw new Error("Invalid tooling fixtures unexpectedly passed Oxlint.");
  }

  const actual = result.report.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  for (const expectation of expected) {
    const actualCount = actual.filter(
      (diagnostic) =>
        diagnostic.code === expectation.code && diagnostic.filename === expectation.filename,
    ).length;
    const expectedCount = expectation.count ?? 1;
    if (actualCount !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} ${expectation.code} diagnostic(s) for ${expectation.filename}, received ${actualCount}: ${JSON.stringify(actual)}`,
      );
    }
  }

  const expectedCount = expected.reduce(
    (total, expectation) => total + (expectation.count ?? 1),
    0,
  );
  if (actual.length !== expectedCount) {
    throw new Error(`Unexpected tooling fixture diagnostics: ${JSON.stringify(actual)}`);
  }
}

function verifyValidFixtures(
  paths: readonly string[],
  environment?: Readonly<Record<string, string>>,
): void {
  const result = runLint(paths, environment);
  if (result.status === 0 && result.report.diagnostics.length === 0) return;
  throw new Error(`Valid tooling fixtures failed Oxlint: ${JSON.stringify(result.report)}`);
}

function verifyAdvisoryPolicy(): void {
  const result = runLint(
    ["scripts/fixtures/tooling/advisory-warning.tsx", "scripts/fixtures/tooling/unused-disable.ts"],
    {},
    { quiet: false, reportUnusedDisableDirectives: true },
  );
  if (result.status !== 0) {
    throw new Error(`Advisory tooling fixtures blocked Oxlint: ${JSON.stringify(result.report)}`);
  }

  const warnings = result.report.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "warning",
  );
  const hasCategoryWarning = warnings.some(
    (diagnostic) =>
      diagnostic.code === "react(no-object-type-as-default-prop)" &&
      diagnostic.filename === "scripts/fixtures/tooling/advisory-warning.tsx",
  );
  const hasUnusedDisableWarning = warnings.some(
    (diagnostic) => diagnostic.filename === "scripts/fixtures/tooling/unused-disable.ts",
  );
  if (hasCategoryWarning && hasUnusedDisableWarning && warnings.length === 2) return;

  throw new Error(`Unexpected advisory tooling diagnostics: ${JSON.stringify(warnings)}`);
}

function verifyWorkspaceTaskGraph(): void {
  const result = spawnSync(vpExecutable, ["run", "--workspace-root", "version-surfaces:audit"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`Vite+ task graph probe terminated by ${result.signal}`);
  }
  if (result.status === 0) return;

  throw new Error(
    ["Vite+ could not construct the workspace task graph.", result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n"),
  );
}

verifyOwnedPackageScriptControlPlane();

verifyInvalidFixtures([
  {
    code: "react-hooks(rules-of-hooks)",
    filename: "scripts/fixtures/tooling/renderer/hooks-invalid.tsx",
  },
  {
    code: "eslint(no-restricted-imports)",
    filename: "scripts/fixtures/tooling/renderer/restricted-import-invalid.tsx",
  },
  {
    code: "@tanstack/query(exhaustive-deps)",
    filename: "scripts/fixtures/tooling/query-invalid.tsx",
  },
  {
    code: "eslint(no-restricted-imports)",
    filename: "scripts/fixtures/tooling/renderer-tests/barrel-import-invalid.ts",
  },
  {
    code: "react(only-export-components)",
    filename: "scripts/fixtures/tooling/workbench/refresh-invalid.tsx",
  },
  {
    code: "nodex(no-manual-effect-runtime-in-tests)",
    filename: "scripts/fixtures/tooling/nodex/manual-effect-runtime-invalid.test.ts",
  },
  {
    code: "nodex(no-manual-effect-runtime-in-tests)",
    filename: "scripts/fixtures/tooling/nodex/manual-effect-runtime-invalid.test-support.ts",
  },
  {
    code: "nodex(no-ambient-profile-authority)",
    count: 3,
    filename: "scripts/fixtures/tooling/nodex/profile-settings-ambient-invalid.ts",
  },
  {
    code: "nodex(no-native-title-tooltip)",
    filename: "scripts/fixtures/tooling/nodex/native-title-invalid.tsx",
  },
]);

verifyValidFixtures([
  "scripts/fixtures/tooling/renderer/hooks-valid.tsx",
  "scripts/fixtures/tooling/query-valid.tsx",
  "src/renderer/components/ui/context-menu.tsx",
  "src/renderer/components/shared/icons/generic-icons.tsx",
  "scripts/fixtures/tooling/nodex/manual-effect-runtime-valid.test.ts",
  "scripts/fixtures/tooling/nodex/profile-settings-authority-valid.ts",
  "scripts/fixtures/tooling/nodex/native-title-valid.tsx",
]);

verifyAdvisoryPolicy();

const tailwindEnvironment = { ESLINT_BETTER_TAILWIND: "1" };
verifyInvalidFixtures(
  [
    {
      code: "better-tailwindcss(no-unknown-classes)",
      filename: "scripts/fixtures/tooling/tailwind-invalid.tsx",
    },
  ],
  tailwindEnvironment,
);
verifyValidFixtures(["scripts/fixtures/tooling/tailwind-valid.tsx"], tailwindEnvironment);

verifyWorkspaceTaskGraph();

console.log(
  "Tooling contracts verified: package scripts, Oxlint rules, and the Vite+ workspace task graph.",
);
