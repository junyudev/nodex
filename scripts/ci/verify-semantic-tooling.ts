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
import { createRequire } from "node:module";
import rootConfiguration from "../../vite.config";
import effectConfiguration from "../../tsconfig.effect.json";

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
        packageManager: "pnpm@12.3.4",
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
      cache: {
        env: ["COUNTER", "PROBE_POLICY"],
        input: [{ auto: true }, "!executions.log"],
        output: [],
      },
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

/** Root checks own this checkout; nested worktrees keep independent lint and format policies. */
export function verifyWorktreeToolingIsolation(): void {
  fixtureWorkspace((directory) => {
    const worktreePaths = [".agents/worktrees/**", ".codex/worktrees/**"];
    const ownedFilename = "src/invalid.ts";
    const foreignFilenames = worktreePaths.map((pattern) =>
      pattern.replace("**", "isolated/src/invalid.ts"),
    );
    const writeConfiguration = (includeWorktrees: boolean) => {
      writeFileSync(
        path.join(directory, "vite.config.ts"),
        `
        import { defineConfig } from 'vite-plus';
        import policy from ${JSON.stringify(path.join(root, "vite.config.ts"))};
        const worktreePaths = ${JSON.stringify(includeWorktrees ? worktreePaths : [])};
        export default defineConfig({
          lint: { ...policy.lint,
            ignorePatterns: (policy.lint?.ignorePatterns ?? []).filter((pattern) => !worktreePaths.includes(pattern)),
            jsPlugins: (policy.lint?.jsPlugins ?? []).map((plugin) =>
              typeof plugin === 'string' && plugin.startsWith('.') ? ${JSON.stringify(root + "/")} + plugin : plugin) },
          fmt: { ...policy.fmt,
            ignorePatterns: (policy.fmt?.ignorePatterns ?? []).filter((pattern) => !worktreePaths.includes(pattern)) }
        });
        `,
      );
      const formatted = command(directory, ["fmt", "--write", "vite.config.ts", "package.json"]);
      if (formatted.status !== 0)
        throw new Error("Could not prepare the tooling isolation fixture.\n" + formatted.output);
    };
    const lint = () => {
      const result = command(directory, ["lint", "--format", "json"]);
      const marker = result.stdout.indexOf('{ "diagnostics"');
      if (marker < 0)
        throw new Error("Isolation fixture did not return lint diagnostics.\n" + result.output);
      const report = JSON.parse(result.stdout.slice(marker)) as {
        readonly diagnostics: readonly Diagnostic[];
      };
      return { ...result, diagnostics: report.diagnostics };
    };
    const format = () => command(directory, ["fmt", "--check"]);
    const hasDiagnostic = (diagnostics: readonly Diagnostic[], filename: string) =>
      diagnostics.some((diagnostic) =>
        diagnostic.filename?.replaceAll("\\", "/").endsWith(filename),
      );
    for (const filename of [ownedFilename, ...foreignFilenames]) {
      mkdirSync(path.dirname(path.join(directory, filename)), { recursive: true });
      writeFileSync(path.join(directory, filename), "export const invalid = ;\n");
    }
    writeConfiguration(false);
    const ownedLint = lint();
    const ownedFormat = format();
    if (
      ownedLint.status === 0 ||
      !hasDiagnostic(ownedLint.diagnostics, ownedFilename) ||
      foreignFilenames.some((filename) => hasDiagnostic(ownedLint.diagnostics, filename)) ||
      ownedFormat.status === 0 ||
      !ownedFormat.output.includes(ownedFilename)
    ) {
      throw new Error(
        "Root checks must reject owned syntax without checking nested worktrees.\n" +
          ownedLint.output +
          ownedFormat.output,
      );
    }
    unlinkSync(path.join(directory, ownedFilename));
    const isolatedLint = lint();
    const isolatedFormat = format();
    if (isolatedLint.status !== 0 || isolatedFormat.status !== 0) {
      throw new Error(
        "Nested worktree syntax escaped the root lint or format exclusions.\n" +
          isolatedLint.output +
          isolatedFormat.output,
      );
    }
    // Removing only the worktree exclusions must expose both invalid nested sources.
    writeConfiguration(true);
    const exposedLint = lint();
    const exposedFormat = format();
    if (
      exposedLint.status === 0 ||
      foreignFilenames.some((filename) => !hasDiagnostic(exposedLint.diagnostics, filename)) ||
      exposedFormat.status === 0 ||
      foreignFilenames.some((filename) => !exposedFormat.output.includes(filename))
    ) {
      throw new Error(
        "The isolation counterexample did not reach both nested worktrees.\n" +
          exposedLint.output +
          exposedFormat.output,
      );
    }
  });
}

