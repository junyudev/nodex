#!/usr/bin/env python3
"""
Migrate Nodex database from schema v1/v2 (no projects) to v3 (multi-project).

Usage:
    python scripts/migrate-to-v3.py <old-db-path> <new-db-path>
    python scripts/migrate-to-v3.py ~/.nodex/kanban.db ~/.nodex/kanban-v3.db

All existing cards and history are assigned to a "default" project.
"""

import sqlite3
import sys
from datetime import datetime, timezone


def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def migrate(old_path: str, new_path: str):
    if old_path == new_path:
        die("old and new database paths must be different")

    old = sqlite3.connect(old_path)
    old.row_factory = sqlite3.Row

    # Verify old DB has cards table
    tables = {r[0] for r in old.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if "cards" not in tables:
        die(f"no 'cards' table found in {old_path}")

    # Check old DB doesn't already have projects table (already v3)
    if "projects" in tables:
        die(f"{old_path} already has a 'projects' table — looks like v3 already")

    # Create new DB with v3 schema
    new = sqlite3.connect(new_path)
    new.execute("PRAGMA journal_mode = WAL")
    new.execute("PRAGMA foreign_keys = ON")

    new.executescript("""
        CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cards (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            column_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            priority TEXT NOT NULL DEFAULT 'p2-medium',
            estimate TEXT,
            tags TEXT NOT NULL DEFAULT '[]',
            due_date TEXT,
            assignee TEXT,
            agent_blocked INTEGER NOT NULL DEFAULT 0,
            agent_status TEXT,
            created TEXT NOT NULL,
            "order" INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_cards_project_column_order
            ON cards(project_id, column_id, "order");

        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation TEXT NOT NULL,
            card_id TEXT NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            column_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            previous_values TEXT,
            new_values TEXT,
            from_column_id TEXT,
            to_column_id TEXT,
            from_order INTEGER,
            to_order INTEGER,
            card_snapshot TEXT,
            session_id TEXT,
            is_undone INTEGER NOT NULL DEFAULT 0,
            undo_of INTEGER,
            CHECK (operation IN ('create', 'update', 'delete', 'move'))
        );

        CREATE INDEX IF NOT EXISTS idx_history_project ON history(project_id);
        CREATE INDEX IF NOT EXISTS idx_history_card ON history(card_id);
        CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_history_session ON history(session_id);
    """)

    new.execute("INSERT OR REPLACE INTO schema_version (version) VALUES (3)")

    # Seed default project
    now = datetime.now(timezone.utc).isoformat()
    new.execute(
        "INSERT INTO projects (id, name, description, created) VALUES (?, ?, ?, ?)",
        ("default", "Default", "Migrated from v1/v2", now),
    )

    # Migrate cards
    old_cards = old.execute("SELECT * FROM cards").fetchall()
    card_cols = [desc[0] for desc in old.execute(
        "SELECT * FROM cards LIMIT 0").description]

    card_count = 0
    for row in old_cards:
        r = dict(row)
        new.execute(
            """INSERT INTO cards (
                id, project_id, column_id, title, description, priority,
                estimate, tags, due_date, assignee, agent_blocked,
                agent_status, created, "order"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                r["id"],
                "default",
                r["column_id"],
                r["title"],
                r.get("description", ""),
                r.get("priority", "p2-medium"),
                r.get("estimate"),
                r.get("tags", "[]"),
                r.get("due_date"),
                r.get("assignee"),
                r.get("agent_blocked", 0),
                r.get("agent_status"),
                r["created"],
                r["order"],
            ),
        )
        card_count += 1

    # Migrate history (if table exists)
    history_count = 0
    if "history" in tables:
        old_history = old.execute(
            "SELECT * FROM history ORDER BY id").fetchall()
        # Build old->new ID mapping for undo_of references
        old_id_to_new = {}

        for row in old_history:
            r = dict(row)
            old_id = r["id"]

            # Resolve undo_of to new ID
            undo_of = None
            if r.get("undo_of") and r["undo_of"] in old_id_to_new:
                undo_of = old_id_to_new[r["undo_of"]]

            cursor = new.execute(
                """INSERT INTO history (
                    operation, card_id, project_id, column_id, timestamp,
                    previous_values, new_values, from_column_id, to_column_id,
                    from_order, to_order, card_snapshot, session_id,
                    is_undone, undo_of
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    r["operation"],
                    r["card_id"],
                    "default",
                    r["column_id"],
                    r["timestamp"],
                    r.get("previous_values"),
                    r.get("new_values"),
                    r.get("from_column_id"),
                    r.get("to_column_id"),
                    r.get("from_order"),
                    r.get("to_order"),
                    r.get("card_snapshot"),
                    r.get("session_id"),
                    r.get("is_undone", 0),
                    undo_of,
                ),
            )
            old_id_to_new[old_id] = cursor.lastrowid
            history_count += 1

    new.commit()
    old.close()
    new.close()

    print(f"Migration complete: {old_path} -> {new_path}")
    print(f"  Project: default")
    print(f"  Cards:   {card_count}")
    print(f"  History: {history_count}")
    print()
    print(f"To use: mv {new_path} {old_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__.strip())
        sys.exit(1)

    migrate(sys.argv[1], sys.argv[2])
