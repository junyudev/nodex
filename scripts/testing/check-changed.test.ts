import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { classifyChangedPaths } from "../ci/classify-change.ts";
import { STATIC_GROUPS } from "../ci/ci-gate-plan.ts";
import {
  findFocusedTests,
  planCheckSteps,
  rustGateEnvironment,
  type CheckStep,
} from "./check-changed-plan.ts";
import {
  formatSummary,
  queueTime,
  readChangedPaths,
  readPassKey,
  selectComparisonBase,
} from "./check-changed-record.ts";
import { parseCheckArguments, runStep, runStepQueue } from "./check-changed.ts";
import { findFileRestorations } from "./check-file-restorations.ts";

const remote = "refs/remotes/origin/main";
const local = "refs/heads/main";

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
    commit: (subject?: string) => void;
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
  const commit = (subject = "test") => {
    git("add", ".");
    git("commit", "-qm", subject);
  };
  try {
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
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
      expect(readChangedPaths(root)).toMatchObject({ base, ref: remote, files: ["on-main.ts"] });

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
      expect(readChangedPaths(root)).toMatchObject({ base: localBase, ref: local, files });
      expect(readChangedPaths(root, "origin/main").files).toEqual([...files, "on-main.ts"].sort());
      expect(() => readChangedPaths(root, "missing")).toThrow(
        "No merge base with HEAD for missing",
      );
    });
  });

  it("skips restoration checks when Git history is shallow", () => {
    withRepository(({ root, git, write, commit }) => {
      write("tracked.ts");
      commit();
      const shallowRoot = path.join(root, "shallow");
      git("clone", "-q", "--depth", "1", "--no-local", root, shallowRoot);
      const comparison = readChangedPaths(shallowRoot);
      expect(comparison).toMatchObject({ ref: remote, shallow: true });
      expect(planCheckSteps(comparison, [], noFocusedTests).steps[0]).toMatchObject({
        kind: "skip",
        reason: expect.stringContaining("shallow history"),
      });
    });
  });

  it("invalidates a cached pass when just the committed history changes", () => {
    withRepository(({ root, git, write, commit }) => {
      write("tracked.ts");
      commit();
      git("update-ref", remote, "HEAD");
      write("tracked.ts", "different");
      commit();
      const key = () => readPassKey(root, readChangedPaths(root), undefined, {});
      const original = key();
      git("commit", "--amend", "-qm", "same files with a new commit message");
      expect(key()).not.toBe(original);
    });
  });

  it("fingerprints binary edits, ignored env files, install state, staged bytes and validation env", () => {
    withRepository(({ root, git, write, commit }) => {
      write(".gitignore", ".env*\nnode_modules/\n");
      write("tracked.bin", Buffer.from([0, 1]));
      commit();
      const key = (env: NodeJS.ProcessEnv = {}, ref = "HEAD") =>
        readPassKey(root, readChangedPaths(root, ref), ref, env);
      const distinct = [key()];
      write("tracked.bin", Buffer.from([0, 2]));
      distinct.push(key());
      git("add", "tracked.bin");
      distinct.push(key());
      write("untracked.bin", Buffer.from([0, 3]));
      distinct.push(key());
      write("untracked.bin", Buffer.from([0, 4]));
      distinct.push(key());
      write("packages/example/.env.local", "ENABLED=1");
      distinct.push(key());
      write("node_modules/.modules.yaml", "build: version");
      distinct.push(key());
      write("node_modules/.pnpm/lock.yaml", "installed: version");
      distinct.push(key());
      distinct.push(key({ NODEX_TEST_TIER: "stress" }), key({ CI: "1" }), key({}, "main"));
      expect(new Set(distinct).size).toBe(distinct.length);
      expect(key({ PWD: "/a/different/shell" })).toBe(key());
    });
  });
});

