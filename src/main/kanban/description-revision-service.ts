import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { parseNfm, serializeNfm } from "../../shared/nfm";

interface DescriptionRevisionRow {
  id: number;
  card_id: string;
  parent_revision_id: number | null;
  kind: "snapshot" | "delta";
  block_hashes_json: string | null;
  ops_json: string | null;
  created_at: string;
}

interface DescriptionBlockRow {
  hash: string;
  content: string;
}

export interface DescriptionDeltaOp {
  startOrdinal: number;
  deleteCount: number;
  insertedHashes: string[];
}

const SNAPSHOT_INTERVAL = 20;

export function createInitialDescriptionRevision(
  database: Database.Database,
  cardId: string,
  description: string,
  createdAt: string,
): number {
  const snapshotHashes = upsertDescriptionBlocks(database, description);
  const result = database.prepare(`
    INSERT INTO description_revisions (
      card_id, parent_revision_id, kind, block_hashes_json, ops_json, created_at
    ) VALUES (?, NULL, 'snapshot', ?, NULL, ?)
  `).run(cardId, JSON.stringify(snapshotHashes), createdAt);
  return result.lastInsertRowid as number;
}

export function createNextDescriptionRevision(
  database: Database.Database,
  cardId: string,
  parentRevisionId: number,
  nextDescription: string,
  createdAt: string,
): number {
  const parentHashes = reconstructRevisionHashes(database, parentRevisionId);
  const nextHashes = upsertDescriptionBlocks(database, nextDescription);
  const ops = computeDescriptionDeltaOps(parentHashes, nextHashes);
  const deltaPayload = JSON.stringify(ops);
  const snapshotPayload = JSON.stringify(nextHashes);
  const revisionsSinceSnapshot = countRevisionsSinceSnapshot(database, parentRevisionId);

  if (
    revisionsSinceSnapshot >= SNAPSHOT_INTERVAL - 1
    || deltaPayload.length >= snapshotPayload.length
  ) {
    const result = database.prepare(`
      INSERT INTO description_revisions (
        card_id, parent_revision_id, kind, block_hashes_json, ops_json, created_at
      ) VALUES (?, ?, 'snapshot', ?, NULL, ?)
    `).run(cardId, parentRevisionId, snapshotPayload, createdAt);
    return result.lastInsertRowid as number;
  }

  const result = database.prepare(`
    INSERT INTO description_revisions (
      card_id, parent_revision_id, kind, block_hashes_json, ops_json, created_at
    ) VALUES (?, ?, 'delta', NULL, ?, ?)
  `).run(cardId, parentRevisionId, deltaPayload, createdAt);
  return result.lastInsertRowid as number;
}

