import { mkdtemp, mkdir, writeFile, appendFile, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vite-plus/test";
import { readClaudeHistoryRecords } from "./ClaudeHistoryRecords";
const sessionId = "01991e60-b800-7000-8000-000000000012";
const homes: string[] = [];
const line = (id: string, text: string, type = "user") =>
  JSON.stringify({
    type,
    uuid: id,
    sessionId,
    parentUuid: null,
    message: { role: type, content: text },
  }) + "\n";
const fixture = async (text: string) => {
  const home = await mkdtemp(join(tmpdir(), "nodex-native-page-"));
  homes.push(home);
  const directory = join(home, "projects", "actual-native-location");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${sessionId}.jsonl`);
  await writeFile(file, text);
  return { home, file };
};
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
it("preserves byte cursors across native appends and rejects physical replacement", async () => {
  const f = await fixture(line("first", "One") + line("second", "Two"));
  const latest = await readClaudeHistoryRecords({ home: f.home, sessionId, limit: 1 });
  expect(latest.entries.map((entry) => entry.uuid)).toEqual(["second"]);
  expect(latest.hasMore).toBe(true);
  await appendFile(f.file, line("third", "Three"));
  const older = await readClaudeHistoryRecords({
    home: f.home,
    sessionId,
    before: latest.before!,
    limit: 1,
  });
  expect(older.entries.map((entry) => entry.uuid)).toEqual(["first"]);
  expect(older.hasMore).toBe(false);
  await rename(f.file, `${f.file}.old`);
  await writeFile(f.file, line("replacement", "New native file"));
  await expect(
    readClaudeHistoryRecords({ home: f.home, sessionId, before: latest.before!, limit: 1 }),
  ).rejects.toThrow("changed");
});
it("reads a recent page from a large physical transcript without admitting its prefix", async () => {
  const f = await fixture("");
  const file = await open(f.file, "r+");
  try {
    const prefixBytes = 256 * 1024 * 1024;
    await file.truncate(prefixBytes);
    await file.write(
      "\n" +
        Array.from({ length: 100 }, (_, index) => line(`recent:${index}`, `Prompt ${index}`)).join(
          "",
        ),
      prefixBytes,
    );
  } finally {
    await file.close();
  }
  const page = await readClaudeHistoryRecords({ home: f.home, sessionId, limit: 50 });
  expect(page.entries).toHaveLength(50);
  expect(page.entries[0]?.uuid).toBe("recent:50");
  expect(page.entries.at(-1)?.uuid).toBe("recent:99");
  expect(page.hasMore).toBe(true);
  expect(page.bytesRead).toBeLessThanOrEqual(64 * 1024);
});
it("keeps root prompts with continuations and rejects oversized or foreign records", async () => {
  const f = await fixture(
    line("first", "One") +
      line("reply", "Answer", "assistant") +
      line("second", "Two") +
      line("reply2", "Answer two", "assistant"),
  );
  const page = await readClaudeHistoryRecords({ home: f.home, sessionId, limit: 1 });
  expect(page.entries.map((entry) => entry.uuid)).toEqual(["second", "reply2"]);
  const older = await readClaudeHistoryRecords({
    home: f.home,
    sessionId,
    before: page.before!,
    limit: 1,
  });
  expect(older.entries.map((entry) => entry.uuid)).toEqual(["first", "reply"]);
  await writeFile(f.file, line("giant", "x".repeat(32 * 1024 * 1024 + 1)));
  await expect(readClaudeHistoryRecords({ home: f.home, sessionId })).rejects.toThrow("bound");
  await writeFile(
    f.file,
    line("foreign", "Secret").replace(sessionId, "01991e60-b800-7000-8000-000000000099"),
  );
  await expect(readClaudeHistoryRecords({ home: f.home, sessionId })).rejects.toThrow("foreign");
});
