import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APP_TEST_SUITES,
  NODEX_CLI_BOOTSTRAP_TEST,
  YJS_YRS_TEST,
} from "../../config/test-suites.ts";
import { describe, expect, it, vi } from "vite-plus/test";
import { classifyChangedPaths } from "../ci/classify-change.ts";
import { selectTouchedRustPackageNames } from "../ci/run-affected-rust.ts";
import { STATIC_GROUPS } from "../ci/ci-gate-plan.ts";
import {
  formatMainCiNotice,
  githubOriginRepository,
  latestFailedMainCiRun,
} from "./check-changed-main-ci.ts";
import {
  deferNativeTests,
  observedChangedInput,
  planCheckSteps,
  planFastCheckSteps,
  rustGateEnvironment,
  selectAffectedTests,
  selectFocusedBrowserTests,
  type CheckStep,
} from "./check-changed-plan.ts";
import { findFocusedTests } from "./focused-tests.ts";
import {
  formatSummary,
  idleQueueTime,
  queueTime,
  readChangedPaths,
  selectComparisonBase,
  type RunRecord,
} from "./check-changed-record.ts";
import { parseCheckArguments, runStep, runStepQueue, validationLanes } from "./check-changed.ts";
import { readSelectionEvidence, recordTestObservability, savePass } from "./test-cache-store.ts";

const remote = "refs/remotes/origin/main";
const local = "refs/heads/main";

