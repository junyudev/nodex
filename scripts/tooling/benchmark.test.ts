import { expect, test } from "vite-plus/test";
import { benchmarkCommand, parseBenchmarkArguments, rendererCohort } from "./benchmark";

test("runs exactly the selected cohort with the requested worker budget", () => {
  const options = parseBenchmarkArguments([
    "--scenario",
    "renderer-cohort",
    "--workers",
    "2",
    "--samples",
    "3",
    "--label",
    "before",
  ]);
  expect(options.samples).toBe(3);
  expect(benchmarkCommand(options)).toEqual([
    "test",
    "run",
    "--config",
    "vitest.renderer.config.ts",
    "--maxWorkers",
    "2",
    ...rendererCohort,
  ]);
});

test("semantic measurements execute the checker without task result replay", () => {
  expect(benchmarkCommand(parseBenchmarkArguments(["--scenario", "semantic-execute"]))).toEqual([
    "check",
    "--no-fmt",
  ]);
});

test("rejects ambiguous or invalid measurements", () => {
  for (const args of [
    ["--scenario", "everything"],
    ["--scenario", "tests-warm", "--samples", "0"],
    ["--scenario", "tests-warm", "--workers", "4"],
    ["--scenario", "tests-warm", "--label", "../outside"],
    ["--scenario", "tests-warm", "--samples", "1", "--samples", "2"],
  ])
    expect(() => parseBenchmarkArguments(args)).toThrow();
});
