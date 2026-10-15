import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "vite-plus/test";
import { readAgentRuntimeNativeHistory } from "./AgentRuntimeNativeHistory";

const homes: string[] = [];
const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "nodex-native-history-"));
  homes.push(home);
  const history = join(home, "agent-runtime", "native-history");
  const relative = `native-history/${"a".repeat(64)}`;
  const managed = join(home, "agent-runtime", relative);
  await mkdir(managed, { recursive: true, mode: 0o700 });
  const provider = {
    providerInstanceId: "claude:one",
    driver: "claudeAgent",
    relativeHome: relative,
    continuation: "captured",
    requiredThreadCount: 1,
    credentialPolicy: "external",
  };
  const write = (providers: unknown[]) =>
    writeFile(
      join(history, "manifest.json"),
      JSON.stringify({ version: 1, providers, limitations: [] }),
      { mode: 0o600 },
    );
  return { home, history, managed, provider, write };
};
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it("adopts credential-free managed history and keeps shared provider homes shared", async () => {
  const f = await fixture();
  assert.strictEqual((await readAgentRuntimeNativeHistory(f.home)).size, 0);
  await f.write([
    f.provider,
    { ...f.provider, providerInstanceId: "claude:two" },
    {
      ...f.provider,
      providerInstanceId: "acp:one",
      driver: "acpRegistry",
      relativeHome: null,
      continuation: "external",
    },
  ]);
  const adopted = await readAgentRuntimeNativeHistory(f.home);
  assert.deepStrictEqual([...adopted.keys()], ["claude:one", "claude:two"]);
  assert.strictEqual(adopted.get("claude:one")?.homePath, await realpath(f.managed));
  assert.strictEqual(adopted.get("claude:two")?.homePath, await realpath(f.managed));
});

it("rejects foreign, duplicate and oversized manifest admission", async () => {
  const f = await fixture();
  for (const providers of [
    [{ ...f.provider, relativeHome: "../../private-account" }],
    [f.provider, f.provider],
    [{ ...f.provider, driver: "acpRegistry" }],
    [{ ...f.provider, credentialPolicy: "captured" }],
  ]) {
    await f.write(providers);
    await assert.rejects(readAgentRuntimeNativeHistory(f.home));
  }
  await writeFile(join(f.history, "manifest.json"), " ".repeat(1024 * 1024 + 1));
  await assert.rejects(readAgentRuntimeNativeHistory(f.home));
});

it("rejects symlinked manifests and native history directories", async () => {
  const f = await fixture();
  await f.write([f.provider]);
  const manifest = join(f.history, "manifest.json");
  const external = join(f.home, "outside.json");
  await writeFile(external, "{}");
  await rm(manifest);
  await symlink(external, manifest);
  await assert.rejects(readAgentRuntimeNativeHistory(f.home));
  await rm(manifest);
  await f.write([f.provider]);
  await rm(f.managed, { recursive: true });
  await symlink(f.home, f.managed);
  await assert.rejects(readAgentRuntimeNativeHistory(f.home));
});
