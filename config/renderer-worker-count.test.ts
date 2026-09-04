import { expect, test } from "vite-plus/test";
import { rendererWorkerCount } from "./renderer-worker-count";

test.each([
  { ci: true, parallelism: 4, gib: 16, expected: 4 },
  { ci: false, parallelism: 14, gib: 36, expected: 4 },
  { ci: false, parallelism: 14, gib: 16, expected: 2 },
  { ci: false, parallelism: 4, gib: 36, expected: 2 },
  { ci: true, parallelism: 1, gib: 16, expected: 1 },
])(
  "bounds workers for CI=$ci, $parallelism CPUs and $gib GiB",
  ({ ci, parallelism, gib, expected }) => {
    const input = { ci, parallelism, memoryBytes: gib * 1024 ** 3 };
    expect(rendererWorkerCount({ ...input, stress: false })).toBe(expected);
    expect(rendererWorkerCount({ ...input, stress: true })).toBe(1);
  },
);
