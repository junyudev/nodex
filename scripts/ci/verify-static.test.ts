import { describe, expect, test, vi } from "vite-plus/test";

import { STATIC_GROUPS } from "./ci-gate-plan";
import { classifyChangedPaths } from "./classify-change";
import {
  parseStaticArguments,
  runStaticChecks,
  selectStaticChecks,
  STATIC_CHECKS,
} from "./verify-static";

describe("static CI groups", () => {
  test("partition every CI-selectable check exactly once", () => {
    const selected = STATIC_GROUPS.flatMap((group) => selectStaticChecks(STATIC_CHECKS, [group]));
    expect(selected.map(({ id }) => id)).toEqual(STATIC_CHECKS.map(({ id }) => id));
    expect(new Set(selected.map(({ id }) => id)).size).toBe(STATIC_CHECKS.length);
  });

  test("routes the integrated developer check through its cacheable task", () => {
    expect(STATIC_CHECKS.find(({ id }) => id === "integrated-check")?.command).toEqual([
      "run",
      "check",
    ]);
  });

  test("checks WASM freshness for kernel build inputs and generated artifacts", () => {
    for (const path of [
      "crates/nodex-search-kernel/src/text_match.rs",
      "crates/nodex-core-contracts/src/query.rs",
      "crates/nodex-search-kernel/generated/nodex_search_kernel_bg.wasm",
      "Cargo.lock",
      "Cargo.toml",
      ".cargo/config.toml",
      "rust-toolchain.toml",
      "scripts/build-search-kernel-wasm.ts",
    ]) {
      const { staticGroups } = classifyChangedPaths([path]);
      const selected = selectStaticChecks(STATIC_CHECKS, staticGroups);
      expect(
        selected.map(({ id }) => id),
        path,
      ).toContain("search-kernel-wasm");
    }
  });

  test("runs token color validation for renderer and theme changes", async () => {
    for (const path of ["src/renderer/new.tsx", "src/renderer/styles/theme-token-bridge.css"]) {
      const plan = classifyChangedPaths([path]);
      const execute = vi.fn();
      await runStaticChecks(selectStaticChecks(STATIC_CHECKS, plan.staticGroups), execute);
      expect(execute).toHaveBeenCalledWith(
        process.platform === "win32" ? "vp.cmd" : "vp",
        ["run", "verify:token-color-utilities"],
        expect.any(String),
      );
    }
  });

  test("checks compiler coverage when renderer sources, compiler configuration or ratchet inputs change", async () => {
    for (const path of [
      "src/renderer/new.tsx",
      "config/renderer-react-compiler.ts",
      "config/renderer-vite-shared.ts",
      "scripts/ci/react-compiler-ratchet.ts",
      "scripts/ci/react-compiler-baseline.json",
      "scripts/ci/count-ratchet.ts",
      "pnpm-lock.yaml",
    ]) {
      const execute = vi.fn();
      await runStaticChecks(
        selectStaticChecks(STATIC_CHECKS, classifyChangedPaths([path]).staticGroups),
        execute,
      );
      expect(execute, path).toHaveBeenCalledWith(
        process.platform === "win32" ? "vp.cmd" : "vp",
        ["run", "react-compiler:check"],
        expect.any(String),
      );
    }
  });

  test("executes source ownership across independent change routes", async () => {
    for (const path of [
      "packages/landing/auxiliary.mts",
      "packages/landing/tsconfig.json",
      "packages/effect-codex-app-server/scripts/auxiliary.mts",
      "src/renderer/new.tsx",
      "scripts/ci/new.ts",
      "tests/fixtures/new.cts",
      ".github/actions/run-stress-tests/helper.ts",
    ]) {
      const plan = classifyChangedPaths([path]);
      const selected = selectStaticChecks(STATIC_CHECKS, plan.staticGroups);
      const execute = vi.fn();
      await runStaticChecks(selected, execute);
      expect(execute, path).toHaveBeenCalledWith(
        process.platform === "win32" ? "vp.cmd" : "vp",
        ["run", "verify:source-type-ownership"],
        expect.any(String),
      );
      expect(
        selected.filter(({ id }) => id === "source-type-ownership"),
        path,
      ).toHaveLength(1);
    }
  });

  test("parses explicit groups and rejects empty, unknown, or duplicate groups", () => {
    expect(parseStaticArguments([])).toEqual({ groups: null });
    expect(parseStaticArguments(["--group", "types", "--group", "generated"])).toEqual({
      groups: ["types", "generated"],
    });
    expect(() => selectStaticChecks(STATIC_CHECKS, [])).toThrow("At least one");
    expect(() => parseStaticArguments(["--group", "surprise"])).toThrow("Unknown static group");
    expect(() => parseStaticArguments(["--group", "types", "--group", "types"])).toThrow(
      "must not be repeated",
    );
  });

  test("stops after the first failing command", async () => {
    const execute = vi.fn(async (_executable: string, arguments_: readonly string[]) => {
      if (arguments_.includes("lint")) throw new Error("lint failed");
    });
    await expect(
      runStaticChecks(
        [
          { command: ["run", "typecheck"], name: "typecheck" },
          { command: ["run", "lint"], name: "lint" },
          { command: ["run", "build:landing"], name: "landing" },
        ],
        execute,
      ),
    ).rejects.toThrow("lint failed");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
