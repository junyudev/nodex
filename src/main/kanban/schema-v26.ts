import Database from "better-sqlite3";
import { rewriteCardDeepLinksInText } from "../../shared/card-deeplink";
import { escapeXmlAttr, getXmlAttr } from "../../shared/nfm/xml-attributes";

type TextRewriter = (value: string | null) => string | null;

function decodeBase64Utf8(value: string): string | null {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function encodeBase64Utf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function rewriteStructuredText(value: string): string {
  const withRewrittenSnapshots = value.replace(/<card-toggle(?:\s+([^>]*))?\s*>/g, (match, attrs = "") => {
    const snapshot = getXmlAttr(attrs, "snapshot");
    if (!snapshot) return match;

    const decoded = decodeBase64Utf8(snapshot);
    if (!decoded) return match;

    const rewrittenSnapshot = rewriteJsonText(decoded);
    if (!rewrittenSnapshot || rewrittenSnapshot === decoded) {
      return match;
    }

    return match.replace(
      /snapshot="([^"]*)"/,
      `snapshot="${escapeXmlAttr(encodeBase64Utf8(rewrittenSnapshot))}"`,
    );
  });

  return rewriteCardDeepLinksInText(withRewrittenSnapshots);
}

function rewriteJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return rewriteStructuredText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => rewriteJsonValue(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const rewritten: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    rewritten[key] = rewriteJsonValue(entry);
  }
  return rewritten;
}

function rewriteJsonText(value: string | null): string | null {
  if (!value) return value;

  try {
    const parsed = JSON.parse(value) as unknown;
    return JSON.stringify(rewriteJsonValue(parsed));
  } catch {
    return rewriteStructuredText(value);
  }
}

function rewritePlainText(value: string | null): string | null {
  if (!value) return value;
  return rewriteStructuredText(value);
}

function rewriteTableTextColumns(
  db: Database.Database,
  options: {
    tableName: string;
    keyColumns: string[];
    columnRewriters: Record<string, TextRewriter>;
  },
): void {
  const textColumns = Object.keys(options.columnRewriters);
  if (textColumns.length === 0) return;

  const selectColumns = [...options.keyColumns, ...textColumns].join(", ");
  const rows = db.prepare(`SELECT ${selectColumns} FROM ${options.tableName}`).all() as Array<Record<string, unknown>>;
  const setClause = textColumns.map((column) => `${column} = ?`).join(", ");
  const whereClause = options.keyColumns.map((column) => `${column} = ?`).join(" AND ");
  const updateStatement = db.prepare(`UPDATE ${options.tableName} SET ${setClause} WHERE ${whereClause}`);

  for (const row of rows) {
    let changed = false;
    const nextValues = textColumns.map((column) => {
      const currentValue = typeof row[column] === "string" ? row[column] : row[column] === null ? null : null;
      const nextValue = options.columnRewriters[column]?.(currentValue) ?? currentValue;
      if (nextValue !== currentValue) {
        changed = true;
      }
      return nextValue;
    });

    if (!changed) continue;

    const keyValues = options.keyColumns.map((column) => row[column]);
    updateStatement.run(...nextValues, ...keyValues);
  }
}

export function migrateV25ToV26(db: Database.Database): void {
  db.transaction(() => {
    rewriteTableTextColumns(db, {
      tableName: "projects",
      keyColumns: ["id"],
      columnRewriters: {
        description: rewritePlainText,
      },
    });

    rewriteTableTextColumns(db, {
      tableName: "cards",
      keyColumns: ["id"],
      columnRewriters: {
        title: rewritePlainText,
        description: rewritePlainText,
      },
    });

    rewriteTableTextColumns(db, {
      tableName: "description_blocks",
      keyColumns: ["hash"],
      columnRewriters: {
        content: rewritePlainText,
      },
    });

    rewriteTableTextColumns(db, {
      tableName: "history",
      keyColumns: ["id"],
      columnRewriters: {
        previous_values: rewriteJsonText,
        new_values: rewriteJsonText,
        card_snapshot: rewriteJsonText,
      },
    });

    rewriteTableTextColumns(db, {
      tableName: "codex_card_threads",
      keyColumns: ["thread_id"],
      columnRewriters: {
        thread_name: rewritePlainText,
        thread_preview: rewritePlainText,
      },
    });

    rewriteTableTextColumns(db, {
      tableName: "codex_thread_snapshots",
      keyColumns: ["thread_id"],
      columnRewriters: {
        turns_json: rewriteJsonText,
        items_json: rewriteJsonText,
      },
    });

    rewriteTableTextColumns(db, {
      tableName: "canvas",
      keyColumns: ["project_id"],
      columnRewriters: {
        elements: rewriteJsonText,
        app_state: rewriteJsonText,
        files: rewriteJsonText,
      },
    });

    db.pragma("user_version = 26");
  })();
}
