import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import rootConfiguration from "../../vite.config";

const root = path.resolve(import.meta.dirname, "../..");
const executable = process.platform === "win32" ? "vp.cmd" : "vp";

function fixtureWorkspace(run: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nodex-semantic-contract-"));
  try {
    symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "nodex-semantic-contract",
        private: true,
        type: "module",
        packageManager: "pnpm@11.11.0",
      }),
    );
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function command(directory: string, args: readonly string[], environment: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(executable, args, {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      NODEX_TOOLING_FIXTURE_MODE: "",
      ESLINT_BETTER_TAILWIND: "",
      ...environment,
    },
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error("Semantic fixture interrupted by " + result.signal);
  return {
    status: result.status ?? 1,
    output: result.stdout + result.stderr,
    stdout: result.stdout,
  };
}

/** Exercise Vite Task's actual command cache, including compound commands and invalidation. */
export function verifySemanticTaskCache(): void {
  fixtureWorkspace((directory) => {
    const counter = path.join(directory, "executions.log");
    const environment = { COUNTER: counter, PROBE_POLICY: "first" };
    writeFileSync(path.join(directory, "input.txt"), "first");
    writeFileSync(
      path.join(directory, "check.cjs"),
      `require('node:fs').readFileSync('input.txt');require('node:fs').appendFileSync(process.env.COUNTER,'semantic\\n');`,
    );
    writeFileSync(
      path.join(directory, "format.cjs"),
      `require('node:fs').readFileSync('input.txt');require('node:fs').appendFileSync(process.env.COUNTER,'format\\n');`,
    );
    const shared = {
      command: "node check.cjs",
      env: ["COUNTER", "PROBE_POLICY"],
      input: [{ auto: true }, "!executions.log"],
      output: [],
    };
    writeFileSync(
      path.join(directory, "vite.config.ts"),
      `import { defineConfig } from 'vite-plus'; export default defineConfig(${JSON.stringify({
        run: {
          tasks: {
            typecheck: shared,
            lint: shared,
            "check:semantic": shared,
            check: { ...shared, command: "node format.cjs && node check.cjs" },
          },
        },
      })});`,
    );
    const expectExecutions = (args: readonly string[], expected: string, env = environment) => {
      const result = command(directory, args, env);
      if (result.status === 0 && readFileSync(counter, "utf8") === expected) return;
      throw new Error("Task cache contract failed for " + args.join(" ") + "\n" + result.output);
    };
    expectExecutions(["run", "typecheck"], "semantic\n");
    expectExecutions(["run", "lint"], "semantic\n");
    expectExecutions(["run", "check:semantic"], "semantic\n");
    expectExecutions(["run", "check"], "semantic\nformat\n");
    expectExecutions(["run", "--no-cache", "check"], "semantic\nformat\nformat\nsemantic\n");
    writeFileSync(path.join(directory, "input.txt"), "changed");
    expectExecutions(["run", "lint"], "semantic\nformat\nformat\nsemantic\nsemantic\n");
    expectExecutions(
      ["run", "typecheck"],
      "semantic\nformat\nformat\nsemantic\nsemantic\nsemantic\n",
      { ...environment, PROBE_POLICY: "changed" },
    );
  });
}

interface Diagnostic {
  readonly code?: string;
  readonly filename?: string;
  readonly severity: string;
}

/** The real lint policy runs in a tiny typed Program; fixture mode never disables its checker. */
export function verifyTypedSemanticPolicy(): void {
  fixtureWorkspace((directory) => {
    const sourceDirectory = path.join(directory, "src/main/app");
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(
      path.join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
        },
        include: ["src/**/*.ts"],
      }),
    );
    writeFileSync(
      path.join(directory, "vite.config.ts"),
      `
      import { defineConfig } from 'vite-plus';
      import policy from ${JSON.stringify(path.join(root, "vite.config.ts"))};
      export default defineConfig({
        lint: { ...policy.lint, jsPlugins: (policy.lint?.jsPlugins ?? []).map((plugin) =>
          typeof plugin === 'string' && plugin.startsWith('.') ? ${JSON.stringify(root + "/")} + plugin : plugin) },
        run: ${JSON.stringify(rootConfiguration.run)}
      });
    `,
    );
    const files: Readonly<Record<string, string>> = {
      "type-error.ts": 'export const answer: number = "wrong";\n',
      "promise-error.ts": "Promise.resolve(1);\nexport {};\n",
      "effect-error.ts": 'import * as Effect from "effect/Effect";\nEffect.succeed(1);\n',
      "unused-disable.ts": "// oxlint-disable-next-line no-debugger\nexport const answer = 42;\n",
      "suppressed.ts":
        "// oxlint-disable-next-line typescript/no-floating-promises\nPromise.resolve(1);\nexport const answer = 1;\n",
      "advisory.ts": "export const random = Math.random();\n",
    };
    for (const [name, source] of Object.entries(files))
      writeFileSync(path.join(sourceDirectory, name), source);
    mkdirSync(path.join(directory, "src/renderer"), { recursive: true });
    writeFileSync(
      path.join(directory, "src/renderer/effect-outside-policy.ts"),
      'import * as Effect from "effect/Effect";\nEffect.succeed(1);\n',
    );
    const result = command(directory, ["lint", "--format", "json", "src"]);
    const marker = result.stdout.indexOf('{ "diagnostics"');
    if (marker < 0) throw new Error("Typed fixture did not return diagnostics.\n" + result.output);
    const report = JSON.parse(result.stdout.slice(marker)) as {
      diagnostics: readonly Diagnostic[];
    };
    const has = (file: string, severity: string, code?: string) =>
      report.diagnostics.some(
        (diagnostic) =>
          diagnostic.filename?.endsWith(file) &&
          diagnostic.severity === severity &&
          (!code || diagnostic.code === code),
      );
    if (
      result.status === 0 ||
      !has("type-error.ts", "error", "typescript(TS2322)") ||
      !has("promise-error.ts", "error", "typescript(no-floating-promises)") ||
      !has("effect-error.ts", "error", "effecttsgo(floating-effect)") ||
      !has("unused-disable.ts", "warning") ||
      !has("advisory.ts", "warning") ||
      has("suppressed.ts", "error") ||
      has("effect-outside-policy.ts", "error")
    ) {
      throw new Error("Typed semantic policy lost required diagnostics.\n" + result.output);
    }
    for (const task of ["typecheck", "lint", "check:semantic"]) {
      const invalid = command(directory, ["run", "--no-cache", task]);
      if (invalid.status === 0) throw new Error(task + " accepted invalid typed fixtures.");
    }
    writeFileSync(
      path.join(sourceDirectory, "type-error.ts"),
      "export const answer: number = 42;\n",
    );
    writeFileSync(
      path.join(sourceDirectory, "promise-error.ts"),
      "void Promise.resolve(1);\nexport const answer = 1;\n",
    );
    writeFileSync(
      path.join(sourceDirectory, "effect-error.ts"),
      'import * as Effect from "effect/Effect";\nexport const answer = Effect.succeed(1);\n',
    );
    for (const task of ["typecheck", "lint", "check:semantic"]) {
      const valid = command(directory, ["run", task]);
      if (valid.status !== 0)
        throw new Error(task + " blocked advisory-only fixtures.\n" + valid.output);
    }
    appendFileSync(
      path.join(sourceDirectory, "type-error.ts"),
      'export const regression: number = "wrong";\n',
    );
    if (command(directory, ["run", "lint"]).status === 0)
      throw new Error("A source edit reused stale semantic success.");
    writeFileSync(
      path.join(sourceDirectory, "type-error.ts"),
      "export const answer: number = 42;\n",
    );
    if (command(directory, ["run", "typecheck"]).status !== 0)
      throw new Error("A repaired source reused stale semantic failure.");
    writeFileSync(
      path.join(sourceDirectory, "new-error.ts"),
      'export const added: number = "wrong";\n',
    );
    if (command(directory, ["run", "lint"]).status === 0)
      throw new Error("A newly added file escaped semantic invalidation.");
    unlinkSync(path.join(sourceDirectory, "new-error.ts"));
    if (command(directory, ["run", "lint"]).status !== 0)
      throw new Error("A deleted error file retained a stale diagnostic.");
    writeFileSync(
      path.join(sourceDirectory, "dependency.ts"),
      "export interface Contract { value: number }\n",
    );
    writeFileSync(
      path.join(sourceDirectory, "consumer.ts"),
      'import type { Contract } from "./dependency";\nexport const value: Contract = { value: 42 };\n',
    );
    if (command(directory, ["run", "typecheck"]).status !== 0)
      throw new Error("Valid dependency fixture failed.");
    writeFileSync(
      path.join(sourceDirectory, "dependency.ts"),
      "export interface Contract { value: string }\n",
    );
    if (command(directory, ["run", "lint"]).status === 0)
      throw new Error("A shared contract edit reused stale success.");
    writeFileSync(
      path.join(sourceDirectory, "dependency.ts"),
      "export interface Contract { value: number }\n",
    );
    const configuration = JSON.parse(readFileSync(path.join(directory, "tsconfig.json"), "utf8"));
    configuration.compilerOptions.strictNullChecks = false;
    writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify(configuration));
    writeFileSync(
      path.join(sourceDirectory, "nullable.ts"),
      "export const value: number = null;\n",
    );
    if (command(directory, ["run", "typecheck"]).status !== 0)
      throw new Error("The permissive config fixture failed.");
    configuration.compilerOptions.strictNullChecks = true;
    writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify(configuration));
    if (command(directory, ["run", "typecheck"]).status === 0)
      throw new Error("A tsconfig edit reused stale success.");
  });
}
