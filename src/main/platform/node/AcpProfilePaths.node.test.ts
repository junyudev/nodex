import { afterEach, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpNativeStorageScope } from "./AcpProfilePaths";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("recognizes physical profile aliases and excludes token values from native storage identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodex-acp-profile-"));
  roots.push(root);
  const physical = join(root, "physical");
  await mkdir(physical);
  await symlink(physical, join(root, "alias"));
  const scope = (home: string, secret: string) =>
    acpNativeStorageScope([
      { name: "HOME", value: home, sensitive: false },
      { name: "XDG_CONFIG_HOME", value: join(home, ".config"), sensitive: false },
      { name: "API_KEY", value: secret, sensitive: true },
    ]);
  expect(await scope(physical, "old-token")).toBe(await scope(join(root, "alias"), "new-token"));
  expect(await scope(physical, "old-token")).not.toBe(
    await scope(join(root, "another"), "old-token"),
  );
});
