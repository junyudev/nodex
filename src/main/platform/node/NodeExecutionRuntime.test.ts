/* @effect-diagnostics asyncFunction:off -- Verifies native filesystem artifacts at the Node boundary. */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { nodeRuntimeRelease } from "../../../shared/node-runtime-metadata";
import { agentRuntimeNodeExecutable } from "./AgentRuntimeEntrypoint";
import { resolveNodeExecutionRuntime } from "./NodeExecutionRuntime";
import { resolveBrowserRuntimeBundle } from "../../codex/browser-runtime-bundle";
import {
  makeTestedBrowserAppServerPair,
  writeBrowserRuntimeFixture,
} from "../../codex/browser-runtime-test-fixture";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(architecture: "x64" | "arm64" = "x64") {
  const directory = await mkdtemp(path.join(tmpdir(), "nodex-node-runtime-"));
  roots.push(directory);
  const bytes = Buffer.from("locked executable");
  const artifact = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const release = {
    ...nodeRuntimeRelease,
    builds: { ...nodeRuntimeRelease.builds, [`win32-${architecture}`]: artifact },
  };
  const manifest = {
    schemaVersion: 1,
    targetPlatform: "win32",
    targetArch: architecture,
    version: release.version,
    executable: "node.exe",
    ...artifact,
  };
  await writeFile(path.join(directory, "node.exe"), bytes);
  await writeFile(path.join(directory, "node-runtime.json"), JSON.stringify(manifest));
  return {
    directory,
    release,
    manifest,
    architecture,
    platform: "win32",
    browserRuntime: {
      status: "unavailable" as const,
      reason: "target-mismatch" as const,
      message: "No browser tools",
    },
  };
}
test.each(["x64", "arm64"] as const)(
  "Windows %s execution uses verified Node without browser tooling",
  async (arch) => {
    const input = await fixture(arch);
    const runtime = await resolveNodeExecutionRuntime(input);
    expect(runtime).toEqual({
      status: "available",
      source: "standalone",
      executable: path.join(input.directory, "node.exe"),
      version: input.release.version,
    });
    expect(
      agentRuntimeNodeExecutable({
        isPackaged: true,
        environment: {},
        nodeRuntime: runtime,
      }),
    ).toBe(path.join(input.directory, "node.exe"));
  },
);
test("a changed manifest cannot authorize a different binary", async () => {
  const input = await fixture();
  const bytes = Buffer.from("other executable");
  await writeFile(path.join(input.directory, "node.exe"), bytes);
  await writeFile(
    path.join(input.directory, "node-runtime.json"),
    JSON.stringify({
      ...input.manifest,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  expect(await resolveNodeExecutionRuntime(input)).toMatchObject({
    status: "unavailable",
    message: expect.stringContaining("release lock"),
  });
});
test("rejects wrong targets and same-size binary corruption", async () => {
  const input = await fixture();
  expect(await resolveNodeExecutionRuntime({ ...input, architecture: "arm64" })).toMatchObject({
    status: "unavailable",
  });
  await writeFile(path.join(input.directory, "node.exe"), Buffer.alloc(input.manifest.size));
  expect(await resolveNodeExecutionRuntime(input)).toMatchObject({
    status: "unavailable",
    message: expect.stringContaining("executable differs"),
  });
});
test("missing assets remain unavailable rather than selecting host Node", async () => {
  const input = await fixture();
  await rm(path.join(input.directory, "node-runtime.json"));
  expect(await resolveNodeExecutionRuntime(input)).toMatchObject({ status: "unavailable" });
  const controller = new AbortController();
  controller.abort(new Error("verification cancelled"));
  await expect(
    resolveNodeExecutionRuntime({ ...input, signal: controller.signal }),
  ).rejects.toThrow("verification cancelled");
});

test.runIf(process.platform === "darwin")(
  "macOS Node is projected only from a verified browser bundle",
  async () => {
    const input = await fixture();
    const bundleRoot = path.join(input.directory, "browser-runtime");
    const manifest = writeBrowserRuntimeFixture(bundleRoot);
    const pair = makeTestedBrowserAppServerPair({ bundleRoot, manifest });
    const browserRuntime = await resolveBrowserRuntimeBundle({
      runtimeRoot: input.directory,
      targetArch: "arm64",
      targetPlatform: "darwin",
      appServerIdentity: pair.appServer,
      testedPairs: [pair],
      platformArtifactVerifier: async () => null,
    });
    expect(browserRuntime.status).toBe("available");
    expect(
      await resolveNodeExecutionRuntime({ ...input, platform: "darwin", browserRuntime }),
    ).toEqual({
      status: "available",
      source: "browser-bundle",
      executable: path.join(bundleRoot, manifest.entrypoints.node),
      version: manifest.runtimeVersions.node,
    });
    expect(await resolveNodeExecutionRuntime({ ...input, platform: "darwin" })).toMatchObject({
      status: "unavailable",
    });
  },
);
