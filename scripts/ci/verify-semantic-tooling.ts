import { vitePlusCommand } from "../vite-plus-command";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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

function fixtureWorkspace(run: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nodex-semantic-contract-"));
  try {
    symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
    copyFileSync(path.join(root, ".node-version"), path.join(directory, ".node-version"));
    mkdirSync(path.join(directory, "scripts/ci"), { recursive: true });
    mkdirSync(path.join(directory, "config"));
    for (const filename of [
      "scripts/ci/count-ratchet.ts",
      "scripts/ci/lint-warning-ratchet.ts",
      "scripts/ci/react-compiler-ratchet.ts",
      "scripts/vite-plus-command.ts",
      "config/renderer-react-compiler.ts",
      "config/renderer-vite-shared.ts",
    ])
      copyFileSync(path.join(root, filename), path.join(directory, filename));
    writeFileSync(path.join(directory, "scripts/ci/lint-warning-baseline.json"), "{}\n");
    writeFileSync(path.join(directory, "scripts/ci/react-compiler-baseline.json"), "{}\n");
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "nodex-semantic-contract",
        private: true,
        type: "module",
        packageManager: "pnpm@12.15.0",
        scripts: {
          "lint:baseline": "tsx scripts/ci/lint-warning-ratchet.ts --update",
          "react-compiler:baseline": "tsx scripts/ci/react-compiler-ratchet.ts --update",
        },
      }),
    );
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function command(directory: string, args: readonly string[], environment: NodeJS.ProcessEnv = {}) {
  const invocation = vitePlusCommand(args);
  const result = spawnSync(invocation.command, invocation.args, {
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

/** Exercise the warning gate and updater through real lint output and Git moves. */
export function verifyLintWarningRatchet(): void {
  fixtureWorkspace((directory) => {
    const baselinePath = path.join(directory, "scripts/ci/lint-warning-baseline.json");
    const rule = "eslint(no-debugger)";
    const warning = "export function warning() {\n  debugger;\n}\n";
    const readBaseline = () =>
      JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, Record<string, number>>;
    const expect = (args: readonly string[], status: number, ...messages: readonly string[]) => {
      const result = command(directory, args);
      if (result.status === status && messages.every((message) => result.output.includes(message)))
        return result;
      throw new Error(`Warning ratchet contract failed for ${args.join(" ")}.\n${result.output}`);
    };
    const lint = ["exec", "tsx", "scripts/ci/lint-warning-ratchet.ts"];
    mkdirSync(path.join(directory, "src"));
    writeFileSync(path.join(directory, "src/warning.ts"), warning);
    writeFileSync(
      path.join(directory, "src/unused.ts"),
      "// oxlint-disable-next-line no-debugger\nexport const answer = 42;\n",
    );
    writeFileSync(
      path.join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { noEmit: true, skipLibCheck: true, types: [], target: "ES2022" },
        include: ["src/**/*.ts"],
      }),
    );
    writeFileSync(
      path.join(directory, "vite.config.ts"),
      `
      import { defineConfig } from 'vite-plus';
      export default defineConfig(${JSON.stringify({
        lint: {
          ignorePatterns: ["node_modules/**", ".cache/**", ".vite-plus/**"],
          categories: { correctness: "off" },
          rules: { "eslint/no-debugger": "warn", "eslint/no-unreachable": "error" },
          options: { reportUnusedDisableDirectives: "warn" },
        },
        run: rootConfiguration.run,
      })});
    `,
    );
    const initial = {
      "src/unused.ts": { "oxlint/unused-disable-directive": 1 },
      "src/warning.ts": { [rule]: 1 },
    };
    writeFileSync(baselinePath, JSON.stringify(initial));
    expect(["fmt", "--write"], 0);
    for (const task of ["typecheck", "lint", "check:semantic", "check"])
      expect(["run", task], 0, "2 baseline warnings, 0 new.");
    expect([...lint, "--all"], 0, "src/warning.ts:2:3 warning", rule, "src/unused.ts:1:1 warning");

    writeFileSync(path.join(directory, "src/new.ts"), warning);
    const regression = expect(["run", "lint"], 1, "src/new.ts:2:3 warning", rule, "baseline 0, +1");
    if (regression.output.includes("src/warning.ts:2:3 warning"))
      throw new Error("Baseline diagnostics obscured the new warning.");
    const before = readFileSync(baselinePath, "utf8");
    expect(["run", "lint:baseline"], 1, "New lint warnings are forbidden.");
    if (readFileSync(baselinePath, "utf8") !== before)
      throw new Error("A rejected update changed the baseline.");
    expect(["run", "lint:baseline", "--allow-baseline-growth"], 0, "WARNING:", "3 warnings.");
    unlinkSync(path.join(directory, "src/new.ts"));
    expect(["run", "lint:baseline"], 0, "2 warnings.");
    if (JSON.stringify(readBaseline()) !== JSON.stringify(initial))
      throw new Error("Lowering the baseline did not drop the fixed file.");

    writeFileSync(baselinePath, JSON.stringify({ ...initial, "src/warning.ts": { [rule]: 2 } }));
    expect(["run", "typecheck"], 1, "stale baseline 2", "vp run lint:baseline");
    expect(["run", "lint:baseline"], 0, "2 warnings.");
    if (readBaseline()["src/warning.ts"][rule] !== 1)
      throw new Error("The updater did not lower a rule count.");
    expect(["run", "typecheck"], 0, "2 baseline warnings, 0 new.");

    writeFileSync(
      path.join(directory, "src/error.ts"),
      "export function invalid() { return; debugger; }\n",
    );
    const beforeError = readFileSync(baselinePath, "utf8");
    expect(
      [...lint, "--update", "--allow-baseline-growth"],
      1,
      "error eslint(no-unreachable)",
      "help:",
      "return; debugger;",
    );
    if (readFileSync(baselinePath, "utf8") !== beforeError)
      throw new Error("Lint errors changed the baseline.");
    unlinkSync(path.join(directory, "src/error.ts"));

    // Invalidating the wrapper must invalidate a previously successful semantic task.
    appendFileSync(
      path.join(directory, "scripts/ci/lint-warning-ratchet.ts"),
      '\nthrow new Error("wrapper invalidation probe");\n',
    );
    expect(["run", "typecheck"], 1, "wrapper invalidation probe");
    copyFileSync(
      path.join(root, "scripts/ci/lint-warning-ratchet.ts"),
      path.join(directory, "scripts/ci/lint-warning-ratchet.ts"),
    );
    expect(["run", "typecheck"], 0, "2 baseline warnings, 0 new.");

    const runGit = (args: readonly string[]) => {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`Rename fixture Git failed: ${result.stderr}`);
    };
    writeFileSync(path.join(directory, ".gitignore"), "node_modules/\n.cache/\n.vite-plus/\n");
    runGit(["init", "--initial-branch=main"]);
    runGit(["add", "."]);
    runGit([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    runGit(["switch", "-c", "warning-move"]);
    renameSync(path.join(directory, "src/warning.ts"), path.join(directory, "src/committed.ts"));
    runGit(["add", "src"]);
    runGit([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "move warning",
    ]);
    expect(lint, 0, "2 baseline warnings, 0 new.");
    renameSync(
      path.join(directory, "src/committed.ts"),
      path.join(directory, "src/moved warning.ts"),
    );
    expect(lint, 0, "2 baseline warnings, 0 new.");
    runGit(["diff", "--cached", "--exit-code"]);
    expect(["run", "lint:baseline"], 0, "2 warnings.");
    const moved = readBaseline();
    if (
      moved["src/warning.ts"] ||
      moved["src/committed.ts"] ||
      moved["src/moved warning.ts"]?.[rule] !== 1
    )
      throw new Error("Git moves did not carry the warning allowance.");
    runGit(["diff", "--cached", "--exit-code"]);
  });
}

/** Exercise production compiler bailouts and the only-shrinks policy through the CLI. */
export function verifyReactCompilerRatchet(): void {
  fixtureWorkspace((directory) => {
    const baselinePath = path.join(directory, "scripts/ci/react-compiler-baseline.json");
    const renderer = path.join(directory, "src/renderer");
    mkdirSync(renderer, { recursive: true });
    writeFileSync(
      path.join(directory, "vite.config.ts"),
      `import { defineConfig } from 'vite-plus'; export default defineConfig(${JSON.stringify({ run: rootConfiguration.run })});`,
    );
    const compiling =
      "export function Greeting({ name }: { name: string }) { return <span>{name}</span>; }\n";
    const bailout = `export function Finally({ name }: { name: string }) {
  try { return <span>{name}</span>; }
  finally { console.log(name); }
}\n`;
    const filename = "src/renderer/finally.tsx";
    const compiler = ["run", "react-compiler:check"];
    const update = ["run", "react-compiler:baseline"];
    const expect = (args: readonly string[], status: number, ...messages: readonly string[]) => {
      const result = command(directory, args);
      if (result.status === status && messages.every((message) => result.output.includes(message)))
        return result;
      throw new Error(
        `React Compiler ratchet contract failed for ${args.join(" ")}.\n${result.output}`,
      );
    };
    writeFileSync(path.join(renderer, "greeting.tsx"), compiling);
    const counter = path.join(directory, "compiler-executions.log");
    appendFileSync(
      path.join(directory, "scripts/ci/react-compiler-ratchet.ts"),
      '\nimport { appendFileSync } from "node:fs"; appendFileSync("compiler-executions.log", "run\\n");\n',
    );
    // Invalid syntax must never enter Babel through excluded renderer tests/fixtures or other runtimes.
    for (const excluded of [
      "src/renderer/greeting.test.tsx",
      "src/renderer/fixtures/broken.tsx",
      "src/renderer/generated/kernel.d.ts",
      "src/main/broken.tsx",
    ]) {
      mkdirSync(path.dirname(path.join(directory, excluded)), { recursive: true });
      writeFileSync(path.join(directory, excluded), "this is not valid TypeScript !!!");
    }
    expect(
      compiler,
      0,
      "1 renderer sources: 1 compiled functions",
      "0 baseline uncompiled functions, 0 new.",
    );
    expect(compiler, 0, "0 baseline uncompiled functions, 0 new.");
    if (readFileSync(counter, "utf8") !== "run\n")
      throw new Error("An unchanged compiler task did not reuse its cached result.");
    writeFileSync(path.join(directory, filename), bailout);
    const before = readFileSync(baselinePath, "utf8");
    expect(
      compiler,
      1,
      `${filename}:2:3`,
      "Todo (Finally)",
      "finally",
      "baseline 0, +1",
      "New uncompiled renderer functions are forbidden.",
    );
    expect(update, 1, "Todo (Finally)");
    if (readFileSync(baselinePath, "utf8") !== before)
      throw new Error("A rejected compiler baseline update changed the file.");
    expect([...compiler, "--allow-baseline-growth"], 1, "requires --update");
    expect([...update, "--allow-baseline-growth"], 0, "WARNING:", "1 uncompiled functions.");
    const initial = JSON.stringify({ [filename]: { uncompiled: 1 } }, null, 2) + "\n";
    if (readFileSync(baselinePath, "utf8") !== initial)
      throw new Error("The compiler baseline did not count one function deterministically.");
    expect(compiler, 0, "1 baseline uncompiled functions, 0 new.");
    expect([...compiler, "--all"], 0, "Todo (Finally)", "finally");
    // Increasing an existing file count must fail too.
    writeFileSync(
      path.join(directory, filename),
      bailout + bailout.replace("Finally", "AnotherFinally"),
    );
    expect(compiler, 1, "Todo (AnotherFinally)", "baseline 1, +1");
    expect(update, 1, "baseline 1, +1");
    writeFileSync(path.join(directory, filename), bailout);
    expect(compiler, 0, "1 baseline uncompiled functions, 0 new.");
    // A successful task must invalidate when either the baseline or shared checker changes.
    writeFileSync(baselinePath, JSON.stringify({ [filename]: { uncompiled: 2 } }));
    expect(compiler, 1, "stale baseline 2", "vp run react-compiler:baseline");
    expect(update, 0, "1 uncompiled functions.");
    expect(compiler, 0, "1 baseline uncompiled functions, 0 new.");
    for (const source of [
      "scripts/ci/count-ratchet.ts",
      "scripts/ci/react-compiler-ratchet.ts",
      "config/renderer-react-compiler.ts",
    ]) {
      appendFileSync(
        path.join(directory, source),
        '\nthrow new Error("compiler cache invalidation probe");\n',
      );
      expect(compiler, 1, "compiler cache invalidation probe");
      copyFileSync(path.join(root, source), path.join(directory, source));
      expect(compiler, 0, "1 baseline uncompiled functions, 0 new.");
    }
    // Rename allowance follows an unstaged move, without staging anything for the contributor.
    const runGit = (args: readonly string[]) => {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      if (result.status !== 0)
        throw new Error(`Compiler rename fixture Git failed: ${result.stderr}`);
    };
    writeFileSync(path.join(directory, ".gitignore"), "node_modules/\n.cache/\n.vite-plus/\n");
    runGit(["init", "--initial-branch=main"]);
    runGit(["add", "."]);
    runGit([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    renameSync(path.join(directory, filename), path.join(renderer, "moved finally.tsx"));
    expect(compiler, 0, "1 baseline uncompiled functions, 0 new.");
    runGit(["diff", "--cached", "--exit-code"]);
    expect(update, 0, "1 uncompiled functions.");
    if (
      readFileSync(baselinePath, "utf8") !==
      JSON.stringify({ "src/renderer/moved finally.tsx": { uncompiled: 1 } }, null, 2) + "\n"
    )
      throw new Error("The compiler baseline did not follow the Git rename.");
    writeFileSync(path.join(renderer, "moved finally.tsx"), compiling);
    expect(compiler, 1, "stale baseline 1");
    expect(update, 0, "0 uncompiled functions.");
    if (readFileSync(baselinePath, "utf8") !== "{}\n")
      throw new Error("The compiler updater did not remove a fixed file.");
    expect(compiler, 0, "0 baseline uncompiled functions, 0 new.");
    writeFileSync(
      path.join(renderer, "multiple.tsx"),
      `export function Multiple({ name }: { name: string }) {
  const first = () => { try { console.log(name); } finally { console.log("first"); } };
  const second = () => { try { console.log(name); } finally { console.log("second"); } };
  return <button onClick={() => { first(); second(); }}>{name}</button>;
}\n`,
    );
    const multiple = expect([...update, "--allow-baseline-growth"], 0, "Todo (Multiple)");
    if ((multiple.output.match(/React Compiler Todo \(Multiple\)/g)?.length ?? 0) < 2)
      throw new Error("The multiple-diagnostic compiler fixture did not exercise two errors.");
    const counts = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<
      string,
      Record<string, number>
    >;
    if (counts["src/renderer/multiple.tsx"]?.uncompiled !== 1)
      throw new Error("Multiple compiler diagnostics counted the same function more than once.");
    const beforeError = readFileSync(baselinePath, "utf8");
    writeFileSync(path.join(renderer, "multiple.tsx"), "this is not valid TypeScript !!!");
    expect([...update, "--allow-baseline-growth"], 1, "Cannot check React Compiler coverage");
    if (readFileSync(baselinePath, "utf8") !== beforeError)
      throw new Error("A failed compiler transform changed the baseline.");
  });
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
    !scope.include.includes("src/host/**/*.ts") ||
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
        'export const insideEffect = Effect.gen(function* () { return yield* Effect.succeed(Schema.decodeUnknownSync(Schema.String)("text")); });',
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
    const baseline = command(directory, ["run", "lint:baseline", "--allow-baseline-growth"]);
    if (baseline.status !== 0)
      throw new Error("Could not baseline advisory fixtures.\n" + baseline.output);
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
    // Disabling strictNullChecks would also change the typed lint warning inventory.
    configuration.compilerOptions.noUncheckedIndexedAccess = false;
    writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify(configuration));
    writeFileSync(
      path.join(sourceDirectory, "indexed-access.ts"),
      "export const values: Record<string, number> = {};\nexport const value: number = values.answer;\n",
    );
    const permissive = command(directory, ["run", "typecheck"]);
    if (permissive.status !== 0)
      throw new Error("The permissive config fixture failed.\n" + permissive.output);
    configuration.compilerOptions.noUncheckedIndexedAccess = true;
    writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify(configuration));
    const strict = command(directory, ["run", "typecheck"]);
    if (
      strict.status === 0 ||
      !strict.output.includes("indexed-access.ts") ||
      !strict.output.includes("TS2322")
    )
      throw new Error("A tsconfig edit lost its indexed-access diagnostic.\n" + strict.output);
  });
}
