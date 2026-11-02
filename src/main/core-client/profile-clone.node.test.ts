import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { requiredNativeExecutable } from "../../../scripts/testing/native-artifacts";
import { parseProfileExecutionSnapshot } from "../../../scripts/profile-execution-snapshot";

const exec = promisify(execFile);
const python = process.platform === "win32" ? "python" : "python3";

// Execution schema and pressure are the subject here; Core content uses public operations.
const writerProgram = `
import json, pathlib, sqlite3, sys, time
home = pathlib.Path(sys.argv[1])
db = sqlite3.connect(home / 'agent-runtime.sqlite')
db.executescript('PRAGMA journal_mode=WAL; CREATE TABLE watermark(value INTEGER); INSERT INTO watermark VALUES(0); CREATE TABLE history(id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO history VALUES(1,0),(2,0); CREATE TABLE payload(body BLOB); INSERT INTO payload VALUES(zeroblob(33554432)); CREATE TABLE runs(state TEXT); INSERT INTO runs VALUES("running");')
(home / 'ready').write_text('ready')
while not (home / 'stop').exists():
    with db:
        db.execute('UPDATE watermark SET value=value+1')
        db.execute('UPDATE history SET value=(SELECT value FROM watermark)')
    time.sleep(0.001)
db.close()
`;
const readDatabase = async (path: string) => {
  const { stdout } = await exec(python, [
    "-c",
    `
import json, sqlite3, sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps({'integrity':c.execute('PRAGMA integrity_check').fetchone()[0], 'sequence':c.execute('SELECT value FROM watermark').fetchone()[0], 'values':[r[0] for r in c.execute('SELECT value FROM history ORDER BY id')]}))
`,
    path,
  ]);
  return JSON.parse(stdout) as { integrity: string; sequence: number; values: number[] };
};

const clone = async (source: string, target: string) => {
  const { stdout } = await exec(
    requiredNativeExecutable("cli"),
    ["--json", "profile", "clone", "--from", source, "--to", target],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout).result;
};

test("clones online execution while its owner keeps writing, without reading provider homes", async () => {
  await withCoreScenario({ scenarioId: "nfm-code-block-actions" }, async ({ client, profile }) => {
    await client.administrationApply({
      operationId: randomUUID(),
      intent: {
        kind: "create_backup",
        label: "Clone source",
        include_assets: true,
        trigger: "manual",
      },
    });
    const execution = join(profile.nodexHome, "agent-runtime");
    await mkdir(join(execution, "userdata/attachments/images"), { recursive: true });
    await mkdir(join(execution, ".writer.lock"));
    await writeFile(join(execution, "userdata/environment-id"), "runtime:test\n");
    await writeFile(join(execution, "userdata/attachments/images/a.png"), "immutable image");
    await writeFile(join(execution, "provider-catalog.json"), "unreadable provider catalog");
    await rm(profile.codexHome, { recursive: true, force: true });
    await symlink(
      join(profile.runRoot, "missing-native-provider-home"),
      profile.codexHome,
      process.platform === "win32" ? "junction" : "dir",
    );
    const writing = exec(python, ["-u", "-c", writerProgram, execution], { timeout: 45_000 });
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (
          await stat(join(execution, "ready")).then(
            () => true,
            () => false,
          )
        )
          break;
        await setTimeout(10);
      }
      const sourceDatabase = join(execution, "agent-runtime.sqlite");
      const before = await readDatabase(sourceDatabase);
      const target = join(profile.runRoot, "cloned-profile");
      const receipt = await clone(profile.nodexHome, target);
      const after = await readDatabase(sourceDatabase);
      expect(after.sequence).toBeGreaterThan(before.sequence);
      const captured = await readDatabase(join(target, "agent-runtime/agent-runtime.sqlite"));
      expect(captured.integrity).toBe("ok");
      expect(captured.sequence).toBeGreaterThanOrEqual(before.sequence);
      expect(captured.sequence).toBeLessThanOrEqual(after.sequence);
      expect(captured.values).toEqual([captured.sequence, captured.sequence]);
      const evidence = parseProfileExecutionSnapshot(receipt.execution)!;
      expect(evidence.databaseBytes).toBe(
        (await stat(join(target, "agent-runtime/agent-runtime.sqlite"))).size,
      );
      expect(evidence.attachmentFiles).toBe(1);
      expect(evidence.attachmentBytes).toBe(Buffer.byteLength("immutable image"));
      expect(
        await readFile(join(target, "agent-runtime/userdata/attachments/images/a.png"), "utf8"),
      ).toBe("immutable image");
      expect(await readFile(join(target, "agent-runtime/userdata/environment-id"), "utf8")).toBe(
        "runtime:test\n",
      );
      const marker = JSON.parse(
        await readFile(join(target, "agent-runtime/imported-execution.json"), "utf8"),
      );
      expect(marker).toEqual({
        version: 1,
        sourceProfileHome: toNamespacedPath(profile.nodexHome),
        importedAt: expect.any(String),
      });
      expect(Number.isFinite(Date.parse(marker.importedAt))).toBe(true);
      const published = JSON.parse(await readFile(join(target, "profile-snapshot.json"), "utf8"));
      expect(published.execution).toEqual(receipt.execution);
      await expect(stat(join(target, "agent"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(target, "agent-runtime/provider-catalog.json"))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    } finally {
      await writeFile(join(execution, "stop"), "stop");
      await writing;
    }
  });
}, 60_000);

test("clones content when the source has never opened an execution store", async () => {
  await withCoreScenario({ scenarioId: "nfm-code-block-actions" }, async ({ client, profile }) => {
    await client.administrationApply({
      operationId: randomUUID(),
      intent: { kind: "create_backup", label: null, include_assets: true, trigger: "manual" },
    });
    const target = join(profile.runRoot, "content-profile");
    expect((await clone(profile.nodexHome, target)).execution).toBeNull();
    await expect(stat(join(target, "agent-runtime/imported-execution.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
});
