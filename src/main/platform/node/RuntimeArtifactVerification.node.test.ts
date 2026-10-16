import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  readRuntimeArtifactSha256,
  readRuntimeInspectionCommand,
  verifyRuntimeArtifacts,
} from "./RuntimeArtifactVerification";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const roots: string[] = [];
const temporaryRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nodex-runtime-verification-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("verifies concurrently within a fixed resource budget and preserves manifest order", async () => {
  const gate = deferred();
  const firstWave = deferred();
  let active = 0;
  let peak = 0;
  const pending = verifyRuntimeArtifacts(
    Array.from({ length: 24 }, (_, index) => index),
    async (index) => {
      active++;
      peak = Math.max(peak, active);
      if (active === 8) firstWave.resolve();
      await gate.promise;
      active--;
      return index * 2;
    },
  );
  try {
    await firstWave.promise;
    expect(active).toBe(8);
  } finally {
    gate.resolve();
  }
  expect(await pending).toEqual(Array.from({ length: 24 }, (_, index) => index * 2));
  expect(peak).toBe(8);
  expect(active).toBe(0);
});

test("cancellation stops admission and waits for every in-flight operation", async () => {
  const controller = new AbortController();
  const gate = deferred();
  const firstWave = deferred();
  let started = 0;
  let finished = 0;
  let settled = false;
  const pending = verifyRuntimeArtifacts(
    Array.from({ length: 24 }, (_, index) => index),
    async () => {
      if (++started === 8) firstWave.resolve();
      await gate.promise;
      finished++;
    },
    controller.signal,
  );
  const outcome = pending
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    await firstWave.promise;
    controller.abort(new Error("startup stopped"));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(started).toBe(8);
  } finally {
    gate.resolve();
  }
  expect(await outcome).toBe(controller.signal.reason);
  expect(finished).toBe(8);
  expect(started).toBe(8);
});

test("hashes the complete payload and refuses symlink substitution", async () => {
  const root = await temporaryRoot();
  const artifact = path.join(root, "artifact");
  const payload = Buffer.alloc(3 * 1024 * 1024 + 7, 0x6b);
  await writeFile(artifact, payload);
  expect(await readRuntimeArtifactSha256(artifact)).toBe(
    createHash("sha256").update(payload).digest("hex"),
  );
  const linked = path.join(root, "linked");
  await symlink(artifact, linked);
  await expect(readRuntimeArtifactSha256(linked)).rejects.toThrow();
});

test("cancels a native inspector and joins its exit before rejecting", async () => {
  const root = await temporaryRoot();
  const pidFile = path.join(root, "pid");
  const controller = new AbortController();
  const pending = readRuntimeInspectionCommand(
    process.execPath,
    [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
      pidFile,
    ],
    controller.signal,
  );
  const outcome = pending.catch((error: unknown) => error);
  let pid = 0;
  try {
    await vi.waitFor(async () => {
      pid = Number(await readFile(pidFile, "utf8"));
      expect(pid).toBeGreaterThan(0);
    });
    controller.abort(new Error("startup stopped"));
    expect(await outcome).toBe(controller.signal.reason);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await outcome;
  }
});

test("reports an inspector spawn failure without leaving a pending operation", async () => {
  await expect(readRuntimeInspectionCommand("/nonexistent/nodex-inspector", [])).rejects.toThrow();
});