/** New upstream diagnostics must not silently escape the owning runtime's scope. */
function verifyEffectConfiguration(): void {
  const packagePath = createRequire(import.meta.url).resolve("@effect/tsgo/package.json");
  const schema: {
    readonly definitions: {
      readonly effectLanguageServicePluginDiagnosticSeverityDefinition: {
        readonly properties: Readonly<Record<string, unknown>>;
      };
    };
  } = JSON.parse(readFileSync(path.join(path.dirname(packagePath), "schema.json"), "utf8"));
  const plugin = effectConfiguration.compilerOptions.plugins[0];
  const upstream = Object.keys(
    schema.definitions.effectLanguageServicePluginDiagnosticSeverityDefinition.properties,
  ).sort();
  const disabled = Object.keys(plugin.diagnosticSeverity).sort();
  if (
    JSON.stringify(upstream) !== JSON.stringify(disabled) ||
    Object.values(plugin.diagnosticSeverity).some((severity) => severity !== "off")
  ) {
    throw new Error("Review the Effect diagnostic inventory against the installed schema.");
  }
  const scope = plugin.overrides[0];
  const adapter = plugin.overrides[1];
  const permittedUnstableApis = [
    "@effect/platform-node",
    "@effect/vitest",
    "effect/FileSystem",
    "effect/LayerMap",
    "effect/Path",
    "effect/PlatformError",
    "effect/Stdio",
    "effect/process",
  ];
  const expectedErrors = [
    "classSelfMismatch",
    "effectFnImplicitAny",
    "floatingEffect",
    "floatingEffectInVitest",
    "missingEffectContext",
    "missingEffectError",
    "missingLayerContext",
    "missingReturnYieldStar",
    "missingStarInYieldEffectGen",
    "nonObjectEffectServiceType",
    "overriddenSchemaConstructor",
    "schemaLiteralNonFinite",
    "schemaOpaqueInstanceMember",
  ].sort();
  const actualErrors = Object.entries(scope.options.diagnosticSeverity)
    .filter(([, severity]) => severity === "error")
    .map(([rule]) => rule)
    .sort();
  if (
    JSON.stringify(actualErrors) !== JSON.stringify(expectedErrors) ||
    !scope.include.includes("packages/effect-codex-app-server/**/*.ts") ||
    !scope.include.includes("src/main/**/*.ts") ||
    !scope.include.includes("src/main/**/*.tsx") ||
    !scope.include.includes("scripts/codex-probe-session.ts") ||
    !scope.exclude?.includes("packages/effect-codex-app-server/src/_generated/**/*.ts") ||
    scope.options.diagnosticSeverity.cryptoRandomUUID !== "warning" ||
    scope.options.diagnosticSeverity.cryptoRandomUUIDInEffect !== "warning" ||
    scope.options.diagnosticSeverity.schemaSync !== "off" ||
    scope.options.diagnosticSeverity.schemaSyncInEffect !== "warning" ||
    scope.options.diagnosticSeverity.unstableApiUsage !== "warning" ||
    JSON.stringify(plugin.allowedUnstableApis) !== JSON.stringify(permittedUnstableApis) ||
    !adapter.include.includes("src/main/platform/**/*.ts") ||
    adapter.options.diagnosticSeverity.globalRandom !== "off" ||
    adapter.options.diagnosticSeverity.nodeBuiltinImport !== "off" ||
    !plugin.ignoreEffectWarningsInTscExitCode
  ) {
    throw new Error("Effect diagnostic scope, errors, or platform exceptions changed.");
  }
}

