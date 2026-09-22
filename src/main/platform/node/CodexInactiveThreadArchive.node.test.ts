/* oxlint-disable effecttsgo/async-function -- These Node boundary tests exercise real disposable files and native SQLite state. */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vite-plus/test";
import { archiveInactiveCodexThread } from "./CodexInactiveThreadArchive";

const homes: string[] = [];
const createHome = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nodex-inactive-archive-"));
  homes.push(home);
  return home;
};
const createIndex = (home: string, rollout: string, archived = 0) => {
  const database = new DatabaseSync(path.join(home, "state_5.sqlite"));
  database.exec(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER, archived_at INTEGER, rollout_path TEXT)",
  );
  database.prepare("INSERT INTO threads VALUES (?, ?, NULL, ?)").run("thread-a", archived, rollout);
  return database;
};

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

for (const missingRollout of [false, true]) {
  test(`archives the native index and rollout when rollout is ${missingRollout ? "missing" : "present"}`, async () => {
    const home = await createHome();
    const source = path.join(home, "sessions", "2026", "rollout-a.jsonl");
    const destination = path.join(home, "archived_sessions", "rollout-a.jsonl");
    await mkdir(path.dirname(source), { recursive: true });
    if (!missingRollout) await writeFile(source, "rollout content");
    const database = createIndex(home, source);
    try {
      expect(await archiveInactiveCodexThread({ codexHome: home, threadId: "thread-a" })).toBe(
        "archived",
      );
      expect(database.prepare("SELECT archived, rollout_path FROM threads").get()).toMatchObject({
        archived: 1,
        rollout_path: destination,
      });
      expect(
        database.prepare("SELECT archived_at FROM threads").get()?.archived_at,
      ).toBeGreaterThan(0);
      if (!missingRollout) {
        expect(await readFile(destination, "utf8")).toBe("rollout content");
        await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      database.close();
    }
  });
}

test("retains an already archived rollout path without moving it", async () => {
  const home = await createHome();
  const rollout = path.join(home, "archived_sessions", "nested", "rollout-a.jsonl");
  await mkdir(path.dirname(rollout), { recursive: true });
  await writeFile(rollout, "existing");
  const database = createIndex(home, rollout);
  try {
    expect(await archiveInactiveCodexThread({ codexHome: home, threadId: "thread-a" })).toBe(
      "archived",
    );
    expect(database.prepare("SELECT rollout_path FROM threads").get()?.rollout_path).toBe(rollout);
    expect(await readFile(rollout, "utf8")).toBe("existing");
  } finally {
    database.close();
  }
});

test("accepts an archived index row without requiring its rollout", async () => {
  const home = await createHome();
  const database = createIndex(home, "/unavailable/rollout.jsonl", 1);
  try {
    expect(await archiveInactiveCodexThread({ codexHome: home, threadId: "thread-a" })).toBe(
      "archived",
    );
    expect(database.prepare("SELECT archived_at FROM threads").get()?.archived_at).toBeNull();
  } finally {
    database.close();
  }
});

test("rejects paths outside the native session directories without changing the index", async () => {
  const home = await createHome();
  const rollout = path.join(home, "sessions-neighbor", "rollout-a.jsonl");
  const database = createIndex(home, rollout);
  try {
    expect(await archiveInactiveCodexThread({ codexHome: home, threadId: "thread-a" })).toBe(
      "unrecoverable",
    );
    expect(database.prepare("SELECT archived, rollout_path FROM threads").get()).toMatchObject({
      archived: 0,
      rollout_path: rollout,
    });
  } finally {
    database.close();
  }
});

test("reports missing identities without creating a database", async () => {
  const home = await createHome();
  expect(await archiveInactiveCodexThread({ codexHome: home, threadId: "thread-a" })).toBe(
    "missing",
  );
  await expect(stat(path.join(home, "state_5.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  const database = createIndex(home, path.join(home, "sessions", "rollout.jsonl"));
  try {
    expect(await archiveInactiveCodexThread({ codexHome: home, threadId: "absent" })).toBe(
      "missing",
    );
    expect(database.prepare("SELECT archived FROM threads").get()?.archived).toBe(0);
  } finally {
    database.close();
  }
});

test("propagates an index write failure instead of reporting archive success", async () => {
  const home = await createHome();
  const database = createIndex(home, path.join(home, "sessions", "rollout.jsonl"));
  database.exec(
    "CREATE TRIGGER deny_archive BEFORE UPDATE ON threads BEGIN SELECT RAISE(ABORT, 'archive write denied'); END",
  );
  try {
    await expect(
      archiveInactiveCodexThread({ codexHome: home, threadId: "thread-a" }),
    ).rejects.toThrow("archive write denied");
    expect(database.prepare("SELECT archived FROM threads").get()?.archived).toBe(0);
  } finally {
    database.close();
  }
});
