/* @effect-diagnostics asyncFunction:off -- Verifies native filesystem artifacts at the Node boundary. */
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { nodeRuntimeRelease } from "../../../shared/node-runtime-metadata";
import { agentRuntimeNodeExecutable } from "./AgentRuntimeEntrypoint";
import { resolveNodeExecutionRuntime } from "./NodeExecutionRuntime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(
  architecture: "x64" | "arm64" = "x64",
  platform: "darwin" | "win32" = "win32",
) {
  const directory = await mkdtemp(path.join(tmpdir(), "nodex-node-runtime-"));
  roots.push(directory);
  const bytes = Buffer.from("locked executable");
  const artifact = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const executable = platform === "darwin" ? "node" : "node.exe";
  const release = {
    ...nodeRuntimeRelease,
    builds: { ...nodeRuntimeRelease.builds, [`${platform}-${architecture}`]: artifact },
  };
  const manifest = {
    schemaVersion: 1,
    targetPlatform: platform,
    targetArch: architecture,
    version: release.version,
    executable,
    ...artifact,
  };
  await writeFile(path.join(directory, executable), bytes, { mode: 0o755 });
  await writeFile(path.join(directory, "node-runtime.json"), JSON.stringify(manifest));
  return {
    directory,
    release,
    manifest,
    architecture,
    platform,
    executable: path.join(directory, executable),
  };
}
test("Windows x64 execution uses verified Node without browser tooling", async () => {
  const input = await fixture();
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
});
test.each(["darwin", "win32"] as const)(
  "%s manifest cannot authorize a different binary",
  async (platform) => {
    const input = await fixture(platform === "darwin" ? "arm64" : "x64", platform);
    const bytes = Buffer.from("other executable");
    await writeFile(input.executable, bytes);
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
  },
);
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

test.runIf(process.platform !== "win32")(
  "macOS uses standalone Node and requires an executable regular file",
  async () => {
    const input = await fixture("arm64", "darwin");
    expect(await resolveNodeExecutionRuntime(input)).toEqual({
      status: "available",
      source: "standalone",
      executable: input.executable,
      version: input.manifest.version,
    });
    expect(await resolveNodeExecutionRuntime({ ...input, platform: "win32" })).toMatchObject({
      status: "unavailable",
    });
    await chmod(input.executable, 0o644);
    expect(await resolveNodeExecutionRuntime(input)).toMatchObject({ status: "unavailable" });
    const target = path.join(input.directory, "real-node");
    await writeFile(target, "locked executable", { mode: 0o755 });
    await rm(input.executable);
    await symlink(target, input.executable);
    expect(await resolveNodeExecutionRuntime(input)).toMatchObject({ status: "unavailable" });
  },
);
