import { execFileSync } from "node:child_process";
import path from "node:path";

import { STATIC_GROUPS, type StaticGroup } from "./ci-gate-plan";

export interface StaticCheck {
  readonly command: readonly string[];
  readonly group: StaticGroup;
  readonly id: string;
  readonly name: string;
}

export const STATIC_CHECKS: readonly StaticCheck[] = [
  {
    command: ["run", "check"],
    group: "types",
    id: "integrated-check",
    name: "integrated TypeScript, Effect, lint, and format diagnostics",
  },
  {
    command: ["run", "semantic-theme:verify"],
    group: "ui-contracts",
    id: "semantic-theme",
    name: "semantic theme",
  },
  {
    command: ["run", "verify:icons"],
    group: "ui-contracts",
    id: "icon-boundaries",
    name: "icon boundaries",
  },
  {
    command: ["run", "verify:renderer-ui-boundaries"],
    group: "ui-contracts",
    id: "renderer-ui-boundaries",
    name: "renderer UI dependency boundaries",
  },
  {
    command: ["run", "ci:workflow-contracts"],
    group: "ci-contracts",
    id: "workflow-contracts",
    name: "workflow contracts",
  },
  {
    command: ["run", "ci:vite-plus-workflow-contracts"],
    group: "ci-contracts",
    id: "vite-plus-workflow-contracts",
    name: "Vite+ workflow control plane",
  },
  {
    command: ["run", "ci:stress-workflow-contracts"],
    group: "ci-contracts",
    id: "stress-ownership",
    name: "stress workflow ownership",
  },
  {
    command: ["run", "ci:verify-ignored-rust-tests"],
    group: "ci-contracts",
    id: "ignored-rust-tests",
    name: "ignored Rust test tiers",
  },
  {
    command: ["run", "verify:test-inventory"],
    group: "ci-contracts",
    id: "test-inventory",
    name: "test runtime ownership and collection",
  },
  {
    command: ["run", "tooling:verify"],
    group: "repository-contracts",
    id: "tooling-contracts",
    name: "tooling contracts",
  },
  {
    command: ["run", "verify:renderer-command-boundaries"],
    group: "repository-contracts",
    id: "renderer-command-boundaries",
    name: "renderer command boundaries",
  },
  {
    command: ["run", "verify:effect-boundaries"],
    group: "repository-contracts",
    id: "effect-boundaries",
    name: "Effect runtime boundaries",
  },
  {
    command: ["run", "core:module-boundaries"],
    group: "repository-contracts",
    id: "module-boundaries",
    name: "module boundaries",
  },
  {
    command: ["run", "version-surfaces:audit"],
    group: "repository-contracts",
    id: "version-surfaces",
    name: "version surfaces",
  },
  {
    command: ["run", "build-resources:verify"],
    group: "generated",
    id: "generated-resources",
    name: "generated build resources and notices/legal",
  },
  {
    command: ["run", "build:landing"],
    group: "landing",
    id: "landing-build",
    name: "landing build",
  },
];

export const PROTOCOL_CHECK = {
  command: ["run", "core:protocol:verify"],
  id: "protocol-contracts",
  name: "protocol contracts",
} as const;

interface StaticCliArguments {
  readonly groups: readonly StaticGroup[] | null;
}

type StaticExecutor = (executable: string, arguments_: readonly string[]) => void;

export const selectStaticChecks = (
  checks: readonly StaticCheck[],
  groups: readonly StaticGroup[],
): readonly StaticCheck[] => {
  if (groups.length === 0) throw new Error("At least one static group is required.");
  const selected = new Set(groups);
  return checks.filter((check) => selected.has(check.group));
};

export const parseStaticArguments = (args: readonly string[]): StaticCliArguments => {
  if (args.length === 0) return { groups: null };
  const groups: StaticGroup[] = [];
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--group") throw new Error(`Unknown static argument: ${args[index]}.`);
    const value = args[index + 1];
    if (!value || !(STATIC_GROUPS as readonly string[]).includes(value)) {
      throw new Error(`Unknown static group: ${JSON.stringify(value)}.`);
    }
    groups.push(value as StaticGroup);
  }
  if (new Set(groups).size !== groups.length)
    throw new Error("Static groups must not be repeated.");
  return { groups };
};

export const runStaticChecks = (
  checks: readonly Pick<StaticCheck, "command" | "name">[],
  execute: StaticExecutor = (executable, arguments_) => {
    execFileSync(executable, arguments_, { cwd: process.cwd(), stdio: "inherit" });
  },
): void => {
  const vpExecutable = process.platform === "win32" ? "vp.cmd" : "vp";
  for (const check of checks) {
    process.stdout.write(`\n[static] ${check.name}\n`);
    execute(vpExecutable, check.command);
  }
};

const main = (): void => {
  const { groups } = parseStaticArguments(process.argv.slice(2));
  if (groups) {
    runStaticChecks(selectStaticChecks(STATIC_CHECKS, groups));
    return;
  }
  const protocolIndex = STATIC_CHECKS.findIndex((check) => check.id === "module-boundaries");
  runStaticChecks([
    ...STATIC_CHECKS.slice(0, protocolIndex),
    PROTOCOL_CHECK,
    ...STATIC_CHECKS.slice(protocolIndex),
  ]);
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