/** Exercise the real compiler and typed lint policy in a small, isolated project. */
export function verifyTypedSemanticPolicy(): void {
  verifyEffectConfiguration();
  fixtureWorkspace((directory) => {
    const sourceDirectory = path.join(directory, "src/main/codex-application");
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
          types: ["node"],
          tsBuildInfoFile: ".cache/typescript/fixture.tsbuildinfo",
          plugins: effectConfiguration.compilerOptions.plugins,
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
      "requirements-error.ts": [
        'import * as Context from "effect/Context";',
        'import * as Effect from "effect/Effect";',
        'class Required extends Context.Service<Required, { readonly answer: number }>()("fixture/Required") {}',
        "export const answer: Effect.Effect<number> = Effect.gen(function* () { return (yield* Required).answer; });",
        "",
      ].join("\n"),
      "allowed-api.ts":
        'import * as FileSystem from "effect/FileSystem";\nexport const filesystem = FileSystem.FileSystem;\n',
      "unknown-api.ts":
        'import * as HttpClient from "effect/http/HttpClient";\nexport const http = HttpClient.HttpClient;\n',
      "schema-helper.ts": [
        'import * as Effect from "effect/Effect";',
        'import * as Schema from "effect/Schema";',
        "export const decode = Schema.decodeUnknownSync(Schema.String);",
        'export const insideEffect = Effect.gen(function* () { return Schema.decodeUnknownSync(Schema.String)("text"); });',
        "",
      ].join("\n"),
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
    const adapterDirectory = path.join(directory, "src/main/platform");
    mkdirSync(adapterDirectory, { recursive: true });
    writeFileSync(
      path.join(adapterDirectory, "allowed-random.ts"),
      'import { randomUUID } from "node:crypto";\nexport const createId = randomUUID;\nexport const random = Math.random();\n',
    );
    const compiler = command(directory, [
      "exec",
      "tsc-rs",
      "--build",
      "--noEmit",
      "--pretty",
      "false",
    ]);
    const compilerHas = (file: string, code: number) =>
      compiler.output.split("\n").some((line) => line.includes(file) && line.includes("TS" + code));
    if (
      compiler.status === 0 ||
      !compilerHas("type-error.ts", 2322) ||
      !compilerHas("effect-error.ts", 377001) ||
      !compilerHas("requirements-error.ts", 377004) ||
      !compilerHas("advisory.ts", 377070) ||
      !compilerHas("unknown-api.ts", 377136) ||
      compilerHas("allowed-api.ts", 377136) ||
      !compilerHas("schema-helper.ts", 377037) ||
      compilerHas("schema-helper.ts", 377130) ||
      compilerHas("effect-outside-policy.ts", 377001) ||
      compiler.output.includes("allowed-random.ts")
    ) {
      throw new Error(
        "Compiler policy lost required diagnostics or its scope.\n" + compiler.output,
      );
    }
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
      !has("promise-error.ts", "error", "typescript(no-floating-promises)") ||
      !has("unused-disable.ts", "warning") ||
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
    for (const task of ["typecheck", "lint", "check:semantic"]) {
      const invalid = command(directory, ["run", "--no-cache", task]);
      if (
        invalid.status === 0 ||
        !invalid.output.includes("TS377001") ||
        !invalid.output.includes("TS377004")
      ) {
        throw new Error(task + " lost Effect error enforcement.\n" + invalid.output);
      }
    }
    writeFileSync(
      path.join(sourceDirectory, "effect-error.ts"),
      'import * as Effect from "effect/Effect";\nexport const answer = Effect.succeed(1);\n',
    );
    writeFileSync(
      path.join(sourceDirectory, "requirements-error.ts"),
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
