import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, expect, test } from "vite-plus/test";
import { makeDocumentToolsActivator } from "../../app-components/activation/document-tools";
import { writeAppComponentReceipt } from "../../app-components/AppComponentStore";
import { writeDocumentToolsFixture } from "./document-tools-test-fixture";
import { stageDocumentTools } from "./stage-document-tools";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nodex-document-tools-"));
  roots.push(root);
  return { root, ...writeDocumentToolsFixture(root) };
}

test("staging verifies the pin, exact payload inventory and file integrity", async () => {
  const { root, payload, unpackedBytes, manifest } = fixture();
  const signal = new AbortController().signal;
  await expect(stageDocumentTools(root, payload, signal)).resolves.toBe(unpackedBytes);
  await expect(
    stageDocumentTools(root, { ...payload, manifestSha256: "0".repeat(64) }, signal),
  ).rejects.toThrow("manifest digest mismatch");
  const extra = join(root, "extra.py");
  writeFileSync(extra, "");
  await expect(stageDocumentTools(root, payload, signal)).rejects.toThrow("undeclared files");
  rmSync(extra);
  writeFileSync(join(root, manifest.pythonExecutable), Buffer.alloc(4));
  await expect(stageDocumentTools(root, payload, signal)).rejects.toThrow("integrity mismatch");
});

test.skipIf(process.platform === "win32")(
  "staging rejects an incorrect executable mode",
  async () => {
    const { root, payload, manifest } = fixture();
    chmodSync(join(root, manifest.pythonExecutable), 0o644);
    await expect(stageDocumentTools(root, payload, new AbortController().signal)).rejects.toThrow(
      "Invalid workspace runtime artifact",
    );
  },
);

it.effect("activates only after verifying the published closure and its store receipt", () =>
  Effect.gen(function* () {
    const { root, payload, unpackedBytes } = fixture();
    const activator = yield* makeDocumentToolsActivator({ root, payload });
    assert.isFalse(yield* activator.isActive);
    assert.strictEqual((yield* activator.activate).status, "rejected");
    assert.isFalse(yield* activator.isActive);
    yield* Effect.promise(() => writeAppComponentReceipt(root, unpackedBytes));
    assert.deepEqual(yield* activator.activate, { status: "active" });
    assert.isTrue(yield* activator.isActive);
  }),
);
