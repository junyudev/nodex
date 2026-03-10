---
name: nodex-kanban
description: 'Use when you need to check your task queue, claim a task, update progress, report blockers, or move cards on a kanban board. Triggers on: starting work, finishing work, getting blocked, needing to plan, checking what is next, "update status", "what should I work on", or any task/kanban interaction.'
---

# Nodex Kanban

Kanban board CLI for coding agents. All reads and writes go through the `nodex` command. Output is JSONL by default; use `--json` for JSON object/array, `--csv` for CSV, and `--table` for aligned text. Run `nodex <command> -h` for full flag details.

## Columns

| # | Shorthand | Name | Purpose |
|---|-----------|------|---------|
| 1 | `1` / `ideas` | Ideas | Raw ideas, not yet refined |
| 2 | `2` / `analyzing` | Analyzing | Being researched or scoped |
| 3 | `3` / `backlog` | Backlog | Refined, ready for planning |
| 4 | `4` / `planning` | Planning | Has implementation plan |
| 5 | `5` / `ready` | Ready | Ready for agent pickup |
| 6 | `6` / `in-progress` | In Progress | Currently being worked on |
| 7 | `7` / `review` | Review | Done, awaiting human review |
| 8 | `8` / `done` | Done | Finished |

## Workflows

### Pick Up a Backlog Task to Plan

When a task needs research and planning before implementation:

```bash
# 1. Claim the task (You are most likely in plan-mode when doing this.)
nodex ls backlog --full
nodex mv <id> backlog planning --agent-status "Planning..."

# 2. Do your planning (explore codebase, research, design)
#    Write the plan to a markdown file: plans/<task-slug>.md

# 3. Attach the plan as the card description — reuse the file you already wrote
#    Do this BEFORE calling ExitPlanMode (still in plan mode)
nodex mv <id> planning ready -d @plans/<task-slug>.md

# 4. Call ExitPlanMode to get plan approved

# 5. Begin implementation
nodex mv <id> ready in-progress --agent-status "Implementing..."
```

**Why `@filepath`?** The `-d @plans/file.md` syntax reads the file and sends its contents as the description. This avoids pasting large plan text into the command, saving significant tokens. You already wrote the plan — reuse it, don't repeat it.

### Pick Up a Ready Task to Implement

The `mv` command is atomic: it fails if the card is no longer in `<from>` (i.e. another agent already claimed it). When that happens, re-list and pick a different task.

```bash
nodex ls ready                                              # List ready tasks (JSONL)
nodex mv <id> ready in-progress --agent-status "Starting..."  # Claim + set status
# If this fails with "Card is no longer in the expected column",
# another agent claimed it first — re-run `nodex ls ready` and pick another.
```

### Implementation Workflow

```bash
# Update status periodically so humans see progress
nodex update <id> --agent-status "Running tests..."
nodex update <id> --agent-status "Fixing lint errors..."

# When done, move to review
nodex mv <id> in-progress review --agent-status "Ready for review"
```

### Mark Blocked / Unblock

```bash
nodex update <id> --agent-blocked --agent-status "Blocked: need API credentials"
nodex update <id> --no-agent-blocked --agent-status "Resuming work"
```

### Create a Task

```bash
nodex add backlog "Implement user auth" -P p1-high -e m -t "backend,auth"
nodex add ready "Fix login bug" -P p0-critical -d @./bug-report.md
```

## CLI Quick Reference

| Command | Description |
|---------|-------------|
| `nodex ls [column]` | List cards (optionally filtered by column) |
| `nodex get <id>` | Card details (column auto-resolved) |
| `nodex add <col> <title>` | Create card |
| `nodex update <id> [opts]` | Update card (column auto-resolved) |
| `nodex rm <id>` | Delete card (column auto-resolved) |
| `nodex mv <id> <from> <to> [order] [opts]` | Move card (atomic: fails if not in `<from>`) |
| `nodex history [--card <id>]` | Edit history |
| `nodex undo` / `nodex redo` | Undo/redo last action |
| `nodex query "<sql>" [params]` | Read-only SQL query |
| `nodex projects` | List projects |

## One-Shot Read Patterns

Use these when an agent needs enough context in one command:

```bash
nodex ls ready --full
# Includes full card fields with description truncated to 240 chars,
# plus descriptionLen and descriptionTruncated metadata.

nodex ls ready --full --description-chars 800
# Same as above, with a larger description preview.

nodex ls ready --full --description-full
# Includes full descriptions (no truncation).
```

## Card Fields

| Field | Flag | Description |
|-------|------|-------------|
| title | positional / `--title` | Task name |
| description | `-d` | Markdown details (supports `@filepath`) |
| priority | `-P` | p0-critical, p1-high, p2-medium, p3-low, p4-later |
| estimate | `-e` | xs, s, m, l, xl |
| tags | `-t` | Comma-separated labels |
| assignee | `-a` | Who's working on it |
| agentStatus | `--agent-status` | Current status message (supports `@filepath`) |
| agentBlocked | `--agent-blocked` / `--no-agent-blocked` | Blocked flag |
| dueDate | `--due` | Deadline (YYYY-MM-DD) |

## Tips

- **Save tokens with `@filepath`**: Use `-d @plans/file.md` or `--agent-status @status.txt` instead of pasting content inline. Also works with `@-` for stdin.
- **Column shorthand**: `5`, `ready`, and `5-ready` all work. Use the number for speed.
- **Auto-resolution**: `update`, `rm`, and `get` find the card's column automatically — you only need the card ID. `mv` requires explicit `<from> <to>` for atomic claim safety.
- **Filter `ls`**: Use `--priority`, `--assignee`, `--blocked`, `--limit`, `--offset` to narrow results.
- **Full-card reads**: Use `ls --full` for one-shot agent context. Add `--description-chars <n>` or `--description-full` depending token budget.
- **Output formats**: Default is JSONL. Use `--json` when a command should emit one JSON value, `--csv` for spreadsheets/parsers, and `--table` for human scanning.
- **Config file**: Set `project` and `session_id` in `.nodex/config.toml` to avoid repeating `--project` and `--session-id` flags.
- **SQL escape hatch**: `nodex query "SELECT * FROM cards WHERE title LIKE ?" "%keyword%"` for advanced queries.
