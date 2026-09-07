/* oxlint-disable effecttsgo/async-function -- This Node boundary test exercises actual file and symlink identity. */
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { resolveWorkbenchFileTarget } from "./WorkbenchFileTarget";

test("resolves against the task cwd and checks real filesystem containment before opening", async () => {
  const home = await mkdtemp(join(tmpdir(), "nodex-file-target-"));
  try {
    const root = join(home, "workspace");
    await mkdir(root);
    await writeFile(join(root, "inside.ts"), "export const value = 1;");
    await writeFile(join(home, "outside.txt"), "outside");
    await symlink(join(home, "outside.txt"), join(root, "escape"));
    const base = { cwd: root, roots: [root], fullAccess: false };
    expect(await resolveWorkbenchFileTarget({ ...base, path: "inside.ts" })).toEqual({
      path: await realpath(join(root, "inside.ts")),
      workspaceRoot: await realpath(root),
    });
    expect(await resolveWorkbenchFileTarget({ ...base, path: "escape" })).toBeNull();
    expect(await resolveWorkbenchFileTarget({ ...base, path: "../outside.txt" })).toBeNull();
    expect(await resolveWorkbenchFileTarget({ ...base, path: "missing" })).toBeNull();
    expect(await resolveWorkbenchFileTarget({ ...base, cwd: null, path: "inside.ts" })).toBeNull();
    expect(await resolveWorkbenchFileTarget({ ...base, fullAccess: true, path: "escape" })).toEqual(
      { path: await realpath(join(home, "outside.txt")), workspaceRoot: await realpath(home) },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