describe("committed file restorations", () => {
  it("detects a stale soft-reset squash in a linked branch and on main before pushing", () => {
    withRepository(({ root, git, write, commit }) => {
      write("modified.ts", "old main content");
      write("deleted by main.ts");
      commit();
      git("branch", "feature");

      write("modified.ts", "new main content");
      write("added-by-main.ts");
      git("rm", "-q", "deleted by main.ts");
      commit("fix: update main's files");
      const base = git("rev-parse", "HEAD");
      git("update-ref", remote, base);

      const linked = path.join(root, "linked");
      git("worktree", "add", "-q", linked, "feature");
      write("linked/feature.ts");
      git("-C", linked, "add", "feature.ts");
      git("-C", linked, "commit", "-qm", "feat: make a change from stale main");
      git("-C", linked, "reset", "--soft", "main");
      git("-C", linked, "commit", "-qm", "feat: squash the feature");

      const expected = [
        {
          hash: base,
          subject: "fix: update main's files",
          paths: ["added-by-main.ts", "deleted by main.ts", "modified.ts"],
        },
      ];
      const feature = readChangedPaths(linked);
      expect(feature.base).toBe(base);
      expect(findFileRestorations(linked, base, feature.head)).toEqual(expected);

      git("merge", "-q", "--ff-only", "feature");
      const beforePush = readChangedPaths(root);
      expect(beforePush.base).toBe(base);
      expect(findFileRestorations(root, base, beforePush.head)).toEqual(expected);
    });
  });

  it.each(["rebase", "edit after main"])("accepts an ordinary %s", (scenario) => {
    withRepository(({ root, git, write, commit }) => {
      write("tracked.ts", "old main content");
      commit();
      git("branch", "feature");
      write("tracked.ts", "new main content");
      commit();
      const base = git("rev-parse", "HEAD");

      if (scenario === "rebase") {
        git("switch", "-q", "feature");
        write("feature.ts");
        commit();
        git("rebase", "main");
      } else {
        git("switch", "-qc", "edit");
        write("tracked.ts", "old main content");
        commit("try the old content");
        write("tracked.ts", "new branch content");
        commit("keep the branch content");
      }
      expect(findFileRestorations(root, base, "HEAD")).toEqual([]);
    });
  });

  it.each(["git revert", "conventional revert"])("accepts an explicit %s", (scenario) => {
    withRepository(({ root, git, write, commit }) => {
      write("tracked.ts", "old content");
      commit();
      write("tracked.ts", "new content");
      commit("fix: change main");
      const base = git("rev-parse", "HEAD");

      if (scenario === "git revert") {
        git("revert", "--no-edit", base);
      } else {
        write("tracked.ts", "old content");
        commit(`revert: restore content before ${base.slice(0, 12)}`);
      }
      write("feature.ts");
      commit();
      expect(findFileRestorations(root, base, "HEAD")).toEqual([]);
    });
  });

  it("accepts a named revert when more than one main commit overwrote the same content", () => {
    withRepository(({ root, git, write, commit }) => {
      write("tracked.ts", "old content");
      commit();
      write("tracked.ts", "new content");
      commit("fix: change main");
      const original = git("rev-parse", "HEAD");
      git("revert", "--no-edit", original);
      write("tracked.ts", "new content");
      commit("fix: repeat the change");
      const base = git("rev-parse", "HEAD");
      git("revert", "--no-edit", original);
      expect(findFileRestorations(root, base, "HEAD")).toEqual([]);
    });
  });

  it("requires the commit restoring a path to name the undone commit", () => {
    withRepository(({ root, git, write, commit }) => {
      write("first.ts", "old main content");
      write("second.ts", "old main content");
      commit();
      write("first.ts", "new main content");
      write("second.ts", "new main content");
      commit("fix: change both files");
      const base = git("rev-parse", "HEAD");

      write("first.ts", "old main content");
      commit(`revert: restore first.ts before ${base}`);
      write("second.ts", "old main content");
      commit("feat: change second.ts");
      expect(findFileRestorations(root, base, "HEAD")).toEqual([
        { hash: base, subject: "fix: change both files", paths: ["second.ts"] },
      ]);
    });
  });
});

const noFocusedTests = { unit: [], renderer: [] };
const range = { base: "base", head: "head", shallow: false };