export function reconstructDescription(
  database: Database.Database,
  revisionId: number | null,
): string {
  if (!revisionId) return "";
  const hashes = reconstructRevisionHashes(database, revisionId);
  if (hashes.length === 0) return "";

  const placeholders = hashes.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT hash, content
    FROM description_blocks
    WHERE hash IN (${placeholders})
  `).all(...hashes) as DescriptionBlockRow[];
  const byHash = new Map(rows.map((row) => [row.hash, row.content]));
  const blocks = hashes.map((hash) => byHash.get(hash) ?? "");
  return blocks.join("\n");
}

export function collectReachableRevisionIds(database: Database.Database): Set<number> {
  const roots = new Set<number>();
  const cardRows = database.prepare(`
    SELECT description_revision_id
    FROM cards
    WHERE description_revision_id IS NOT NULL
  `).all() as Array<{ description_revision_id: number | null }>;
  for (const row of cardRows) {
    if (typeof row.description_revision_id === "number") {
      roots.add(row.description_revision_id);
    }
  }

  const historyRows = database.prepare(`
    SELECT previous_description_revision_id, new_description_revision_id, snapshot_description_revision_id
    FROM history
  `).all() as Array<{
    previous_description_revision_id: number | null;
    new_description_revision_id: number | null;
    snapshot_description_revision_id: number | null;
  }>;
  for (const row of historyRows) {
    for (const candidate of [
      row.previous_description_revision_id,
      row.new_description_revision_id,
      row.snapshot_description_revision_id,
    ]) {
      if (typeof candidate === "number") {
        roots.add(candidate);
      }
    }
  }

  const reachable = new Set<number>();
  const queue = [...roots];
  while (queue.length > 0) {
    const revisionId = queue.pop();
    if (revisionId === undefined || reachable.has(revisionId)) continue;
    reachable.add(revisionId);
    const row = readRevision(database, revisionId);
    if (row?.parent_revision_id) {
      queue.push(row.parent_revision_id);
    }
  }

  return reachable;
}

export function garbageCollectDescriptionRevisions(database: Database.Database): {
  deletedRevisions: number;
  deletedBlocks: number;
} {
  const reachable = collectReachableRevisionIds(database);
  const revisionRows = database.prepare(`
    SELECT id
    FROM description_revisions
  `).all() as Array<{ id: number }>;
  let deletedRevisions = 0;
  for (const row of revisionRows) {
    if (reachable.has(row.id)) continue;
    deletedRevisions += database.prepare(`
      DELETE FROM description_revisions
      WHERE id = ?
    `).run(row.id).changes;
  }

  const usedHashes = new Set<string>();
  const remainingRows = database.prepare(`
    SELECT kind, block_hashes_json, ops_json
    FROM description_revisions
  `).all() as Array<{
    kind: "snapshot" | "delta";
    block_hashes_json: string | null;
    ops_json: string | null;
  }>;
  for (const row of remainingRows) {
    if (row.kind === "snapshot") {
      for (const hash of safeParseHashes(row.block_hashes_json)) {
        usedHashes.add(hash);
      }
      continue;
    }
    for (const op of safeParseOps(row.ops_json)) {
      for (const hash of op.insertedHashes) {
        usedHashes.add(hash);
      }
    }
  }

  const blockRows = database.prepare(`
    SELECT hash
    FROM description_blocks
  `).all() as Array<{ hash: string }>;
  let deletedBlocks = 0;
  for (const row of blockRows) {
    if (usedHashes.has(row.hash)) continue;
    deletedBlocks += database.prepare(`
      DELETE FROM description_blocks
      WHERE hash = ?
    `).run(row.hash).changes;
  }

  return { deletedRevisions, deletedBlocks };
}

export function seedCardDescriptionRevisions(database: Database.Database): void {
  const cards = database.prepare(`
    SELECT id, description, created
    FROM cards
    ORDER BY created ASC, id ASC
  `).all() as Array<{ id: string; description: string; created: string }>;

  for (const card of cards) {
    const revisionId = createInitialDescriptionRevision(
      database,
      card.id,
      card.description,
      card.created,
    );
    database.prepare(`
      UPDATE cards
      SET description_revision_id = ?
      WHERE id = ?
    `).run(revisionId, card.id);
  }
}

function reconstructRevisionHashes(
  database: Database.Database,
  revisionId: number,
  cache = new Map<number, string[]>(),
): string[] {
  const cached = cache.get(revisionId);
  if (cached) return [...cached];

  const row = readRevision(database, revisionId);
  if (!row) return [];

  let hashes: string[];
  if (row.kind === "snapshot") {
    hashes = safeParseHashes(row.block_hashes_json);
  } else {
    const parentHashes = row.parent_revision_id
      ? reconstructRevisionHashes(database, row.parent_revision_id, cache)
      : [];
    hashes = applyDescriptionDeltaOps(parentHashes, safeParseOps(row.ops_json));
  }

  cache.set(revisionId, [...hashes]);
  return hashes;
}

function readRevision(
  database: Database.Database,
  revisionId: number,
): DescriptionRevisionRow | null {
  const row = database.prepare(`
    SELECT *
    FROM description_revisions
    WHERE id = ?
  `).get(revisionId) as DescriptionRevisionRow | undefined;
  return row ?? null;
}

function upsertDescriptionBlocks(
  database: Database.Database,
  description: string,
): string[] {
  const blocks = parseNfm(description);
  const hashes: string[] = [];
  const insert = database.prepare(`
    INSERT OR IGNORE INTO description_blocks (hash, content, created_at)
    VALUES (?, ?, ?)
  `);
  const now = new Date().toISOString();

  for (const block of blocks) {
    const content = serializeNfm([block]);
    const hash = createHash("sha256").update(content).digest("hex");
    insert.run(hash, content, now);
    hashes.push(hash);
  }

  return hashes;
}

function countRevisionsSinceSnapshot(
  database: Database.Database,
  revisionId: number,
): number {
  let distance = 0;
  let current = readRevision(database, revisionId);
  while (current && current.kind !== "snapshot") {
    distance += 1;
    if (!current.parent_revision_id) return distance;
    current = readRevision(database, current.parent_revision_id);
  }
  return distance;
}

function computeDescriptionDeltaOps(
  previousHashes: string[],
  nextHashes: string[],
): DescriptionDeltaOp[] {
  const lcs = longestCommonSubsequence(previousHashes, nextHashes);
  const ops: DescriptionDeltaOp[] = [];
  let prevIndex = 0;
  let nextIndex = 0;
  let cursor = 0;

  for (const common of [...lcs, "__END__"]) {
    const prevBoundary = common === "__END__"
      ? previousHashes.length
      : previousHashes.indexOf(common, prevIndex);
    const nextBoundary = common === "__END__"
      ? nextHashes.length
      : nextHashes.indexOf(common, nextIndex);

    const deleteCount = prevBoundary - prevIndex;
    const insertedHashes = nextHashes.slice(nextIndex, nextBoundary);
    if (deleteCount > 0 || insertedHashes.length > 0) {
      ops.push({ startOrdinal: cursor, deleteCount, insertedHashes });
      cursor += insertedHashes.length;
    }

    if (common !== "__END__") {
      cursor += 1;
      prevIndex = prevBoundary + 1;
      nextIndex = nextBoundary + 1;
    }
  }

  return ops;
}

function longestCommonSubsequence(
  left: string[],
  right: string[],
): string[] {
  const table = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0)
  );

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const sequence: string[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      sequence.push(left[i]);
      i += 1;
      j += 1;
      continue;
    }
    if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return sequence;
}

function applyDescriptionDeltaOps(
  baseHashes: string[],
  ops: DescriptionDeltaOp[],
): string[] {
  const next = [...baseHashes];
  for (const op of ops) {
    next.splice(op.startOrdinal, op.deleteCount, ...op.insertedHashes);
  }
  return next;
}

function safeParseHashes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function safeParseOps(raw: string | null): DescriptionDeltaOp[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (
        typeof item !== "object"
        || item === null
        || typeof (item as { startOrdinal?: unknown }).startOrdinal !== "number"
        || typeof (item as { deleteCount?: unknown }).deleteCount !== "number"
        || !Array.isArray((item as { insertedHashes?: unknown }).insertedHashes)
      ) {
        return [];
      }
      return [{
        startOrdinal: Math.max(0, Math.trunc((item as { startOrdinal: number }).startOrdinal)),
        deleteCount: Math.max(0, Math.trunc((item as { deleteCount: number }).deleteCount)),
        insertedHashes: (item as { insertedHashes: unknown[] }).insertedHashes
          .filter((value): value is string => typeof value === "string"),
      }];
    });
  } catch {
    return [];
  }
}
