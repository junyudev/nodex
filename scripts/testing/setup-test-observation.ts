import path from "node:path";

const worker = (
  globalThis as typeof globalThis & {
    __vitest_worker__?: {
      filepath?: string;
      ctx: { files: readonly unknown[]; pool: string };
    };
  }
).__vitest_worker__;
const directory = process.env.NODEX_TEST_OBSERVATIONS;
// Vitest's pinned runner sets filepath before setup. Batched non-isolated
// workers can reuse cached builtin references, so they cannot publish evidence.
if (directory && worker?.filepath && worker.ctx.files.length === 1) {
  const require = process.getBuiltinModule("module")!.createRequire(import.meta.url);
  // Use Node's module cache so VM contexts share one set of host-realm hooks.
  const recorder = require("./test-observation.mts") as typeof import("./test-observation.mts");
  recorder.beginTestObservation(
    worker.filepath,
    worker.ctx.pool,
    path.resolve(directory),
    globalThis,
  );
}