describe("Main CI notice", () => {
  const run = {
    head_branch: "main",
    status: "completed",
    conclusion: "failure",
    head_sha: "0123456789abcdef0123456789abcdef01234567",
    html_url: "https://github.com/example/nodex/actions/runs/42",
    id: 42,
    run_attempt: 2,
  } as const;

  it("scopes the lookup to the GitHub repository named by origin", () => {
    expect(githubOriginRepository("git@github.com:example/nodex.git\n")).toBe("example/nodex");
    expect(githubOriginRepository("https://github.com/example/nodex.git")).toBe("example/nodex");
    expect(githubOriginRepository("ssh://git@github.com/example/nodex.git")).toBe("example/nodex");
    expect(
      githubOriginRepository("https://github.com.example.com/example/nodex.git"),
    ).toBeUndefined();
  });

  it("ignores an older failure after a successful run", () => {
    expect(
      latestFailedMainCiRun({ workflow_runs: [{ ...run, conclusion: "success" }, run] }),
    ).toBeUndefined();
  });

  it.each(["cancelled", "skipped"])("looks past a %s run to the newest verdict", (conclusion) => {
    expect(latestFailedMainCiRun({ workflow_runs: [{ ...run, conclusion }, run] })).toEqual(run);
  });

  it("reports a timed-out run as a failure", () => {
    const timedOut = { ...run, conclusion: "timed_out" };
    expect(latestFailedMainCiRun({ workflow_runs: [timedOut] })).toEqual(timedOut);
  });

  it("skips missing or unusable run data", () => {
    expect(latestFailedMainCiRun({ workflow_runs: [] })).toBeUndefined();
    expect(latestFailedMainCiRun({ workflow_runs: [{ ...run, head_sha: "" }] })).toBeUndefined();
  });

  it("summarizes the failed run, its failing jobs, and the optional issue", () => {
    expect(latestFailedMainCiRun({ workflow_runs: [run] })).toEqual(run);
    const jobs = [
      { name: "main static contracts / types", conclusion: "failure" },
      { name: "main app tests / unit", conclusion: "success" },
      { name: "main rust checks / tests", conclusion: "timed_out" },
      { name: "main app tests / renderer", conclusion: "skipped" },
    ];
    const notice = [
      `Main CI failed on 0123456 (${run.html_url}).`,
      "Failing jobs — main static contracts / types, main rust checks / tests",
      "Local failures that match this run predate the current change.",
    ].join("\n");
    expect(formatMainCiNotice(run, jobs)).toBe(notice);
    const issue = { number: 9, url: "https://github.com/example/nodex/issues/9" };
    expect(formatMainCiNotice(run, jobs, issue)).toBe(
      `${notice}\nTracking issue #9 — ${issue.url}`,
    );
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function withRepository(
  test: (fixture: {
    root: string;
    git: (...args: string[]) => string;
    write: (name: string, content?: string | Buffer) => void;
    commit: () => void;
  }) => void,
) {
  const generated = path.resolve(import.meta.dirname, "../../.generated");
  mkdirSync(generated, { recursive: true });
  const root = mkdtempSync(path.join(generated, "check-changed-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (name: string, content: string | Buffer = name) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "test");
  };
  try {
    git("init", "-q", "--initial-branch=main");
    test({ root, git, write, commit });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("changed-check comparison", () => {
  it("prefers the nearest merge base, using origin/main on ties and on main", () => {
    const tied = (ref: string) => ({ base: ref, ahead: 1 });
    const nearest = (ref: string) => ({ base: ref, ahead: ref === local ? 1 : 3 });
    expect(selectComparisonBase("feature", undefined, tied).ref).toBe(remote);
    expect(selectComparisonBase("feature", undefined, nearest).ref).toBe(local);
    expect(selectComparisonBase(local, undefined, nearest).ref).toBe(remote);
    expect(selectComparisonBase(local, "branch", nearest).ref).toBe("branch");
    expect(
      selectComparisonBase("feature", undefined, (ref) =>
        ref === local ? nearest(ref) : undefined,
      ).ref,
    ).toBe(local);
    expect(() => selectComparisonBase(local, undefined, () => undefined)).toThrow(
      "No merge base with HEAD",
    );
  });

  it("scopes unpushed commits to the current branch and includes every working-tree change", () => {
    withRepository(({ root, git, write, commit }) => {
      for (const name of ["deleted.ts", "staged.ts", "unstaged.ts"]) write(name);
      commit();
      const base = git("rev-parse", "HEAD");
      git("update-ref", remote, base);
      write("on-main.ts");
      commit();
      expect(readChangedPaths(root)).toEqual({ base, ref: remote, files: ["on-main.ts"] });

      const localBase = git("rev-parse", "HEAD");
      git("switch", "-qc", "feature");
      write("on-feature.ts");
      commit();
      write("staged.ts", "changed");
      git("add", "staged.ts");
      write("unstaged.ts", "changed");
      write("untracked.ts");
      rmSync(path.join(root, "deleted.ts"));
      const files = ["deleted.ts", "on-feature.ts", "staged.ts", "unstaged.ts", "untracked.ts"];
      expect(readChangedPaths(root)).toEqual({ base: localBase, ref: local, files });
      expect(readChangedPaths(root, "origin/main").files).toEqual([...files, "on-main.ts"].sort());
      expect(() => readChangedPaths(root, "missing")).toThrow(
        "No merge base with HEAD for missing",
      );
    });
  });
});

describe("fast check selection", () => {
  const component = "src/renderer/components/widget.tsx";
  const test = "src/renderer/components/widget.test.tsx";
  const parent = "src/renderer/components/parent.test.tsx";
  const other = "src/renderer/components/other.test.tsx";
  const catalog = "src/shared/i18n/catalogs/zh-CN.json";

  function fromInputs(changed: readonly string[], inputs: Record<string, readonly string[]>) {
    const present = new Set(changed);
    return Object.entries(inputs).map(([file, dependencies]) => ({
      file,
      evidence: observedChangedInput(
        {
          globalKey: "key",
          deps: Object.fromEntries([file, ...dependencies].map((dep) => [dep, "hash"])),
        },
        changed,
        present,
      )
        ? ("affected" as const)
        : ("unaffected" as const),
    }));
  }

  it("selects a leaf component's dependent tests from their recorded inputs", () => {
    expect(
      selectAffectedTests(
        fromInputs([component], { [test]: [component], [parent]: [component], [other]: [] }),
        new Set(),
      ),
    ).toEqual({ files: [parent, test], unaffected: 1, unrecorded: 0, unobservable: 0 });
  });

  it("selects a test-only edit, including a new test with no recorded pass", () => {
    for (const evidence of ["affected", "unrecorded"] as const) {
      const focused = findFocusedTests([test], new Set([test]), () => []);
      expect(
        selectAffectedTests(
          [
            { file: test, evidence },
            { file: other, evidence: "unrecorded" },
          ],
          new Set(focused.renderer),
        ),
      ).toEqual({ files: [test], unaffected: 0, unrecorded: 1, unobservable: 0 });
    }
  });

  it.each([
    {
      changed: [component],
      present: [component],
      expected: ["widget.head.nightly.test.tsx", "widget.nightly.test.tsx", "widget.test.tsx"],
    },
    {
      changed: [test],
      present: [test],
      expected: ["widget.head.nightly.test.tsx", "widget.nightly.test.tsx", "widget.test.tsx"],
    },
    { changed: [component], present: [], expected: ["widget.test.tsx"] },
    {
      changed: ["src/renderer/elsewhere/widget.tsx"],
      present: ["src/renderer/elsewhere/widget.tsx"],
      expected: [],
    },
    {
      changed: ["src/renderer/components/widget.nightly.test.tsx"],
      present: ["src/renderer/components/widget.nightly.test.tsx"],
      expected: ["widget.nightly.test.tsx"],
    },
  ])(
    "selects only edited or same-stem nightly suites for $changed",
    ({ changed, present, expected }) => {
      const directory = "src/renderer/components/";
      const siblings = (dirname: string) =>
        dirname === directory
          ? [
              "widget.test.tsx",
              "widget.head.nightly.test.tsx",
              "widget.nightly.test.tsx",
              "widget.stress.test.tsx",
              "widgetOther.nightly.test.tsx",
              "parent.nightly.test.tsx",
            ]
          : [];
      const focused = findFocusedTests(changed, new Set(present), siblings, true);
      expect(focused.renderer ?? []).toEqual(expected.map((name) => directory + name));
      expect(findFocusedTests(changed, new Set(present), siblings).renderer ?? []).toEqual(
        expected.filter((name) => !name.includes(".nightly.")).map((name) => directory + name),
      );
    },
  );

  it("keeps a sibling test with no pass and skips known unobservable files", () => {
    const focused = findFocusedTests([component], new Set([component]), () => [
      "widget.test.tsx",
      "widget.jsdom.test.ts",
    ]);
    expect(
      selectAffectedTests(
        [
          { file: test, evidence: "unrecorded" },
          { file: "src/renderer/components/widget.jsdom.test.ts", evidence: "unobservable" },
          { file: other, evidence: "unobservable" },
        ],
        new Set(focused.renderer),
      ),
    ).toEqual({
      files: [test],
      unaffected: 0,
      unrecorded: 0,
      unobservable: 2,
    });
  });

  it("selects only the tests that observed the edited translation catalog", () => {
    expect(
      selectAffectedTests(
        fromInputs([catalog], {
          [parent]: [catalog],
          [test]: ["src/shared/i18n/catalogs/fr-FR.json"],
          [other]: [],
        }),
        new Set(),
      ).files,
    ).toEqual([parent]);
  });

  it("distinguishes editing a catalog from changing the names a test observed", () => {
    const pass = {
      globalKey: "key",
      deps: { [test]: "hash" },
      local: {
        probes: { [catalog]: "file" as const },
        globs: { "src/shared/i18n/catalogs/*.json": [catalog] },
      },
    };
    const newCatalog = "src/shared/i18n/catalogs/fr-FR.json";
    expect(observedChangedInput(pass, [catalog], new Set([catalog]))).toBe(false);
    expect(observedChangedInput(pass, [catalog], new Set())).toBe(true);
    expect(observedChangedInput(pass, [newCatalog], new Set([newCatalog]))).toBe(true);
  });

  it("runs only focused Chromium specs through the ordinary runner", () => {
    const sibling = "src/renderer/components/widget.browser.test.tsx";
    const changedTest = "src/renderer/changed.browser.test.ts";
    const newTest = "src/renderer/new.browser.test.ts";
    const unrelated = "src/renderer/unrelated.browser.test.ts";
    const changed = [component, changedTest, newTest];
    const focused = findFocusedTests(changed, new Set(changed), () => ["widget.browser.test.tsx"]);
    const browser = selectFocusedBrowserTests(
      [sibling, changedTest, newTest, unrelated],
      new Set(focused.browser),
    );
    const { steps } = planFastCheckSteps(
      changed,
      changed,
      {
        renderer: selectAffectedTests([{ file: test, evidence: "affected" }], new Set()),
        browser,
      },
      [],
    );
    expect(steps.find(({ name }) => name === "app renderer")).toMatchObject({
      kind: "cached",
      exactFiles: [test],
    });
    expect(steps.find(({ name }) => name === "app browser")).toMatchObject({
      kind: "browser",
      files: [changedTest, sibling, newTest],
    });
    expect(browser.unaffected).toBe(1);
    expect(
      planFastCheckSteps([catalog], [catalog], {}, []).steps.find(
        ({ name }) => name === "app browser",
      ),
    ).toMatchObject({ kind: "skip", reason: "Chromium suite: left to CI" });
    const full = planCheckSteps([catalog], [catalog], {}).steps.find(
      ({ name }) => name === "app browser",
    );
    expect(full).toMatchObject({ kind: "cached" });
    expect(full).not.toHaveProperty("exactFiles");
  });

  it("defers only files that need an unavailable native test artifact", () => {
    const core = "src/main/core-client/related.node.test.ts";
    const selection = selectAffectedTests(
      [core, NODEX_CLI_BOOTSTRAP_TEST, YJS_YRS_TEST].map((file) => ({
        file,
        evidence: "affected",
      })),
      new Set(),
    );
    const fast = deferNativeTests("core-client", selection, (artifact) => artifact !== "cli");
    expect(fast).toMatchObject({ files: [core, YJS_YRS_TEST], nativeDeferred: { cli: 1 } });
    expect(deferNativeTests("core-client", fast, () => false)).toMatchObject({
      files: [],
      nativeDeferred: { "core-server": 1, "yjs-yrs-bridge": 1 },
    });
  });

  it("checks only the touched Rust crate, even if other crates depend on it", () => {
    const root = path.resolve("repo");
    const makePackage = (name: string, dependencies: string[]) => ({
      name,
      id: name,
      dependencies: dependencies.map((name) => ({ name })),
      manifest_path: path.join(root, "crates", name, "Cargo.toml"),
    });
    const files = ["crates/nodex-platform/src/lib.rs"];
    const rustPackages = selectTouchedRustPackageNames(
      {
        workspace_members: ["nodex-platform", "nodex-cli"],
        packages: [makePackage("nodex-platform", []), makePackage("nodex-cli", ["nodex-platform"])],
      },
      root,
      files,
    );
    const { steps } = planFastCheckSteps(files, files, {}, rustPackages);
    expect(steps.filter(({ lane }) => lane === "rust")).toMatchObject([
      {
        commands: [{ args: ["exec", "cargo", "check", "--locked", "--package", "nodex-platform"] }],
      },
    ]);
    // A Rust change can move the search kernel's committed WASM digest, so the fast check
    // catches a stale digest before CI does; a change without Rust inputs leaves it to CI.
    const wasmFreshness = ({ name }: { name: string }) => name === "search kernel WASM freshness";
    expect(steps.find(wasmFreshness)).toMatchObject({
      commands: [{ args: ["run", "search-kernel:wasm:check"] }],
    });
    expect(planFastCheckSteps([catalog], [catalog], {}, []).steps.find(wasmFreshness)).toBe(
      undefined,
    );
  });

  it("reads retained evidence and remembers when a later run could not observe a test", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "nodex-check-evidence-"));
    try {
      const matches = (pass: Parameters<typeof observedChangedInput>[0]) =>
        observedChangedInput(pass, [component], new Set([component]));
      expect(await readSelectionEvidence(directory, test, matches)).toBe("unrecorded");
      await savePass(directory, test, {
        globalKey: "key",
        deps: { [test]: "hash", [component]: "hash" },
      });
      expect(await readSelectionEvidence(directory, test, matches)).toBe("affected");
      await recordTestObservability(directory, test, false);
      expect(await readSelectionEvidence(directory, test, matches)).toBe("unobservable");
      await recordTestObservability(directory, test, true);
      expect(await readSelectionEvidence(directory, test, matches)).toBe("affected");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("changed-check steps", () => {
  const none = { unit: [], renderer: [] };
  const plan = (...files: string[]) => planCheckSteps(files, files, none).steps;

  it("uses test ownership to find changed and sibling tests in the default tier", () => {
    const changed = [
      "src/renderer/widget.tsx",
      "src/renderer/gone.test.tsx",
      "scripts/other.test.ts",
    ];
    expect(
      findFocusedTests(changed, new Set([changed[0], changed[2]]), () => [
        "widget.test.ts",
        "widget.node.test.tsx",
        "widget.jsdom.test.ts",
        "widget.test.tsx",
        "widget.stress.test.tsx",
        "widget.browser.test.tsx",
        "widget-helper.test.ts",
        "other.test.tsx",
      ]),
    ).toEqual({
      unit: [
        "scripts/other.test.ts",
        "src/renderer/widget.node.test.tsx",
        "src/renderer/widget.test.ts",
      ],
      renderer: ["src/renderer/widget.jsdom.test.ts", "src/renderer/widget.test.tsx"],
      browser: ["src/renderer/widget.browser.test.tsx"],
    });
  });

  it("preserves every selected CI group and prioritizes feedback and focused suites", () => {
    const files = ["package.json", "src/renderer/widget.tsx"];
    const { steps } = planCheckSteps(files, files, {
      unit: [],
      renderer: ["src/renderer/widget.test.tsx"],
    });
    expect(steps.filter(({ name }) => name.startsWith("static ")).map(({ name }) => name)).toEqual([
      "static types",
      ...classifyChangedPaths(files)
        .staticGroups.filter((group) => group !== "types")
        .map((group) => `static ${group}`),
    ]);
    expect(steps.slice(0, 5).map(({ name }) => name)).toEqual([
      "changed-file format/lint",
      "i18n",
      "static types",
      "app renderer",
      "app unit",
    ]);
    expect(steps.find(({ name }) => name === "static ui-contracts")).toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({
          args: [
            "exec",
            "tsx",
            "scripts/ci/react-compiler-ratchet.ts",
            "--files",
            "./src/renderer/widget.tsx",
          ],
        }),
      ]),
    });
    expect(steps.find(({ name }) => name === "app renderer")).toMatchObject({
      priority: ["src/renderer/widget.test.tsx"],
    });
    expect(plan("package.json").filter(({ name }) => name.startsWith("static "))).toHaveLength(
      STATIC_GROUPS.length,
    );
  });

  it.each([
    { files: [] },
    { files: ["AGENTS.md"] },
    { files: [".github/workflows/_static-checks.yml"] },
  ])("includes every Vitest suite for %j", ({ files }) => {
    expect(plan(...files).flatMap((step) => (step.kind === "cached" ? [step.suite] : []))).toEqual(
      APP_TEST_SUITES,
    );
  });

  it.each([
    ["packages/core-protocol/src/generated.ts", ["protocol contracts"]],
    ["crates/nodex-core/schema/current.sql", ["rust format", "rust clippy", "rust tests"]],
    ["Cargo.lock", ["rust format", "rust clippy", "rust tests", "protocol contracts"]],
    ["src/renderer/example.tsx", []],
  ])("selects the serialized Rust lanes for %s", (file, expected) => {
    expect(
      plan(file)
        .filter(({ lane }) => lane === "rust")
        .map(({ name }) => name),
    ).toEqual(expected);
  });

  it("forwards affected paths and omits the path list for full Rust runs", () => {
    const files = ["crates/nodex-platform/src/lib.rs"];
    expect(rustGateEnvironment(classifyChangedPaths(files), files)).toEqual({
      CI_CHANGED_PATHS_JSON: JSON.stringify(files),
      CI_RUST_FULL: "false",
      CARGO_BUILD_JOBS: "4",
      NEXTEST_TEST_THREADS: "2",
    });
    expect(rustGateEnvironment(classifyChangedPaths(["Cargo.lock"]), files)).toMatchObject({
      CI_RUST_FULL: "true",
      CI_CHANGED_PATHS_JSON: "[]",
    });
  });

  it("keeps feedback and local slots available while budgeted work waits", async () => {
    const cmd = (
      name: string,
      resource?: Extract<CheckStep, { kind: "command" }>["resource"],
    ): CheckStep => ({
      kind: "command",
      commands: [],
      name,
      resource,
      lane: resource === "rust-budget" ? "rust" : undefined,
    });
    const steps: CheckStep[] = [
      cmd("changed"),
      cmd("i18n", "feedback"),
      cmd("semantic", "semantic"),
      ...APP_TEST_SUITES.map((suite): CheckStep => ({
        name: suite,
        kind: "cached",
        suite,
        priority: [],
      })),
      cmd("clippy", "rust-budget"),
      cmd("rust tests", "rust-budget"),
      cmd("static"),
    ];
    const admission: string[] = [];
    const claims: string[] = [];
    const changed = deferred();
    const semanticGrant = deferred();
    const semanticFinish = deferred();
    const rustGrant = deferred();
    const staticStarted = deferred();
    const signal = new AbortController().signal;
    const lanes = validationLanes(semanticGrant.promise);
    const running = runStepQueue(steps, 1, signal, async (step) => {
      admission.push(step.name);
      if (step.name === "changed") await changed.promise;
      if (step.name === "semantic") {
        claims.push("semantic");
        await semanticFinish.promise;
      }
      if (step.kind === "cached") {
        await lanes.suite(step.suite, {}, signal, async () => {
          claims.push(step.suite);
        });
      }
      if (step.name === "clippy") await rustGrant.promise;
      if (step.name === "static") staticStarted.resolve();
      return {
        name: step.name,
        outcome: step.name === "changed" ? "FAIL" : step.name === "clippy" ? "TIMEOUT" : "pass",
        runMs: 0,
        queueMs: 0,
      };
    });
    expect(admission).toEqual(["changed", "i18n", "semantic", ...APP_TEST_SUITES]);
    expect(claims).toEqual(["semantic"]);
    changed.resolve();
    await staticStarted.promise;
    expect(admission).toContain("clippy");
    expect(admission).not.toContain("rust tests");
    expect(claims).toEqual(["semantic"]);
    semanticGrant.resolve();
    semanticFinish.resolve();
    rustGrant.resolve();
    const results = await running;
    expect(claims[0]).toBe("semantic");
    expect(claims.slice(1).sort()).toEqual([...APP_TEST_SUITES].sort());
    expect(results.map(({ outcome }) => outcome).filter((outcome) => outcome !== "pass")).toEqual([
      "FAIL",
      "TIMEOUT",
    ]);
    expect(admission).toContain("rust tests");
  });
  it("lets independent suites overlap while Rust blocks suites that launch Cargo artifacts", async () => {
    const lanes = validationLanes(Promise.resolve());
    const signal = new AbortController().signal;
    const rustDone = deferred();
    const rendererDone = deferred();
    const execution: string[] = [];
    const rust = lanes.cargo({}, signal, async () => {
      execution.push("rust started");
      await rustDone.promise;
      execution.push("rust finished");
    });
    const renderer = lanes.suite("renderer", {}, signal, async () => {
      execution.push("renderer started");
      await rendererDone.promise;
    });
    const core = lanes.suite("core-client", {}, signal, async () => {
      execution.push("core-client");
    });
    const agentRuntime = lanes.suite("agent-runtime", {}, signal, async () => {
      execution.push("agent-runtime");
    });
    try {
      await Promise.resolve();
      expect(execution).toEqual(["rust started", "renderer started", "agent-runtime"]);
      rustDone.resolve();
      await core;
      expect(execution).toEqual([
        "rust started",
        "renderer started",
        "agent-runtime",
        "rust finished",
        "core-client",
      ]);
    } finally {
      rustDone.resolve();
      rendererDone.resolve();
      await Promise.all([rust, renderer, core, agentRuntime]);
    }
  });
});

it("accepts an explicit ref and gives the timeout flag precedence over the environment", () => {
  expect(
    parseCheckArguments(["feature", "--timeout", "2"], { CHECK_CHANGED_TIMEOUT: "3" }),
  ).toEqual({ ref: "feature", full: false, timeoutMs: 2000, suiteTimeoutMs: 2000 });
  expect(parseCheckArguments(["--full", "feature"], {})).toMatchObject({
    ref: "feature",
    full: true,
  });
  expect(parseCheckArguments([], { CHECK_CHANGED_TIMEOUT: "3" }).timeoutMs).toBe(3000);
  expect(parseCheckArguments([], {}).suiteTimeoutMs).toBe(3_600_000);
  expect(() => parseCheckArguments(["--timeout", "-1"], {})).toThrow("positive number");
});

it("accounts for an unfinished budget wait and overlapping claims", () => {
  expect(
    queueTime(
      [
        { id: "a", label: "a", requestedAt: 100 },
        { id: "b", label: "b", requestedAt: 110 },
        { id: "a", label: "a", grantedAt: 120, waitedMs: 20 },
        { id: "c", label: "c", requestedAt: 130 },
        { id: "b", label: "b", grantedAt: 115, waitedMs: 5 },
      ],
      150,
    ),
  ).toBe(40);
});

it("excludes wall-clock time only when every active step is waiting", () => {
  const step = (start: number, end: number, waits: readonly (readonly [number, number])[]) => ({
    name: "step",
    outcome: "pass" as const,
    runMs: 0,
    queueMs: 0,
    activity: { start, end, waits },
  });
  expect(
    idleQueueTime([
      step(1, 30, [
        [5, 15],
        [20, 25],
      ]),
      step(7, 24, [
        [10, 13],
        [21, 22],
      ]),
    ]),
  ).toBe(7);
});

it("summarizes cache reach, top causes, skipped steps, and total time", () => {
  const record: RunRecord = {
    startedAt: "today",
    worktree: "/repo",
    base: "base",
    ref: "main",
    pathCount: 1,
    totalMs: 4000,
    steps: [
      {
        name: "app unit",
        outcome: "pass",
        runMs: 2700,
        queueMs: 1100,
        cache: {
          suite: "unit",
          hits: 5,
          ran: 6,
          selected: 10,
          recorded: 0,
          cacheable: 8,
          uncacheable: [{ reason: "untracked file read", input: "generated.json", count: 2 }],
          missCauses: [{ input: "source.ts", count: 3 }],
          globalKeyMisses: 0,
          unrecorded: 0,
          lookupMs: 12,
        },
      },
      { name: "rust", outcome: "skipped", reason: "no Rust paths changed", runMs: 0, queueMs: 0 },
    ],
  };
  const output = formatSummary(record);
  expect(output).toContain("5/10 hits · 80.0% cacheable · misses: source.ts (3)");
  expect(output).toContain("always run: untracked file read (2)");
  expect(output).toContain("no Rust paths changed");
  expect(output).toContain("Total wall time: 4.00s");
  const notice = "Main CI failed on 0123456.";
  expect(formatSummary(record, notice)).toBe(`${output}\n${notice}\n`);
});

it("excludes a suite's semantic admission wait from its running-time limit", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nodex-check-step-test-"));
  const ready = deferred();
  const lanes = validationLanes(ready.promise);
  vi.useFakeTimers({ toFake: ["Date", "performance", "setInterval", "clearInterval"] });
  try {
    const result = runStep(
      "app renderer",
      ({ env, signal }) => lanes.suite("renderer", env, signal, async () => 0),
      { root: directory, directory, timeoutMs: 1000, signal: new AbortController().signal },
      "queued",
    );
    await vi.advanceTimersByTimeAsync(3000);
    ready.resolve();
    expect(await result).toMatchObject({ outcome: "pass", queueMs: 3000, runMs: 0 });
  } finally {
    ready.resolve();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("reports a command that exceeds its wall-clock limit as TIMEOUT", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nodex-check-step-test-"));
  try {
    const result = await runStep(
      "unresponsive command",
      // The parent owns cancellation, so the child can wait indefinitely.
      {
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); setInterval(() => {}, 60_000)"],
      },
      { root: directory, directory, timeoutMs: 100, signal: new AbortController().signal },
      "timeout",
    );
    expect(result).toMatchObject({ outcome: "TIMEOUT", queueMs: 0 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
