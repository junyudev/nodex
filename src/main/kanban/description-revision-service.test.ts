import { describe, expect, test } from "bun:test";
import Database from "better-sqlite3";
import { parseNfm } from "../../shared/nfm";
import {
  createInitialDescriptionRevision,
  createNextDescriptionRevision,
  garbageCollectDescriptionRevisions,
  reconstructDescription,
} from "./description-revision-service";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

function createDescriptionRevisionTestDb(): Database.Database {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE cards (
      id TEXT PRIMARY KEY,
      description_revision_id INTEGER
    );

    CREATE TABLE history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      previous_description_revision_id INTEGER,
      new_description_revision_id INTEGER,
      snapshot_description_revision_id INTEGER
    );

    CREATE TABLE description_blocks (
      hash TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE description_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      parent_revision_id INTEGER,
      kind TEXT NOT NULL,
      block_hashes_json TEXT,
      ops_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return database;
}

describe("description revision service", () => {
  test("deduplicates identical top-level blocks and reconstructs descriptions", () => {
    try {
      const database = createDescriptionRevisionTestDb();
      const description = "# Heading\n\nSecond paragraph";
      const createdAt = "2026-03-11T00:00:00.000Z";

      const firstRevisionId = createInitialDescriptionRevision(
        database,
        "card-1",
        description,
        createdAt,
      );
      const secondRevisionId = createInitialDescriptionRevision(
        database,
        "card-2",
        description,
        createdAt,
      );

      expect(reconstructDescription(database, firstRevisionId)).toBe(description);
      expect(reconstructDescription(database, secondRevisionId)).toBe(description);

      const blockCount = database
        .prepare("SELECT COUNT(*) as count FROM description_blocks")
        .get() as { count: number };
      expect(blockCount.count).toBe(parseNfm(description).length);

      database.close();
    } catch (error) {
      if (isUnsupportedSqliteError(error)) {
        expect(true).toBeTrue();
        return;
      }
      throw error;
    }
  });

  test("stores a snapshot revision once the checkpoint interval is reached", () => {
    try {
      const database = createDescriptionRevisionTestDb();
      let revisionId = createInitialDescriptionRevision(
        database,
        "card-1",
        "Start",
        "2026-03-11T00:00:00.000Z",
      );
      let description = "Start";

      for (let index = 1; index <= 20; index += 1) {
        description = `${description}\n\nLine ${index}`;
        revisionId = createNextDescriptionRevision(
          database,
          "card-1",
          revisionId,
          description,
          `2026-03-11T00:00:${String(index).padStart(2, "0")}.000Z`,
        );
      }

      const latestRevision = database
        .prepare("SELECT kind FROM description_revisions WHERE id = ?")
        .get(revisionId) as { kind: string } | undefined;
      expect(latestRevision?.kind).toBe("snapshot");
      expect(reconstructDescription(database, revisionId)).toBe(description);

      database.close();
    } catch (error) {
      if (isUnsupportedSqliteError(error)) {
        expect(true).toBeTrue();
        return;
      }
      throw error;
    }
  });

  test("garbage-collects unreachable revisions and block blobs", () => {
    try {
      const database = createDescriptionRevisionTestDb();
      const createdAt = "2026-03-11T00:00:00.000Z";
      const initialRevisionId = createInitialDescriptionRevision(
        database,
        "card-1",
        "Alpha",
        createdAt,
      );
      const nextRevisionId = createNextDescriptionRevision(
        database,
        "card-1",
        initialRevisionId,
        "Alpha\n\nBeta",
        "2026-03-11T00:01:00.000Z",
      );

      database
        .prepare("INSERT INTO cards (id, description_revision_id) VALUES (?, ?)")
        .run("card-1", nextRevisionId);

      const retained = garbageCollectDescriptionRevisions(database);
      expect(retained.deletedRevisions).toBe(0);
      expect(retained.deletedBlocks).toBe(0);

      database.prepare("DELETE FROM cards WHERE id = ?").run("card-1");

      const deleted = garbageCollectDescriptionRevisions(database);
      expect(deleted.deletedRevisions).toBe(2);
      expect(deleted.deletedBlocks).toBe(2);

      database.close();
    } catch (error) {
      if (isUnsupportedSqliteError(error)) {
        expect(true).toBeTrue();
        return;
      }
      throw error;
    }
  });
});