describe("changed-check steps", () => {
  const plan = (...files: string[]) =>
    planCheckSteps({ ...range, files }, files, noFocusedTests).steps;

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
    });
  });

  it("preserves every selected CI group and puts focused checks before slow gates", () => {
    const files = ["package.json", "src/renderer/widget.tsx"];
    const { steps } = planCheckSteps({ ...range, files }, files, {
      unit: [],
      renderer: ["src/renderer/widget.test.tsx"],
    });
    expect(steps.filter(({ name }) => name.startsWith("static ")).map(({ name }) => name)).toEqual([
      "static types",
      ...classifyChangedPaths(files)
        .staticGroups.filter((group) => group !== "types")
        .map((group) => `static ${group}`),
    ]);
    expect(steps.slice(0, 6).map(({ name }) => name)).toEqual([
      "committed file restorations",
      "changed-file format/lint",
      "i18n",
      "focused unit",
      "focused renderer",
      "static types",
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
    expect(steps.find(({ name }) => name === "app renderer")).toMatchObject({ filters: [] });
    expect(plan("package.json").filter(({ name }) => name.startsWith("static "))).toHaveLength(
      STATIC_GROUPS.length,
    );
  });

  it("keeps just the applicable lanes for docs and workflow changes", () => {
    expect(
      plan("AGENTS.md")
        .filter(({ kind }) => kind !== "skip")
        .map(({ name }) => name),
    ).toEqual(["committed file restorations", "changed-file format/lint", "semantic"]);
    const workflow = plan(".github/workflows/_static-checks.yml");
    expect(workflow.find(({ name }) => name === "app unit")?.kind).toBe("skip");
    expect(workflow.find(({ name }) => name === "static repository-contracts")?.kind).toBe(
      "command",
    );
  });

  it.each([
    ["packages/core-protocol/src/generated.ts", ["protocol contracts"]],
    [
      "crates/nodex-core/schema/current.sql",
      ["rust format", "rust clippy", "rust tests", "rust migration"],
    ],
    [
      "Cargo.lock",
      ["rust format", "rust clippy", "rust tests", "protocol contracts", "rust migration"],
    ],
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

  it("admits in order, keeps each lane exclusive, and continues after failure and timeout", async () => {
    const step = (name: string, lane?: CheckStep["lane"]): CheckStep => ({
      kind: "command",
      commands: [],
      name,
      lane,
    });
    const gates = [
      step("changed"),
      step("unit", "vitest"),
      step("renderer", "vitest"),
      step("rust", "rust"),
    ];
    const lightFinished = deferred();
    const unitFinished = deferred();
    const laterStarted = deferred();
    const admissions: string[] = [];
    const running = runStepQueue(gates, 2, new AbortController().signal, async ({ name }) => {
      admissions.push(name);
      if (name === "changed") await lightFinished.promise;
      if (name === "unit") await unitFinished.promise;
      if (name === "renderer") laterStarted.resolve();
      return {
        name,
        outcome: name === "changed" ? "FAIL" : name === "unit" ? "TIMEOUT" : "pass",
        runMs: 0,
        queueMs: 0,
      };
    });
    expect(admissions).toEqual(["changed", "unit"]);
    lightFinished.resolve();
    await Promise.resolve();
    expect(admissions).toEqual(["changed", "unit"]);
    unitFinished.resolve();
    await laterStarted.promise;
    expect((await running).map(({ outcome }) => outcome)).toEqual([
      "FAIL",
      "TIMEOUT",
      "pass",
      "pass",
    ]);
    expect(admissions).toEqual(["changed", "unit", "renderer", "rust"]);
  });
});

it("accepts an explicit ref and gives the timeout flag precedence over the environment", () => {
  expect(
    parseCheckArguments(["feature", "--timeout", "2"], { CHECK_CHANGED_TIMEOUT: "3" }),
  ).toEqual({ ref: "feature", timeoutMs: 2000 });
  expect(parseCheckArguments([], { CHECK_CHANGED_TIMEOUT: "3" }).timeoutMs).toBe(3000);
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

it("summarizes cache reach, top causes, skipped steps, and total time", () => {
  const output = formatSummary({
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
  });
  expect(output).toContain("5/10 hits · 80.0% cacheable · misses: source.ts (3)");
  expect(output).toContain(
    "WARNING: app unit was 80.0% cacheable. untracked file read: generated.json (2)",
  );
  expect(output).toContain("no Rust paths changed");
  expect(output).toContain("Total wall time: 4.00s");
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
