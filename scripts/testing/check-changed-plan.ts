import path from "node:path";
import {
  APP_TEST_SUITES,
  isNativeExecutable,
  nativeRequirements,
  ownerOfTest,
  type NativeExecutableId,
  type SuiteId,
} from "../../config/test-suites.ts";
import { classifyChangedPaths, shouldCheckSearchKernelWasm } from "../ci/classify-change.ts";
import type { CiGatePlan } from "../ci/ci-gate-plan.ts";
import { selectStaticChecks, STATIC_CHECKS } from "../ci/verify-static.ts";
import type { CachedPass, SelectionEvidence } from "./test-cache-store.ts";
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
      readonly exactFiles?: readonly string[];
    }
  | {
      readonly kind: "browser";
      readonly files: readonly string[];
    }
  | { readonly kind: "skip"; readonly reason: string }
);

const codeFile = /\.[cm]?[jt]sx?$/u;
export const isTestFile = (file: string) => /\.(?:test\.[cm]?[jt]sx?|integration\.ts)$/u.test(file);

export function findFocusedTests(
  changed: readonly string[],
  present: ReadonlySet<string>,
  siblings: (directory: string) => readonly string[],
): Partial<Record<SuiteId, string[]>> {
  const candidates = new Set<string>();
  const directories = new Map<string, readonly string[]>();
  for (const file of changed) {
    if (isTestFile(file)) {
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
      if (name.startsWith(stem + ".") && isTestFile(name)) candidates.add(directory + name);
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

const touchesSource = (files: readonly string[]) => files.some((file) => file.startsWith("src/"));

function feedbackSteps(present: readonly string[], checkI18n: boolean): CheckStep[] {
  return [
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
  ];
}

export function planCheckSteps(
  files: readonly string[],
  present: readonly string[],
  focused: Readonly<Partial<Record<SuiteId, readonly string[]>>>,
) {
  const plan = files.length ? classifyChangedPaths(files) : null;
  const groups = plan?.staticGroups ?? [];
  const types = groups.includes("types");
  const steps: CheckStep[] = [
    ...feedbackSteps(present, groups.includes("ui-contracts") || touchesSource(files)),
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

/** Index only inputs attributed to this unit. Shared cache keys still guard replay. */
export function observedChangedInput(
  pass: CachedPass,
  changed: readonly string[],
  present: ReadonlySet<string>,
): boolean {
  for (const file of changed) {
    if (Object.hasOwn(pass.deps, file)) return true;
    const exists = present.has(file);
    // Resolution probes and glob membership observe names. Editing bytes does not
    // change them, even when the resolver probed every catalog in a lazy import table.
    const probe = pass.local?.probes?.[file];
    if (probe !== undefined && (probe === "file") !== exists) return true;
    if (
      pass.local?.observed?.some(
        ({ path, kind, evidence }) =>
          path === file &&
          ((evidence.state === "file") !== exists ||
            (exists && (kind === "stat" || kind === "lstat"))),
      )
    )
      return true;
    if (
      Object.entries(pass.local?.globs ?? {}).some(([glob, members]) =>
        exists
          ? !members.includes(file) &&
            !path.posix.basename(file).startsWith(".") &&
            path.posix.matchesGlob(file, glob)
          : members.includes(file),
      )
    )
      return true;
  }
  return false;
}

export interface FastTestSelection {
  readonly files: readonly string[];
  readonly unobservable: number;
  readonly unrecorded: number;
  readonly unaffected: number;
  readonly nativeDeferred?: Readonly<Partial<Record<NativeExecutableId, number>>>;
}

export function selectAffectedTests(
  files: readonly { readonly file: string; readonly evidence: SelectionEvidence }[],
  focused: ReadonlySet<string>,
): FastTestSelection {
  const selected: string[] = [];
  let unobservable = 0;
  let unrecorded = 0;
  let unaffected = 0;
  for (const { file, evidence } of files) {
    if (evidence === "unobservable") unobservable++;
    else if (evidence === "affected" || focused.has(file)) selected.push(file);
    else if (evidence === "unrecorded") unrecorded++;
    else unaffected++;
  }
  return { files: selected.sort(), unobservable, unrecorded, unaffected };
}

export type FastTestPlan = Readonly<Partial<Record<SuiteId, FastTestSelection>>>;

export function selectFocusedBrowserTests(
  files: readonly string[],
  focused: ReadonlySet<string>,
): FastTestSelection {
  const selected = files.filter((file) => focused.has(file)).sort();
  return {
    files: selected,
    unobservable: 0,
    unrecorded: 0,
    unaffected: files.length - selected.length,
  };
}

export function deferNativeTests(
  suite: SuiteId,
  selection: FastTestSelection,
  canRun: (artifact: NativeExecutableId) => boolean,
): FastTestSelection {
  const nativeDeferred: Partial<Record<NativeExecutableId, number>> = {};
  const files = selection.files.filter((file) => {
    const blocked = nativeRequirements(suite, [file])
      .filter(isNativeExecutable)
      .find((artifact) => !canRun(artifact));
    if (!blocked) return true;
    nativeDeferred[blocked] = (nativeDeferred[blocked] ?? 0) + 1;
    return false;
  });
  return { ...selection, files, nativeDeferred };
}

export const changesRustWorkspace = (file: string) =>
  file === "Cargo.toml" ||
  file === "Cargo.lock" ||
  file === "rust-toolchain.toml" ||
  file.startsWith(".cargo/");

export function planFastCheckSteps(
  files: readonly string[],
  present: readonly string[],
  tests: FastTestPlan,
  rustPackages: readonly string[],
) {
  const compiler = focusedCompilerCommands(
    present.filter((file) => file.startsWith("src/renderer/") && codeFile.test(file)),
  );
  const steps: CheckStep[] = [
    ...feedbackSteps(present, touchesSource(files)),
    {
      ...command("types", [
        "exec",
        "tsx",
        "scripts/tooling/with-machine-budget.ts",
        "4",
        "11",
        "type check",
        "--",
        "tsc-rs --build --noEmit",
      ]),
      resource: "semantic",
    },
    ...APP_TEST_SUITES.map((suite): CheckStep => {
      const name = `app ${suite}`;
      const selected = tests[suite]?.files ?? [];
      if (suite === "browser")
        return selected.length
          ? { name, kind: "browser", files: selected }
          : skip(name, "Chromium suite: left to CI");
      if (!selected.length)
        return skip(
          name,
          Object.keys(tests[suite]?.nativeDeferred ?? {}).length
            ? "native tests left to CI"
            : "no affected tests",
        );
      return { name, kind: "cached", suite, priority: [], exactFiles: selected };
    }),
    ...(compiler.length
      ? [{ name: "static ui-contracts", kind: "command" as const, commands: compiler }]
      : []),
    rustPackages.length
      ? {
          ...command("rust check", [
            "exec",
            "cargo",
            "check",
            "--locked",
            ...rustPackages.flatMap((name) => ["--package", name]),
          ]),
          lane: "rust",
          resource: "rust-budget",
        }
      : skip("rust", "no Rust crates changed"),
    // The committed WASM digest covers every crate the search kernel compiles, including
    // contracts it shares with Core, and checking it only reads Cargo metadata.
    ...(files.some(shouldCheckSearchKernelWasm)
      ? [command("search kernel WASM freshness", ["run", "search-kernel:wasm:check"])]
      : []),
  ];
  return { steps, rustEnv: { CARGO_BUILD_JOBS: "4" } };
}
