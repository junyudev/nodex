import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { CODEX_FEATURE_DEFAULTS, codexFeatureDefaultLaunchArgs } from "./codex-feature-defaults";

const temporaryHomes: string[] = [];
async function createTemporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "nodex-codex-feature-defaults-"));
  temporaryHomes.push(home);
  return home;
}
afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe("Codex feature launch defaults", () => {
  test("supplies supported defaults without creating native configuration", async () => {
    const home = await createTemporaryHome();
    const args = await codexFeatureDefaultLaunchArgs(home);
    expect(args).toEqual(
      Object.keys(CODEX_FEATURE_DEFAULTS).flatMap((feature) => ["-c", `features.${feature}=true`]),
    );
    await expect(stat(join(home, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("preserves explicit choices and all native configuration bytes", async () => {
    const home = await createTemporaryHome();
    const configPath = join(home, "config.toml");
    const source =
      '# User configuration\nmodel = "native-model"\n\n[features]\nunified_exec = false\nprevent_idle_sleep = false\ncustom_feature = true\n';
    await writeFile(configPath, source);
    expect(await codexFeatureDefaultLaunchArgs(home)).toEqual([
      "-c",
      "features.shell_snapshot=true",
      "-c",
      "features.multi_agent=true",
      "-c",
      "features.respect_system_proxy=true",
    ]);
    expect(await readFile(configPath, "utf8")).toBe(source);
  });
  test("normalizes older integer defaults only in the process overrides", async () => {
    const home = await createTemporaryHome();
    const configPath = join(home, "config.toml");
    const source =
      "[features.multi_agent_v2]\nmax_concurrent_threads_per_session = 4.0\nmin_wait_timeout_ms = 10000\n";
    await writeFile(configPath, source);
    const args = await codexFeatureDefaultLaunchArgs(home);
    expect(args).toContain("features.multi_agent_v2.max_concurrent_threads_per_session=4");
    expect(args).toContain("features.multi_agent_v2.min_wait_timeout_ms=10000");
    expect(await readFile(configPath, "utf8")).toBe(source);
  });
  test("rejects malformed native configuration without overwriting it", async () => {
    const home = await createTemporaryHome();
    const configPath = join(home, "config.toml");
    const source = 'features = "invalid"\n';
    await writeFile(configPath, source);
    await expect(codexFeatureDefaultLaunchArgs(home)).rejects.toThrow(
      "Codex config [features] must be a TOML table",
    );
    expect(await readFile(configPath, "utf8")).toBe(source);
  });
});
