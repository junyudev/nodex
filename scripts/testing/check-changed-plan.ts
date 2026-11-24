import { APP_TEST_SUITES, ownerOfTest, type SuiteId } from "../../config/test-suites.ts";
import { classifyChangedPaths } from "../ci/classify-change.ts";
import type { CiGatePlan } from "../ci/ci-gate-plan.ts";
import { selectStaticChecks, STATIC_CHECKS } from "../ci/verify-static.ts";
interface StepCommand {
  readonly args: readonly string[];
  readonly label?: string;
}

export type CheckStep = { readonly name: string; readonly lane?: "rust" } & (
  | {
      readonly kind: "command";
      readonly commands: readonly StepCommand[];
      readonly resource?: "feedback" | "rust-budget" | "semantic";
    }
  | {
      readonly kind: "cached";
      readonly suite: SuiteId;
      readonly priority: readonly string[];
    }
  | { readonly kind: "skip"; readonly reason: string }
);

const codeFile = /\.[cm]?[jt]sx?$/u;
const testFile = /\.(?:test\.[cm]?[jt]sx?|integration\.ts)$/u;

export function findFocusedTests(
  changed: readonly string[],
  present: ReadonlySet<string>,
  siblings: (directory: string) => readonly string[],
): Partial<Record<SuiteId, string[]>> {
  const candidates = new Set<string>();
  const directories = new Map<string, readonly string[]>();
  for (const file of changed) {
    if (testFile.test(file)) {
      if (present.has(file)) candidates.add(file);
      continue;
    }
    if (!codeFile.test(file)) continue;
    const lastSlash = file.lastIndexOf("/");
    const directory = file.slice(0, lastSlash + 1);
    const stem = file.slice(lastSlash + 1).replace(codeFile, "");
    const entries = directories.get(directory) ?? siblings(directory);
    directories.set(directory, entries);
    for (const name of entries) {
      if (name.startsWith(stem + ".") && testFile.test(name)) candidates.add(directory + name);
    }
  }

  const result: Partial<Record<SuiteId, string[]>> = {};
  for (const file of [...candidates].sort()) {
    const owner = ownerOfTest(file);
    if (owner?.tier === "default") (result[owner.suite] ??= []).push(file);
  }
  return result;
}

/** Full-workspace CI lanes omit the path list so broad changes stay below ARG_MAX. */
export const rustGateEnvironment = (plan: CiGatePlan, files: readonly string[]) => ({
  CI_CHANGED_PATHS_JSON: JSON.stringify(plan.rustFull ? [] : files),
  CI_RUST_FULL: String(plan.rustFull),
  CARGO_BUILD_JOBS: "4",
  NEXTEST_TEST_THREADS: "2",
});

const command = (
  name: string,
  args: readonly string[],
): Extract<CheckStep, { kind: "command" }> => ({
  name,
  kind: "command",
  commands: [{ args }],
});

const skip = (name: string, reason: string): CheckStep => ({ name, kind: "skip", reason });

const fileCommands = (prefix: readonly string[], files: readonly string[]): StepCommand[] => {
  const commands: StepCommand[] = [];
  for (let index = 0; index < files.length; index += 200)
    commands.push({
      args: [...prefix, ...files.slice(index, index + 200).map((file) => "./" + file)],
    });
  return commands;
};

const focusedCompilerCommands = (files: readonly string[]) =>
  fileCommands(["exec", "tsx", "scripts/ci/react-compiler-ratchet.ts", "--files"], files);

function rustSteps(plan: CiGatePlan | null): CheckStep[] {
  const rust = (name: string, args: readonly string[], budget = true): CheckStep => ({
    ...command(name, args),
    lane: "rust",
    resource: budget ? "rust-budget" : undefined,
  });
  const steps = [
    ...(plan?.rustFast
      ? [
          rust("rust format", ["exec", "cargo", "fmt", "--all", "--check"], false),
          ...["clippy", "tests"].map((kind) =>
            rust(`rust ${kind}`, [
              "exec",
              "tsx",
              "scripts/ci/run-affected-rust.ts",
              "--kind",
              kind,
            ]),
          ),
        ]
      : []),
    ...(plan?.protocolContracts
      ? [rust("protocol contracts", ["run", "core:protocol:verify"])]
      : []),
    ...(plan?.rustMigration ? [rust("rust migration", ["run", "core:test:migration"])] : []),
  ];
  return steps.length ? steps : [skip("rust", "no Rust or protocol gates selected")];
}

export function planCheckSteps(
  files: readonly string[],
  present: readonly string[],
  focused: Readonly<Partial<Record<SuiteId, readonly string[]>>>,
) {
  const plan = files.length ? classifyChangedPaths(files) : null;
  const groups = plan?.staticGroups ?? [];
  const types = groups.includes("types");
  const checkI18n =
    groups.includes("ui-contracts") || files.some((file) => file.startsWith("src/"));
  const steps: CheckStep[] = [
    present.length
      ? {
          name: "changed-file format/lint",
          kind: "command",
          commands: [
            ...fileCommands(["fmt", "--check", "--no-error-on-unmatched-pattern"], present),
            ...fileCommands(
              ["exec", "tsx", "scripts/ci/lint-warning-ratchet.ts", "--files"],
              present.filter((file) => codeFile.test(file)),
            ),
          ],
        }
      : skip("changed-file format/lint", "no changed files to read"),
    checkI18n
      ? { ...command("i18n", ["run", "i18n:check"]), resource: "feedback" }
      : skip("i18n", "no catalog check selected"),
    {
      ...command(types ? "static types" : "semantic", ["run", types ? "check" : "check:semantic"]),
      resource: "semantic",
    },
    ...APP_TEST_SUITES.toSorted(
      (a, b) => Number(Boolean(focused[b]?.length)) - Number(Boolean(focused[a]?.length)),
    ).map((suite): CheckStep => ({
      name: `app ${suite}`,
      kind: "cached",
      suite,
      priority: focused[suite] ?? [],
    })),
    ...groups
      .filter((group) => group !== "types")
      .map((group): CheckStep => ({
        name: `static ${group}`,
        kind: "command",
        commands: selectStaticChecks(STATIC_CHECKS, [group]).flatMap((check): StepCommand[] => {
          if (check.id === "display-language-catalogs") return [];
          if (check.id === "react-compiler-coverage")
            return focusedCompilerCommands(
              present.filter((file) => file.startsWith("src/renderer/") && codeFile.test(file)),
            ).map((item) => ({ ...item, label: check.name }));
          return [{ args: check.command, label: check.name }];
        }),
      })),
    ...rustSteps(plan),
  ];
  return { steps, rustEnv: plan && rustGateEnvironment(plan, files) };
}
